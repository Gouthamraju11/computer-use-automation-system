import { createHash, randomUUID } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { parseOutput, saveArtifact } from "./artifact.js";
import type { HandoffCoordinator } from "./handoff.js";
import type { DecisionProvider } from "./llm.js";
import type { RunLogger } from "./logger.js";
import { PolicyEngine } from "./policy.js";
import type { BrowserSurface } from "./surface.js";
import type {
  AgentDecision,
  CapabilityArtifact,
  CapabilityStep,
  InputSpec,
  Observation,
  OutputSpec,
  PolicyConfig,
  RunResult,
  TargetLocator
} from "./types.js";

export interface DiscoveryOptions {
  goal: string;
  targetUrl: string;
  parameters: Record<string, unknown>;
  policy: PolicyConfig;
  provider: DecisionProvider;
  surface: BrowserSurface;
  logger: RunLogger;
  handoff: HandoffCoordinator;
  runDirectory: string;
  artifactPath: string;
}

export interface DiscoveryResult {
  result: RunResult;
  artifact?: CapabilityArtifact;
}

export async function discover(options: DiscoveryOptions): Promise<DiscoveryResult> {
  const runId = options.logger.runId;
  const policy = new PolicyEngine(options.policy);
  const started = Date.now();
  const steps: CapabilityStep[] = [];
  const outputs: Record<string, unknown> = {};
  const outputSpecs: Record<string, OutputSpec> = {};
  const inputSpecs = inferInputSpecs(options.parameters);
  await mkdir(options.runDirectory, { recursive: true });

  try {
    policy.assertUrl(options.targetUrl);
    policy.assertAction("navigate");
    await options.surface.open(options.targetUrl);
    await options.logger.log("discovery", "run_started", {
      goal: parameterize(options.goal, options.parameters),
      targetUrl: options.targetUrl,
      provider: options.provider.provider,
      model: options.provider.model
    });

    const completedActions: Array<{ action: string; description: string }> = [];
    for (let index = 0; index < options.policy.maxSteps; index += 1) {
      if (Date.now() - started > options.policy.timeoutMs) {
        return failure(runId, "TIMEOUT", "Discovery exceeded its configured timeout", options.runDirectory);
      }
      policy.assertUrl(options.surface.currentUrl());
      const observation = await observe(options.surface, options.runDirectory, index + 1);
      await logObservation(options.logger, observation, index + 1);
      const decision = await options.provider.decide({
        goal: options.goal,
        parameters: options.parameters,
        observation,
        completedActions,
        extractedOutputs: outputs
      });
      await options.logger.log("discovery", "model_decision", decision as unknown as Record<string, unknown>);

      if (decision.action === "complete") {
        const checkpoint = canonicalizeCheckpoint(decision.checkpoint, observation);
        assertStableCheckpoint(checkpoint, options.parameters);
        if (JSON.stringify(checkpoint) !== JSON.stringify(decision.checkpoint)) {
          await options.logger.log("discovery", "checkpoint_canonicalized", {
            proposed: decision.checkpoint,
            accepted: checkpoint
          });
        }
        const verified = await options.surface.verify(checkpoint);
        if (!verified) throw new Error("Model declared completion but its checkpoint was not satisfied");
        const artifact = buildArtifact(options, steps, inputSpecs, outputSpecs, checkpoint);
        await saveArtifact(options.artifactPath, artifact);
        const result: RunResult = { status: "success", runId, outputs, checkpointVerified: true };
        await writeResult(options.runDirectory, result, options.logger, outputSpecs);
        await options.logger.log("discovery", "run_completed", {
          status: result.status,
          artifactPath: options.artifactPath,
          outputs: redactOutputs(outputSpecs, outputs)
        });
        return { result, artifact };
      }

      if (decision.action === "escalate") {
        const handoff = await options.handoff.request(options.surface, {
          runId,
          goal: parameterize(options.goal, options.parameters),
          reason: decision.reason,
          screenshotPath: observation.screenshotPath,
          evidenceDirectory: options.runDirectory
        });
        if (!handoff.resumed) {
          const result: RunResult = {
            status: "failure",
            runId,
            code: "INTERVENTION_REQUIRED",
            message: decision.reason,
            evidencePath: observation.screenshotPath,
            interventionId: handoff.interventionId
          };
          await writeResult(options.runDirectory, result, options.logger);
          return { result };
        }
        continue;
      }

      const step = await executeDecision(options, policy, decision, observation, steps.length + 1, outputs);
      if (step !== undefined) {
        steps.push(step);
        completedActions.push({ action: step.action, description: step.description });
        if (step.action === "extract" && step.outputName && step.outputType) {
          outputSpecs[step.outputName] = {
            type: step.outputType,
            description: step.description,
            sourceStepId: step.id,
            sensitive: /balance|amount|account|member|name|address|email|phone/i.test(step.outputName)
          };
        }
      }
    }
    return failure(runId, "MAX_STEPS", "Discovery reached the configured maximum number of steps", options.runDirectory);
  } catch (error) {
    const screenshotPath = join(options.runDirectory, "failure.png");
    await options.surface.observe(screenshotPath).catch(() => undefined);
    const result: RunResult = {
      status: "failure",
      runId,
      code: "DISCOVERY_FAILED",
      message: error instanceof Error ? error.message : String(error),
      evidencePath: screenshotPath
    };
    await options.logger.log("discovery", "run_failed", { message: result.message, screenshotPath });
    await writeResult(options.runDirectory, result, options.logger);
    return { result };
  }
}

async function executeDecision(
  options: DiscoveryOptions,
  policy: PolicyEngine,
  decision: Exclude<AgentDecision, { action: "complete" | "escalate" }>,
  observation: Observation,
  sequence: number,
  outputs: Record<string, unknown>
): Promise<CapabilityStep | undefined> {
  const id = `step-${String(sequence).padStart(2, "0")}`;
  if (decision.action === "wait") {
    policy.assertAction("wait");
    await options.surface.wait(decision.timeoutMs);
    return {
      id,
      action: "wait",
      description: parameterize(decision.description, options.parameters),
      risk: "safe",
      timeoutMs: decision.timeoutMs
    };
  }
  const element = observation.elements.find((item) => item.ref === decision.targetRef);
  if (element === undefined) throw new Error(`Model selected unknown element ref ${decision.targetRef}`);
  policy.assertAction(decision.action);
  const risk = policy.classify(decision.action, element.locator);
  if (risk === "risky") {
    const handoff = await options.handoff.request(options.surface, {
      runId: options.logger.runId,
      goal: parameterize(options.goal, options.parameters),
      stepId: id,
      reason: `Risky control requires a human: ${element.name}`,
      screenshotPath: observation.screenshotPath,
      evidenceDirectory: options.runDirectory
    });
    if (!handoff.resumed) throw new Error(`Risky action blocked; intervention ${handoff.interventionId} is required`);
    return undefined;
  }

  const base = {
    id,
    description: parameterize(decision.description, options.parameters),
    risk,
    target: element.locator,
    timeoutMs: 10_000
  };
  if (decision.action === "click") {
    if (element.kind !== "control") throw new Error(`Cannot click readable ref ${element.ref}`);
    await options.surface.click(element.locator, base.timeoutMs);
    policy.assertUrl(options.surface.currentUrl());
    return { ...base, action: "click" };
  }
  if (decision.action === "type") {
    if (element.kind !== "control") throw new Error(`Cannot type into readable ref ${element.ref}`);
    policy.assertInputTarget(element.locator);
    const parameterName = parseParameterTemplate(decision.valueTemplate);
    const value = options.parameters[parameterName];
    if (value === undefined) throw new Error(`Model requested unknown parameter ${parameterName}`);
    await options.surface.type(element.locator, String(value), base.timeoutMs);
    return { ...base, action: "type", value: { source: "parameter", name: parameterName } };
  }
  const raw = await options.surface.extract(element.locator, base.timeoutMs);
  const value = parseOutput(raw, decision.outputType, decision.parser);
  outputs[decision.outputName] = value;
  return {
    ...base,
    action: "extract",
    outputName: decision.outputName,
    outputType: decision.outputType,
    parser: decision.parser
  };
}

function buildArtifact(
  options: DiscoveryOptions,
  steps: CapabilityStep[],
  inputs: Record<string, InputSpec>,
  outputs: Record<string, OutputSpec>,
  successCondition: CapabilityArtifact["successCondition"]
): CapabilityArtifact {
  const target = new URL(options.targetUrl);
  const description = parameterize(options.goal, options.parameters);
  const slug = description
    .toLowerCase()
    .replace(/\{\{[^}]+\}\}/g, "value")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "")
    .slice(0, 54);
  const digest = createHash("sha256").update(`${target.origin}|${description}`).digest("hex").slice(0, 8);
  return {
    schemaVersion: "1.0",
    capability: {
      id: `${slug}-${digest}`,
      name: slug,
      description,
      revision: 1,
      approval: "draft",
      recordedAt: new Date().toISOString()
    },
    target: {
      adapter: "web",
      appId: "heritage-core-member-servicing",
      baseOrigin: target.origin,
      entryPath: target.pathname,
      vendorProduct: "heritage-core-7",
      compatibleVersions: ["7.x"],
      tenantOverrides: {}
    },
    contract: {
      inputs,
      outputs,
      resultVariants: ["success", "business_outcome", "failure"]
    },
    policy: options.policy,
    steps,
    successCondition,
    exceptionRules: defaultExceptionRules(),
    provenance: {
      discoveryRunId: options.logger.runId,
      modelProvider: options.provider.provider,
      model: options.provider.model,
      rawTranscriptPersisted: false
    }
  };
}

function defaultExceptionRules(): CapabilityArtifact["exceptionRules"] {
  return [
    {
      id: "member-not-found",
      category: "business_outcome",
      whenTextPresent: "No member found",
      code: "MEMBER_NOT_FOUND",
      message: "No member exists for the supplied member number"
    },
    {
      id: "session-expired",
      category: "recoverable",
      whenTextPresent: "Session expired",
      maxAttempts: 1,
      recovery: {
        kind: "click",
        target: {
          strategies: [
            { kind: "role", role: "link", name: "Resume session", exact: true },
            { kind: "text", text: "Resume session", exact: true }
          ],
          robustness: "Stable operator-facing recovery label with a text fallback."
        }
      }
    },
    {
      id: "permission-denied",
      category: "hard_failure",
      whenTextPresent: "Permission denied",
      code: "PERMISSION_DENIED",
      message: "The active operator is not authorized to view this record"
    }
  ];
}

function inferInputSpecs(parameters: Record<string, unknown>): Record<string, InputSpec> {
  return Object.fromEntries(
    Object.entries(parameters).map(([name, value]) => {
      const type = typeof value;
      if (!["string", "number", "boolean"].includes(type)) {
        throw new Error(`Parameter ${name} must be a string, number, or boolean`);
      }
      return [
        name,
        {
          type: type as InputSpec["type"],
          description: `Invocation-specific ${name}`,
          sensitive: /member|account|ssn|token|secret|password|email|phone/i.test(name),
          required: true
        }
      ];
    })
  );
}

function parseParameterTemplate(template: string): string {
  const match = /^\{\{([a-zA-Z][a-zA-Z0-9_]*)\}\}$/.exec(template);
  if (match?.[1] === undefined) throw new Error("Typed values must reference one parameter as {{parameterName}}");
  return match[1];
}

function assertStableCheckpoint(
  checkpoint: CapabilityArtifact["successCondition"],
  parameters: Record<string, unknown>
): void {
  const serialized = JSON.stringify(checkpoint);
  if (Object.values(parameters).some((value) => serialized.includes(String(value)))) {
    throw new Error("Checkpoint contains an invocation-specific input value");
  }
  if (checkpoint.kind === "text_present" && /\$\s*\d|\d[.,]\d/.test(checkpoint.text)) {
    throw new Error("Checkpoint contains a runtime data value rather than a stable UI label");
  }
}

function canonicalizeCheckpoint(
  checkpoint: CapabilityArtifact["successCondition"],
  observation: Observation
): CapabilityArtifact["successCondition"] {
  if (checkpoint.kind !== "text_present") return checkpoint;
  const normalizedProposal = normalizeLabel(checkpoint.text);
  const candidates = [
    observation.title.split(" - ")[0] ?? "",
    ...observation.visibleText
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && line.length <= 80 && !line.includes("\t"))
  ];
  const exact = candidates.find((candidate) => normalizeLabel(candidate) === normalizedProposal);
  if (exact !== undefined) return { kind: "text_present", text: exact };
  const contained = candidates.find((candidate) => {
    const normalizedCandidate = normalizeLabel(candidate);
    return normalizedCandidate.length >= 5 && normalizedProposal.startsWith(normalizedCandidate);
  });
  return contained === undefined ? checkpoint : { kind: "text_present", text: contained };
}

function normalizeLabel(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function parameterize(text: string, parameters: Record<string, unknown>): string {
  let output = text;
  for (const [name, value] of Object.entries(parameters).sort((a, b) => String(b[1]).length - String(a[1]).length)) {
    output = output.split(String(value)).join(`{{${name}}}`);
  }
  return output;
}

async function observe(surface: BrowserSurface, directory: string, index: number): Promise<Observation> {
  return surface.observe(join(directory, `observation-${String(index).padStart(2, "0")}.png`));
}

async function logObservation(logger: RunLogger, observation: Observation, index: number): Promise<void> {
  await logger.log("discovery", "observation", {
    index,
    url: observation.url,
    title: observation.title,
    visibleTextSha256: createHash("sha256").update(observation.visibleText).digest("hex"),
    visibleTextLength: observation.visibleText.length,
    elements: observation.elements.map(({ ref, kind, role, name, enabled }) => ({
      ref,
      kind,
      role,
      name: kind === "readable" ? `${name.split(":")[0]}: [REDACTED_VALUE]` : name,
      enabled
    })),
    screenshotPath: observation.screenshotPath
  });
}

async function writeResult(
  directory: string,
  result: RunResult,
  logger?: RunLogger,
  specs: Record<string, OutputSpec> = {}
): Promise<void> {
  const persisted = result.status === "success"
    ? { ...result, outputs: redactOutputs(specs, result.outputs) }
    : result;
  await writeFile(
    join(directory, "result.json"),
    `${JSON.stringify(logger?.redact(persisted) ?? persisted, null, 2)}\n`,
    "utf8"
  );
}

async function failure(
  runId: string,
  code: string,
  message: string,
  directory: string
): Promise<DiscoveryResult> {
  const result: RunResult = {
    status: "failure",
    runId,
    code,
    message,
    evidencePath: join(directory, "failure.png")
  };
  await writeResult(directory, result);
  return { result };
}

function redactOutputs(specs: Record<string, OutputSpec>, outputs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(outputs).map(([name, value]) => [name, specs[name]?.sensitive ? "[REDACTED_OUTPUT]" : value])
  );
}

export const newRunId = (prefix: string): string => `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomUUID().slice(0, 8)}`;
export const artifactFilename = (path: string): string => basename(path);
