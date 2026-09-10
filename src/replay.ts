import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { assertInputs, parseOutput } from "./artifact.js";
import type { HandoffCoordinator } from "./handoff.js";
import type { RunLogger } from "./logger.js";
import { PolicyEngine } from "./policy.js";
import type { BrowserSurface } from "./surface.js";
import type {
  CapabilityArtifact,
  CapabilityStep,
  ExceptionRule,
  RunResult
} from "./types.js";

export interface ReplayOptions {
  artifact: CapabilityArtifact;
  inputs: Record<string, unknown>;
  targetOrigin?: string;
  surface: BrowserSurface;
  logger: RunLogger;
  handoff: HandoffCoordinator;
  runDirectory: string;
}

export async function replay(options: ReplayOptions): Promise<RunResult> {
  const { artifact } = options;
  const runId = options.logger.runId;
  const policy = new PolicyEngine(artifact.policy);
  const recoveries = new Map<string, number>();
  const outputs: Record<string, unknown> = {};
  await mkdir(options.runDirectory, { recursive: true });

  try {
    assertInputs(artifact, options.inputs);
    const origin = options.targetOrigin ?? artifact.target.baseOrigin;
    const targetUrl = new URL(artifact.target.entryPath, origin).toString();
    policy.assertUrl(targetUrl);
    policy.assertAction("navigate");
    await options.surface.open(targetUrl);
    await options.logger.log("replay", "run_started", {
      capabilityId: artifact.capability.id,
      revision: artifact.capability.revision,
      inputs: redactInputValues(artifact, options.inputs),
      targetUrl
    });

    for (const step of artifact.steps) {
      policy.assertUrl(options.surface.currentUrl());
      const exception = await handleExceptions(options, step, recoveries);
      if (exception !== undefined) return writeAndReturn(options, exception);

      const preScreenshot = join(options.runDirectory, `${step.id}-before.png`);
      await options.surface.observe(preScreenshot);
      await options.logger.log("replay", "step_started", {
        action: step.action,
        description: step.description,
        risk: step.risk,
        url: options.surface.currentUrl()
      }, step.id);

      if (step.risk === "risky") {
        const handoff = await options.handoff.request(options.surface, {
          runId,
          capabilityId: artifact.capability.id,
          stepId: step.id,
          reason: `Risky recorded step requires human execution: ${step.description}`,
          screenshotPath: preScreenshot,
          evidenceDirectory: options.runDirectory
        });
        if (!handoff.resumed) {
          return writeAndReturn(options, {
            status: "failure",
            runId,
            code: "INTERVENTION_REQUIRED",
            message: "Risky step was not executed automatically",
            stepId: step.id,
            evidencePath: preScreenshot,
            interventionId: handoff.interventionId
          });
        }
        continue;
      }

      await executeStep(options, policy, step, outputs);
      await options.logger.log("replay", "step_completed", {
        action: step.action,
        url: options.surface.currentUrl(),
        ...(step.outputName === undefined
          ? {}
          : {
              outputName: step.outputName,
              output: artifact.contract.outputs[step.outputName]?.sensitive
                ? "[REDACTED_OUTPUT]"
                : outputs[step.outputName]
            })
      }, step.id);
    }

    const trailingException = await handleExceptions(
      options,
      artifact.steps.at(-1) ?? { id: "checkpoint" } as CapabilityStep,
      recoveries
    );
    if (trailingException !== undefined) return writeAndReturn(options, trailingException);
    const checkpointVerified = await options.surface.verify(artifact.successCondition);
    if (!checkpointVerified) {
      throw new ReplayFailure("CHECKPOINT_FAILED", "Final success condition was not satisfied", "checkpoint", artifact.successCondition);
    }
    const result: RunResult = { status: "success", runId, outputs, checkpointVerified: true };
    await options.logger.log("replay", "run_completed", {
      status: result.status,
      outputs: redactOutputs(artifact, outputs),
      checkpointVerified
    });
    return writeAndReturn(options, result);
  } catch (error) {
    const failure = error instanceof ReplayFailure
      ? error
      : new ReplayFailure("REPLAY_FAILED", error instanceof Error ? error.message : String(error));
    const screenshotPath = join(options.runDirectory, "failure.png");
    const observation = await options.surface.observe(screenshotPath).catch(() => undefined);
    const stepId = failure.stepId;
    const handoff = await options.handoff.request(options.surface, {
      runId,
      capabilityId: artifact.capability.id,
      ...(stepId === undefined ? {} : { stepId }),
      reason: failure.message,
      screenshotPath,
      evidenceDirectory: options.runDirectory
    }).catch(() => undefined);
    const result: RunResult = {
      status: "failure",
      runId,
      code: failure.code,
      message: failure.message,
      ...(stepId === undefined ? {} : { stepId }),
      ...(failure.expected === undefined ? {} : { expected: failure.expected }),
      ...(observation === undefined
        ? {}
        : { observed: options.logger.redact({ url: observation.url, title: observation.title }) }),
      evidencePath: screenshotPath,
      ...(handoff === undefined ? {} : { interventionId: handoff.interventionId })
    };
    await options.logger.log("replay", "run_failed", result as unknown as Record<string, unknown>, stepId);
    return writeAndReturn(options, result);
  }
}

async function executeStep(
  options: ReplayOptions,
  policy: PolicyEngine,
  step: CapabilityStep,
  outputs: Record<string, unknown>
): Promise<void> {
  policy.assertAction(step.action);
  if (step.action === "wait") {
    await options.surface.wait(step.timeoutMs);
    return;
  }
  if (step.target === undefined) throw new ReplayFailure("INVALID_ARTIFACT", "Step has no target", step.id);
  if (step.action === "click") {
    await options.surface.click(step.target, step.timeoutMs);
    policy.assertUrl(options.surface.currentUrl());
    return;
  }
  if (step.action === "type") {
    policy.assertInputTarget(step.target);
    if (step.value?.source !== "parameter") {
      throw new ReplayFailure("INVALID_VALUE_SOURCE", "Replay only accepts parameter-backed typed values", step.id);
    }
    const value = options.inputs[step.value.name];
    if (value === undefined) throw new ReplayFailure("MISSING_INPUT", `Missing input ${step.value.name}`, step.id);
    await options.surface.type(step.target, String(value), step.timeoutMs);
    return;
  }
  if (!step.outputName || !step.outputType || !step.parser) {
    throw new ReplayFailure("INVALID_OUTPUT", "Extract step is missing its output contract", step.id);
  }
  const raw = await options.surface.extract(step.target, step.timeoutMs);
  outputs[step.outputName] = parseOutput(raw, step.outputType, step.parser);
}

async function handleExceptions(
  options: ReplayOptions,
  step: CapabilityStep,
  recoveries: Map<string, number>
): Promise<RunResult | undefined> {
  for (const rule of options.artifact.exceptionRules) {
    if (!(await options.surface.hasText(rule.whenTextPresent))) continue;
    await options.logger.log("replay", "exception_detected", {
      ruleId: rule.id,
      category: rule.category,
      observed: rule.whenTextPresent
    }, step.id);
    if (rule.category === "business_outcome") {
      return {
        status: "business_outcome",
        runId: options.logger.runId,
        code: rule.code,
        message: rule.message,
        stepId: step.id,
        outputs: {}
      };
    }
    if (rule.category === "hard_failure") {
      const attempts = recoveries.get(rule.id) ?? 0;
      if (attempts > 0) {
        return {
          status: "failure",
          runId: options.logger.runId,
          code: rule.code,
          message: `${rule.message}; the state remained blocked after human handoff`,
          stepId: step.id,
          expected: "authorized application state",
          observed: rule.whenTextPresent,
          evidencePath: join(options.runDirectory, `${step.id}-hard-failure.png`)
        };
      }
      recoveries.set(rule.id, attempts + 1);
      const screenshotPath = join(options.runDirectory, `${step.id}-hard-failure.png`);
      await options.surface.observe(screenshotPath);
      const handoff = await options.handoff.request(options.surface, {
        runId: options.logger.runId,
        capabilityId: options.artifact.capability.id,
        stepId: step.id,
        reason: rule.message,
        screenshotPath,
        evidenceDirectory: options.runDirectory
      });
      if (handoff.resumed) return handleExceptions(options, step, recoveries);
      return {
        status: "failure",
        runId: options.logger.runId,
        code: rule.code,
        message: rule.message,
        stepId: step.id,
        expected: "authorized application state",
        observed: options.logger.redact({ url: options.surface.currentUrl(), text: rule.whenTextPresent }),
        evidencePath: screenshotPath,
        interventionId: handoff.interventionId
      };
    }
    const attempts = recoveries.get(rule.id) ?? 0;
    if (attempts >= rule.maxAttempts) {
      throw new ReplayFailure("RECOVERY_EXHAUSTED", `Recovery ${rule.id} exceeded ${rule.maxAttempts} attempt(s)`, step.id);
    }
    recoveries.set(rule.id, attempts + 1);
    await recover(options, rule);
    await options.logger.log("replay", "recovery_applied", {
      ruleId: rule.id,
      attempt: attempts + 1,
      recovery: rule.recovery.kind
    }, step.id);
    return handleExceptions(options, step, recoveries);
  }
  return undefined;
}

async function recover(
  options: ReplayOptions,
  rule: Extract<ExceptionRule, { category: "recoverable" }>
): Promise<void> {
  if (rule.recovery.kind === "click") {
    await options.surface.click(rule.recovery.target, 10_000);
  } else if (rule.recovery.kind === "reload") {
    await options.surface.reload(10_000);
  } else {
    await options.surface.wait(rule.recovery.timeoutMs);
  }
}

class ReplayFailure extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly stepId?: string,
    readonly expected?: unknown,
    readonly observed?: unknown
  ) {
    super(message);
    this.name = "ReplayFailure";
  }
}

function redactInputValues(
  artifact: CapabilityArtifact,
  inputs: Record<string, unknown>
): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(inputs).map(([name, value]) => [
      name,
      artifact.contract.inputs[name]?.sensitive ? "[REDACTED_INPUT]" : value
    ])
  );
}

async function writeAndReturn(options: ReplayOptions, result: RunResult): Promise<RunResult> {
  const persisted = result.status === "success"
    ? { ...result, outputs: redactOutputs(options.artifact, result.outputs) }
    : result;
  await writeFile(
    join(options.runDirectory, "result.json"),
    `${JSON.stringify(options.logger.redact(persisted), null, 2)}\n`,
    "utf8"
  );
  return result;
}

function redactOutputs(artifact: CapabilityArtifact, outputs: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(outputs).map(([name, value]) => [
      name,
      artifact.contract.outputs[name]?.sensitive ? "[REDACTED_OUTPUT]" : value
    ])
  );
}
