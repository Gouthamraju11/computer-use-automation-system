import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { CapabilityArtifact, PrimitiveType } from "./types.js";

export function assertArtifact(value: unknown): asserts value is CapabilityArtifact {
  if (typeof value !== "object" || value === null) throw new Error("Artifact must be an object");
  const artifact = value as Partial<CapabilityArtifact>;
  if (artifact.schemaVersion !== "1.0") throw new Error(`Unsupported artifact schema: ${String(artifact.schemaVersion)}`);
  if (artifact.capability?.id === undefined || artifact.capability.revision < 1) {
    throw new Error("Artifact capability identity/revision is invalid");
  }
  if (artifact.target?.adapter !== "web" || !artifact.target.baseOrigin || !artifact.target.entryPath) {
    throw new Error("Artifact target contract is invalid");
  }
  if (!artifact.contract || !artifact.policy || !Array.isArray(artifact.steps) || artifact.steps.length === 0) {
    throw new Error("Artifact contract, policy, and non-empty steps are required");
  }
  const ids = new Set<string>();
  for (const step of artifact.steps) {
    if (!step.id || ids.has(step.id)) throw new Error(`Duplicate or missing step id: ${step.id}`);
    ids.add(step.id);
    if (["click", "type", "extract"].includes(step.action) && step.target === undefined) {
      throw new Error(`Step ${step.id} requires a target`);
    }
    if (step.target !== undefined && step.target.strategies.length === 0) {
      throw new Error(`Step ${step.id} has no locator strategies`);
    }
    if (step.action === "type" && step.value === undefined) throw new Error(`Step ${step.id} requires a value source`);
    if (step.action === "extract" && (!step.outputName || !step.outputType || !step.parser)) {
      throw new Error(`Step ${step.id} has an incomplete output declaration`);
    }
  }
  for (const [name, spec] of Object.entries(artifact.contract.outputs)) {
    if (!ids.has(spec.sourceStepId)) throw new Error(`Output ${name} refers to unknown step ${spec.sourceStepId}`);
  }
}

export async function loadArtifact(path: string): Promise<CapabilityArtifact> {
  const value: unknown = JSON.parse(await readFile(path, "utf8"));
  assertArtifact(value);
  return value;
}

export async function saveArtifact(path: string, artifact: CapabilityArtifact): Promise<void> {
  assertArtifact(artifact);
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
}

export function assertInputs(
  artifact: CapabilityArtifact,
  inputs: Record<string, unknown>
): void {
  for (const [name, spec] of Object.entries(artifact.contract.inputs)) {
    const value = inputs[name];
    if (value === undefined && spec.required) throw new Error(`Missing required input: ${name}`);
    if (value !== undefined && typeof value !== spec.type) {
      throw new Error(`Input ${name} must be ${spec.type}, received ${typeof value}`);
    }
  }
  const unknown = Object.keys(inputs).filter((name) => artifact.contract.inputs[name] === undefined);
  if (unknown.length > 0) throw new Error(`Unknown input(s): ${unknown.join(", ")}`);
}

export function parseOutput(
  raw: string,
  outputType: PrimitiveType,
  parser: "text" | "number" | "currency" | "boolean"
): unknown {
  if (parser === "text") return raw.trim();
  if (parser === "number" || parser === "currency") {
    const normalized = raw.replace(/[^0-9.-]/g, "");
    if (normalized.length === 0 || !/[0-9]/.test(normalized)) {
      throw new Error(`Cannot parse ${JSON.stringify(raw)} as a number`);
    }
    const number = Number(normalized);
    if (!Number.isFinite(number)) throw new Error(`Cannot parse ${JSON.stringify(raw)} as a number`);
    return number;
  }
  const normalized = raw.trim().toLowerCase();
  if (["true", "yes", "active", "1"].includes(normalized)) return true;
  if (["false", "no", "inactive", "0"].includes(normalized)) return false;
  throw new Error(`Cannot parse ${JSON.stringify(raw)} as boolean`);
}
