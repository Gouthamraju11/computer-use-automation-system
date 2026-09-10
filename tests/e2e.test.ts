import assert from "node:assert/strict";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { loadArtifact } from "../src/artifact.js";
import { discover } from "../src/discovery.js";
import { HandoffCoordinator } from "../src/handoff.js";
import { ScriptedProvider } from "../src/llm.js";
import { RunLogger } from "../src/logger.js";
import { Redactor } from "../src/redaction.js";
import { replay } from "../src/replay.js";
import { BrowserSurface } from "../src/surface.js";
import { startTargetServer } from "../src/target/server.js";
import type { AgentDecision, CapabilityArtifact, CapabilityStep, PolicyConfig, RunResult } from "../src/types.js";

const chromePath = process.env.CHROME_PATH ?? (process.platform === "darwin"
  ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : process.platform === "win32"
    ? "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe"
    : "/usr/bin/google-chrome");
const port = 43173;
const origin = `http://127.0.0.1:${port}`;
const testRoot = resolve("tmp/tests/e2e");
const policy: PolicyConfig = {
  allowedOrigins: [origin],
  allowedRoutePatterns: ["^/$", "^/results$", "^/member/[0-9]+$"],
  allowedActions: ["navigate", "click", "type", "extract", "wait"],
  riskyControlPatterns: ["close account"],
  blockedInputPatterns: ["password", "token", "secret", "ssn"],
  maxSteps: 10,
  timeoutMs: 60_000
};

const decisions: AgentDecision[] = [
  {
    action: "type",
    targetRef: "c1",
    valueTemplate: "{{memberId}}",
    description: "Enter the invocation's member number",
    reason: "The labeled lookup field accepts the supplied memberId parameter"
  },
  {
    action: "click",
    targetRef: "c2",
    description: "Submit the member lookup",
    reason: "Search members is the safe lookup action"
  },
  {
    action: "click",
    targetRef: "c1",
    description: "Open the matching member record",
    reason: "The result contains one stable Open member action"
  },
  {
    action: "extract",
    targetRef: "r4",
    outputName: "savingsBalance",
    outputType: "number",
    parser: "currency",
    description: "Read the current savings balance as a number",
    reason: "The readable cell is anchored by the Savings balance row label"
  },
  {
    action: "complete",
    checkpoint: { kind: "text_present", text: "Member Details" },
    reason: "The requested output is captured and the member detail checkpoint is visible"
  }
];

test("discovery records a parameterized artifact and deterministic replay handles all outcome classes", async () => {
  await rm(testRoot, { recursive: true, force: true });
  await mkdir(testRoot, { recursive: true });
  const server = await startTargetServer(port);
  try {
    const artifactPath = join(testRoot, "capability.json");
    const discoveryDirectory = join(testRoot, "discovery");
    const discoveryLogger = new RunLogger(
      "test-discovery",
      join(discoveryDirectory, "events.jsonl"),
      new Redactor(["10001"])
    );
    const discoverySurface = await BrowserSurface.launch({ headless: true, chromePath });
    const discoveryHandoff = new HandoffCoordinator(discoveryLogger, false);
    const discovered = await discover({
      goal: "Look up member 10001 and read their current savings balance",
      targetUrl: `${origin}/`,
      parameters: { memberId: "10001" },
      policy,
      provider: new ScriptedProvider(decisions),
      surface: discoverySurface,
      logger: discoveryLogger,
      handoff: discoveryHandoff,
      runDirectory: discoveryDirectory,
      artifactPath
    });
    await discoverySurface.close();
    assert.equal(discovered.result.status, "success");
    if (discovered.result.status === "success") assert.equal(discovered.result.outputs.savingsBalance, 4321.09);

    const serialized = await readFile(artifactPath, "utf8");
    assert.equal(serialized.includes("10001"), false, "artifact must not persist the sensitive member ID");
    const artifact = await loadArtifact(artifactPath);
    assert.equal(artifact.provenance.rawTranscriptPersisted, false);
    assert.equal(artifact.steps.at(-1)?.target?.strategies[0]?.kind, "table_cell");

    const success = await runReplay(artifactPath, "10001", "success");
    assert.equal(success.status, "success");
    if (success.status === "success") assert.equal(success.outputs.savingsBalance, 4321.09);

    const recovered = await runReplay(artifactPath, "20002", "recovered");
    assert.equal(recovered.status, "success");
    if (recovered.status === "success") assert.equal(recovered.outputs.savingsBalance, 8004.31);
    const recoveryLog = await readFile(join(testRoot, "recovered", "events.jsonl"), "utf8");
    assert.match(recoveryLog, /"event":"recovery_applied"/);

    const notFound = await runReplay(artifactPath, "99999", "not-found");
    assert.equal(notFound.status, "business_outcome");
    if (notFound.status === "business_outcome") assert.equal(notFound.code, "MEMBER_NOT_FOUND");

    const denied = await runReplay(artifactPath, "40300", "denied");
    assert.equal(denied.status, "failure");
    if (denied.status === "failure") {
      assert.equal(denied.code, "PERMISSION_DENIED");
      assert.ok(denied.interventionId, "hard failures must route an intervention request");
    }

    await verifyRiskReclassification(artifact);
    await verifyFailureContext(artifact);
    await verifyInteractiveHandoff(artifact);
  } finally {
    await new Promise<void>((resolveClose, rejectClose) =>
      server.close((error) => (error ? rejectClose(error) : resolveClose()))
    );
  }
});

async function runReplay(artifactPath: string, memberId: string, name: string): Promise<RunResult> {
  const artifact = await loadArtifact(artifactPath);
  const directory = join(testRoot, name);
  const logger = new RunLogger(`test-${name}`, join(directory, "events.jsonl"), new Redactor([memberId]));
  const surface = await BrowserSurface.launch({ headless: true, chromePath });
  const handoff = new HandoffCoordinator(logger, false);
  try {
    return await replay({
      artifact,
      inputs: { memberId },
      surface,
      logger,
      handoff,
      runDirectory: directory
    });
  } finally {
    await surface.close();
  }
}

async function verifyRiskReclassification(baseArtifact: CapabilityArtifact): Promise<void> {
  const directory = join(testRoot, "risk-reclassification");
  const logger = new RunLogger("test-risk-reclassification", join(directory, "events.jsonl"), new Redactor());
  const surface = await BrowserSurface.launch({ headless: true, chromePath });
  const artifact = singleStepArtifact(baseArtifact, riskyCloseStep("safe"), "/member/10001");
  const coordinator = new HandoffCoordinator(logger, false);
  try {
    const result = await replay({ artifact, inputs: {}, surface, logger, handoff: coordinator, runDirectory: directory });
    assert.equal(result.status, "failure");
    if (result.status === "failure") {
      assert.equal(result.code, "INTERVENTION_REQUIRED");
      assert.equal(result.stepId, "risky-step");
    }
    const log = await readFile(join(directory, "events.jsonl"), "utf8");
    assert.match(log, /"risk":"risky"/);
  } finally {
    await surface.close();
  }
}

async function verifyFailureContext(baseArtifact: CapabilityArtifact): Promise<void> {
  const directory = join(testRoot, "failure-context");
  const logger = new RunLogger("test-failure-context", join(directory, "events.jsonl"), new Redactor());
  const surface = await BrowserSurface.launch({ headless: true, chromePath });
  const missingTargetStep: CapabilityStep = {
    id: "missing-target-step",
    action: "click",
    description: "Open a control that is not present",
    risk: "safe",
    timeoutMs: 1_000,
    target: {
      strategies: [{ kind: "role", role: "button", name: "Missing control", exact: true }],
      robustness: "Semantic locator used to exercise structured failure context."
    }
  };
  const artifact = singleStepArtifact(baseArtifact, missingTargetStep, "/");
  const coordinator = new HandoffCoordinator(logger, false);
  try {
    const result = await replay({ artifact, inputs: {}, surface, logger, handoff: coordinator, runDirectory: directory });
    assert.equal(result.status, "failure");
    if (result.status === "failure") {
      assert.equal(result.stepId, "missing-target-step");
      assert.deepEqual(result.expected, {
        action: "click",
        description: "Open a control that is not present"
      });
      assert.ok(result.observed);
    }
  } finally {
    await surface.close();
  }
}

async function verifyInteractiveHandoff(baseArtifact: CapabilityArtifact): Promise<void> {
  const directory = join(testRoot, "interactive-handoff");
  const logPath = join(directory, "events.jsonl");
  const logger = new RunLogger("test-handoff", logPath, new Redactor());
  const surface = await BrowserSurface.launch({ headless: true, chromePath });
  const coordinator = new HandoffCoordinator(logger, true, 5_000);
  const artifact = singleStepArtifact(baseArtifact, riskyCloseStep("risky"), "/member/10001");
  try {
    const pending = replay({ artifact, inputs: {}, surface, logger, handoff: coordinator, runDirectory: directory });
    const operatorUrl = await waitForOperatorUrl(logPath);
    await surface.page.getByRole("button", { name: "Close account", exact: true }).click();
    await fetch(`${operatorUrl}/resume`, { method: "POST", redirect: "manual" });
    const result = await pending;
    assert.equal(result.status, "success");
    const log = await readFile(logPath, "utf8");
    assert.match(log, /"event":"human_action"/);
    assert.match(log, /"owner":"human"/);
    assert.match(log, /"owner":"automation"/);
    assert.match(log, /"event":"run_completed"/);
  } finally {
    await surface.close();
  }
}

function riskyCloseStep(risk: "safe" | "risky"): CapabilityStep {
  return {
    id: "risky-step",
    action: "click",
    description: "Close the member account",
    risk,
    timeoutMs: 10_000,
    target: {
      strategies: [{ kind: "role", role: "button", name: "Close account", exact: true }],
      robustness: "Semantic role and exact operator-facing name."
    }
  };
}

function singleStepArtifact(
  baseArtifact: CapabilityArtifact,
  step: CapabilityStep,
  entryPath: string
): CapabilityArtifact {
  const artifact = structuredClone(baseArtifact);
  artifact.target.entryPath = entryPath;
  artifact.contract.inputs = {};
  artifact.contract.outputs = {};
  artifact.steps = [step];
  artifact.successCondition = { kind: "text_present", text: "Member Details" };
  artifact.exceptionRules = [];
  return artifact;
}

async function waitForOperatorUrl(logPath: string): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const log = await readFile(logPath, "utf8").catch(() => "");
    for (const line of log.trim().split("\n")) {
      if (!line) continue;
      const event = JSON.parse(line) as { event?: string; data?: { operatorUrl?: string } };
      if (event.event === "operator_console_ready" && event.data?.operatorUrl) return event.data.operatorUrl;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
  }
  throw new Error("Operator console did not become ready");
}
