import assert from "node:assert/strict";
import test from "node:test";
import { assertInputs, parseOutput } from "../src/artifact.js";
import { PolicyEngine, PolicyViolation } from "../src/policy.js";
import type { CapabilityArtifact, PolicyConfig, TargetLocator } from "../src/types.js";

const policy: PolicyConfig = {
  allowedOrigins: ["http://127.0.0.1:4173"],
  allowedRoutePatterns: ["^/$", "^/member/[0-9]+$"],
  allowedActions: ["navigate", "click", "type", "extract", "wait"],
  riskyControlPatterns: ["close account"],
  blockedInputPatterns: ["password", "ssn"],
  maxSteps: 10,
  timeoutMs: 30_000
};

test("policy rejects routes, risky controls, and sensitive fields", () => {
  const engine = new PolicyEngine(policy);
  assert.throws(() => engine.assertUrl("https://example.com/"), PolicyViolation);
  assert.throws(() => engine.assertUrl("http://127.0.0.1:4173/admin"), PolicyViolation);
  const risky: TargetLocator = {
    strategies: [{ kind: "role", role: "button", name: "Close account", exact: true }],
    robustness: "semantic"
  };
  assert.equal(engine.classify("click", risky), "risky");
  assert.throws(
    () => engine.assertInputTarget({ strategies: [{ kind: "name", name: "password" }], robustness: "name" }),
    PolicyViolation
  );
});

test("output parsing has explicit typed behavior", () => {
  assert.equal(parseOutput("$4,321.09", "number", "currency"), 4321.09);
  assert.equal(parseOutput("Active", "boolean", "boolean"), true);
  assert.throws(() => parseOutput("not a number", "number", "number"));
});

test("input contract rejects missing, mistyped, and undeclared inputs", () => {
  const artifact = {
    contract: {
      inputs: {
        memberId: { type: "string", description: "member", sensitive: true, required: true }
      }
    }
  } as unknown as CapabilityArtifact;
  assert.doesNotThrow(() => assertInputs(artifact, { memberId: "10001" }));
  assert.throws(() => assertInputs(artifact, {}), /Missing required input/);
  assert.throws(() => assertInputs(artifact, { memberId: 10001 }), /must be string/);
  assert.throws(() => assertInputs(artifact, { memberId: "10001", extra: true }), /Unknown input/);
});
