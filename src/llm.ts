import { spawn } from "node:child_process";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import type { AgentDecision, Observation } from "./types.js";

export interface DecisionContext {
  goal: string;
  parameters: Record<string, unknown>;
  observation: Observation;
  completedActions: Array<{ action: string; description: string }>;
  extractedOutputs: Record<string, unknown>;
}

export interface DecisionProvider {
  readonly provider: string;
  readonly model: string;
  decide(context: DecisionContext): Promise<AgentDecision>;
}

const SYSTEM_PROMPT = `You control a business application through a constrained UI adapter.
Choose exactly one next action that advances the supplied goal.

Rules:
- Use only element refs present in the current observation.
- Prefer semantic controls and the shortest safe path.
- To enter a supplied parameter, set valueTemplate to exactly {{parameterName}}. Never copy its runtime value.
- Use extract on the specific readable element that contains a requested output.
- Set outputType to number with parser currency for a monetary balance.
- Complete only after the goal is satisfied, outputs are extracted, and the checkpoint is currently observable.
- A checkpoint must be a stable page heading or label (for example, Member Details), never a runtime value or a combined label/value string.
- Escalate if the next safe action is ambiguous, blocked, or irreversible.
- Do not navigate by inventing URLs and do not include secrets in descriptions or reasons.
- Return JSON only.`;

const schemaPath = new URL("../config/decision.schema.json", import.meta.url);

function userPrompt(context: DecisionContext): string {
  return JSON.stringify({
    goal: context.goal,
    parameters: context.parameters,
    completedActions: context.completedActions,
    extractedOutputs: context.extractedOutputs,
    observation: {
      url: context.observation.url,
      title: context.observation.title,
      visibleText: context.observation.visibleText,
      elements: context.observation.elements.map(({ ref, kind, role, name, enabled }) => ({
        ref,
        kind,
        role,
        name,
        enabled
      }))
    }
  });
}

function parseDecision(value: unknown): AgentDecision {
  if (typeof value !== "object" || value === null) throw new Error("Model decision was not an object");
  const record = value as Record<string, unknown>;
  if (typeof record.action !== "string" || typeof record.reason !== "string") {
    throw new Error("Model decision is missing action or reason");
  }
  const allowed = ["click", "type", "extract", "wait", "complete", "escalate"];
  if (!allowed.includes(record.action)) throw new Error(`Unsupported model action: ${record.action}`);
  if (["click", "type", "extract"].includes(record.action) && typeof record.targetRef !== "string") {
    throw new Error(`${record.action} requires targetRef`);
  }
  if (record.action === "type" && typeof record.valueTemplate !== "string") {
    throw new Error("type requires valueTemplate");
  }
  if (
    record.action === "extract" &&
    (typeof record.outputName !== "string" || typeof record.outputType !== "string" || typeof record.parser !== "string")
  ) {
    throw new Error("extract requires outputName, outputType, and parser");
  }
  if (record.action === "wait" && typeof record.timeoutMs !== "number") throw new Error("wait requires timeoutMs");
  if (record.action === "complete") {
    const checkpoint = record.checkpoint as Record<string, unknown> | null;
    if (!checkpoint || typeof checkpoint.kind !== "string") throw new Error("complete requires checkpoint");
    const normalizedCheckpoint = checkpoint.kind === "text_present"
      ? { kind: "text_present" as const, text: String(checkpoint.text ?? "") }
      : { kind: "url_matches" as const, pattern: String(checkpoint.pattern ?? "") };
    return { action: "complete", checkpoint: normalizedCheckpoint, reason: record.reason };
  }
  if (record.action === "escalate") return { action: "escalate", reason: record.reason };
  if (record.action === "click") {
    return {
      action: "click",
      targetRef: record.targetRef as string,
      description: String(record.description),
      reason: record.reason
    };
  }
  if (record.action === "type") {
    return {
      action: "type",
      targetRef: record.targetRef as string,
      valueTemplate: record.valueTemplate as string,
      description: String(record.description),
      reason: record.reason
    };
  }
  if (record.action === "extract") {
    return {
      action: "extract",
      targetRef: record.targetRef as string,
      outputName: record.outputName as string,
      outputType: record.outputType as "string" | "number" | "boolean",
      parser: record.parser as "text" | "number" | "currency" | "boolean",
      description: String(record.description),
      reason: record.reason
    };
  }
  return {
    action: "wait",
    timeoutMs: record.timeoutMs as number,
    description: String(record.description),
    reason: record.reason
  };
}

export class OpenAIResponsesProvider implements DecisionProvider {
  readonly provider = "openai-responses";

  constructor(
    readonly model: string,
    private readonly apiKey: string
  ) {}

  async decide(context: DecisionContext): Promise<AgentDecision> {
    const schema = JSON.parse(await readFile(schemaPath, "utf8")) as Record<string, unknown>;
    const response = await fetch("https://api.openai.com/v1/responses", {
      method: "POST",
      headers: {
        authorization: `Bearer ${this.apiKey}`,
        "content-type": "application/json"
      },
      body: JSON.stringify({
        model: this.model,
        input: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt(context) }
        ],
        text: { format: { type: "json_schema", name: "computer_action", strict: true, schema } }
      })
    });
    if (!response.ok) throw new Error(`OpenAI request failed (${response.status}): ${await response.text()}`);
    const payload = (await response.json()) as {
      output?: Array<{ content?: Array<{ type?: string; text?: string }> }>;
    };
    const text = payload.output
      ?.flatMap((item) => item.content ?? [])
      .find((item) => item.type === "output_text")?.text;
    if (text === undefined) throw new Error("OpenAI response did not contain output_text");
    return parseDecision(JSON.parse(text));
  }
}

export class ModelCliProvider implements DecisionProvider {
  readonly provider = "model-cli";

  constructor(
    private readonly executable: string,
    readonly model = "gpt-5.6-luna"
  ) {}

  async decide(context: DecisionContext): Promise<AgentDecision> {
    const prompt = `${SYSTEM_PROMPT}\n\nCURRENT STATE:\n${userPrompt(context)}`;
    const stdout = await runProcess(
      this.executable,
      [
        "exec",
        "--ephemeral",
        "--ignore-user-config",
        "--ignore-rules",
        "--sandbox",
        "read-only",
        "--skip-git-repo-check",
        "--color",
        "never",
        "--model",
        this.model,
        "--output-schema",
        fileURLToPath(new URL("../config/decision.schema.json", import.meta.url)),
        prompt
      ]
    );
    const trimmed = stdout.trim();
    const start = trimmed.lastIndexOf("\n{");
    const json = start >= 0 ? trimmed.slice(start + 1) : trimmed;
    return parseDecision(JSON.parse(json));
  }
}

async function runProcess(executable: string, args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    const child = spawn(executable, args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > 2_000_000) child.kill("SIGTERM");
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
      if (stderr.length > 2_000_000) child.kill("SIGTERM");
    });
    child.once("error", reject);
    child.once("close", (code, signal) => {
      if (code === 0) resolve(stdout);
      else reject(new Error(`Model CLI exited with ${code ?? signal}: ${stderr.slice(-4000)}`));
    });
  });
}

export class ScriptedProvider implements DecisionProvider {
  readonly provider = "scripted-test-double";
  readonly model = "none";
  private index = 0;

  constructor(private readonly decisions: AgentDecision[]) {}

  async decide(): Promise<AgentDecision> {
    const decision = this.decisions[this.index];
    if (decision === undefined) throw new Error("Scripted provider ran out of decisions");
    this.index += 1;
    return decision;
  }
}
