#!/usr/bin/env node
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { loadArtifact } from "./artifact.js";
import { discover, newRunId } from "./discovery.js";
import { HandoffCoordinator } from "./handoff.js";
import { ModelCliProvider, OpenAIResponsesProvider, type DecisionProvider } from "./llm.js";
import { RunLogger } from "./logger.js";
import { Redactor } from "./redaction.js";
import { replay } from "./replay.js";
import { BrowserSurface } from "./surface.js";
import { startTargetServer } from "./target/server.js";
import type { PolicyConfig } from "./types.js";

const DEFAULT_CHROME_PATH = process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : "/usr/bin/google-chrome";

async function main(): Promise<void> {
  const [command, ...rawArgs] = process.argv.slice(2);
  const args = parseArgs(rawArgs);
  if (command === "target") {
    const port = Number(args.port ?? "4173");
    const server = await startTargetServer(port);
    process.stdout.write(`Heritage Core target listening at http://127.0.0.1:${port}\n`);
    const stop = (): void => {
      server.close(() => process.exit(0));
    };
    process.on("SIGINT", stop);
    process.on("SIGTERM", stop);
    return;
  }
  if (command === "discover") {
    await runDiscovery(args);
    return;
  }
  if (command === "replay") {
    await runReplay(args);
    return;
  }
  usage();
  process.exitCode = 1;
}

async function runDiscovery(args: Record<string, string | boolean>): Promise<void> {
  const goal = required(args, "goal");
  const targetUrl = String(args.target ?? "http://127.0.0.1:4173/");
  const parameters = parseJsonObject(args.params ?? "{}");
  const artifactPath = resolve(String(args.artifact ?? "evidence/capability.json"));
  const runId = newRunId("discovery");
  const runDirectory = resolve(String(args["run-dir"] ?? `evidence/runs/live-${runId}`));
  const policy = await loadPolicy(String(args.policy ?? "config/policy.json"));
  const redactor = new Redactor(sensitiveValues(policy, parameters));
  const logger = new RunLogger(runId, resolve(runDirectory, "events.jsonl"), redactor);
  const surface = await BrowserSurface.launch({
    headless: args.headed !== true,
    chromePath: String(args["chrome-path"] ?? process.env.CHROME_PATH ?? DEFAULT_CHROME_PATH)
  });
  const handoff = new HandoffCoordinator(logger, args["interactive-handoff"] === true);
  try {
    const provider = createProvider(args);
    const result = await discover({
      goal,
      targetUrl,
      parameters,
      policy,
      provider,
      surface,
      logger,
      handoff,
      runDirectory,
      artifactPath
    });
    process.stdout.write(`${JSON.stringify(result.result, null, 2)}\n`);
    if (result.result.status !== "success") process.exitCode = 2;
  } finally {
    await surface.close();
  }
}

async function runReplay(args: Record<string, string | boolean>): Promise<void> {
  const artifactPath = resolve(String(args.artifact ?? "evidence/capability.json"));
  const artifact = await loadArtifact(artifactPath);
  const inputs = parseJsonObject(args.inputs ?? "{}");
  const runId = newRunId("replay");
  const runDirectory = resolve(String(args["run-dir"] ?? `evidence/runs/live-${runId}`));
  const redactor = new Redactor(
    Object.entries(inputs)
      .filter(([name]) => artifact.contract.inputs[name]?.sensitive)
      .map(([, value]) => value)
  );
  const logger = new RunLogger(runId, resolve(runDirectory, "events.jsonl"), redactor);
  const surface = await BrowserSurface.launch({
    headless: args.headed !== true,
    chromePath: String(args["chrome-path"] ?? process.env.CHROME_PATH ?? DEFAULT_CHROME_PATH)
  });
  const handoff = new HandoffCoordinator(logger, args["interactive-handoff"] === true);
  try {
    const result = await replay({
      artifact,
      inputs,
      ...(args.target === undefined ? {} : { targetOrigin: String(args.target) }),
      surface,
      logger,
      handoff,
      runDirectory
    });
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
    if (result.status === "failure") process.exitCode = 2;
  } finally {
    await surface.close();
  }
}

function createProvider(args: Record<string, string | boolean>): DecisionProvider {
  const provider = String(args.provider ?? "openai");
  if (provider === "model-cli") {
    const executable = args["model-cli-path"] ?? process.env.MODEL_CLI_PATH;
    if (typeof executable !== "string" || executable.length === 0) {
      throw new Error("MODEL_CLI_PATH or --model-cli-path is required for --provider model-cli");
    }
    return new ModelCliProvider(
      executable,
      String(args.model ?? "gpt-5.6-luna")
    );
  }
  if (provider !== "openai") throw new Error(`Unknown provider ${provider}; expected openai or model-cli`);
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) throw new Error("OPENAI_API_KEY is required for --provider openai");
  return new OpenAIResponsesProvider(String(args.model ?? process.env.OPENAI_MODEL ?? "gpt-5-mini"), apiKey);
}

function parseArgs(raw: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  for (let index = 0; index < raw.length; index += 1) {
    const token = raw[index];
    if (token === undefined || !token.startsWith("--")) throw new Error(`Unexpected argument: ${String(token)}`);
    const key = token.slice(2);
    const next = raw[index + 1];
    if (next === undefined || next.startsWith("--")) {
      result[key] = true;
    } else {
      result[key] = next;
      index += 1;
    }
  }
  return result;
}

function required(args: Record<string, string | boolean>, name: string): string {
  const value = args[name];
  if (typeof value !== "string" || value.length === 0) throw new Error(`--${name} is required`);
  return value;
}

function parseJsonObject(value: string | boolean): Record<string, unknown> {
  if (typeof value !== "string") throw new Error("Expected a JSON object argument");
  const parsed: unknown = JSON.parse(value);
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("Expected a JSON object");
  return parsed as Record<string, unknown>;
}

async function loadPolicy(path: string): Promise<PolicyConfig> {
  return JSON.parse(await readFile(resolve(path), "utf8")) as PolicyConfig;
}

function sensitiveValues(policy: PolicyConfig, parameters: Record<string, unknown>): unknown[] {
  return Object.entries(parameters)
    .filter(([name]) => policy.blockedInputPatterns.some((pattern) => name.toLowerCase().includes(pattern.toLowerCase())) || /member|account|email|phone/i.test(name))
    .map(([, value]) => value);
}

function usage(): void {
  process.stderr.write(`Usage:
  npm run target
  npm run discover -- --goal <text> --params '{"memberId":"10001"}' [--provider openai|model-cli]
  npm run replay -- --artifact evidence/capability.json --inputs '{"memberId":"10001"}'
`);
}

main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
  process.exitCode = 1;
});
