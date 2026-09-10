import { createServer, type Server } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { BrowserSurface } from "./surface.js";
import type { InterventionRequest } from "./types.js";
import type { RunLogger } from "./logger.js";

interface HandoffContext {
  runId: string;
  capabilityId?: string;
  goal?: string;
  stepId?: string;
  reason: string;
  screenshotPath: string;
  evidenceDirectory: string;
}

export interface HandoffResult {
  interventionId: string;
  resumed: boolean;
  operatorUrl?: string;
}

export class HandoffCoordinator {
  constructor(
    private readonly logger: RunLogger,
    private readonly interactive: boolean,
    private readonly timeoutMs = 10 * 60_000
  ) {}

  async request(surface: BrowserSurface, context: HandoffContext): Promise<HandoffResult> {
    const interventionId = `int-${crypto.randomUUID()}`;
    const request: InterventionRequest = {
      id: interventionId,
      runId: context.runId,
      ...(context.capabilityId === undefined ? {} : { capabilityId: context.capabilityId }),
      ...(context.goal === undefined ? {} : { goal: context.goal }),
      ...(context.stepId === undefined ? {} : { stepId: context.stepId }),
      reason: context.reason,
      screenshotPath: context.screenshotPath,
      observedUrl: surface.currentUrl(),
      control: "human",
      requestedAt: new Date().toISOString()
    };
    await mkdir(context.evidenceDirectory, { recursive: true });
    await writeFile(
      join(context.evidenceDirectory, `${interventionId}.json`),
      `${JSON.stringify(this.logger.redact(request), null, 2)}\n`,
      "utf8"
    );
    await this.logger.log("handoff", "control_transferred", {
      interventionId,
      owner: "human",
      reason: context.reason,
      screenshotPath: context.screenshotPath
    }, context.stepId);

    if (!this.interactive) return { interventionId, resumed: false };

    await this.captureHumanActions(surface, interventionId);
    let resume!: () => void;
    const resumed = new Promise<void>((resolve) => {
      resume = resolve;
    });
    const server = createServer((requestMessage, response) => {
      if (requestMessage.method === "POST" && requestMessage.url === "/resume") {
        response.writeHead(303, { location: "/" });
        response.end();
        resume();
        return;
      }
      response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      response.end(`<!doctype html><html><head><title>Automation handoff</title></head><body>
        <h1>Human control active</h1>
        <p><strong>Reason:</strong> ${escapeHtml(context.reason)}</p>
        <p>Operate the already-open target Chrome window. When the manual step is complete, return here.</p>
        <form method="post" action="/resume"><button type="submit">Return control to automation</button></form>
      </body></html>`);
    });
    await listen(server);
    const address = server.address();
    if (address === null || typeof address === "string") throw new Error("Operator server did not expose a TCP address");
    const operatorUrl = `http://127.0.0.1:${address.port}`;
    await this.logger.log("handoff", "operator_console_ready", { interventionId, operatorUrl }, context.stepId);
    process.stdout.write(`Human intervention requested. Use the existing Chrome window, then resume at ${operatorUrl}\n`);

    const didResume = await Promise.race([
      resumed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), this.timeoutMs))
    ]);
    await close(server);
    if (didResume) {
      await this.logger.log("handoff", "control_transferred", {
        interventionId,
        owner: "automation"
      }, context.stepId);
    }
    return { interventionId, resumed: didResume, operatorUrl };
  }

  private async captureHumanActions(surface: BrowserSurface, interventionId: string): Promise<void> {
    const bindingName = `__captureHumanAction_${interventionId.replaceAll("-", "_")}`;
    await surface.page.exposeFunction(bindingName, async (event: unknown) => {
      await this.logger.log("handoff", "human_action", { interventionId, event });
    });
    const source = await readFile(new URL("./browser/capture-human.js", import.meta.url), "utf8");
    const boundSource = source.replace("__BINDING_NAME_JSON__", JSON.stringify(bindingName));
    await surface.page.addInitScript({ content: boundSource });
    await surface.page.evaluate(boundSource);
  }
}

const escapeHtml = (value: string): string =>
  value.replace(/[&<>'"]/g, (character) => {
    const escaped: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      "'": "&#39;",
      '"': "&quot;"
    };
    return escaped[character] ?? character;
  });

async function listen(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
}

async function close(server: Server): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}
