export type PrimitiveType = "string" | "number" | "boolean";
export type ActionKind = "navigate" | "click" | "type" | "extract" | "wait";
export type Risk = "safe" | "risky";

export interface InputSpec {
  type: PrimitiveType;
  description: string;
  sensitive: boolean;
  required: boolean;
}

export interface OutputSpec {
  type: PrimitiveType;
  description: string;
  sourceStepId: string;
  sensitive: boolean;
}

export type LocatorStrategy =
  | { kind: "role"; role: string; name: string; exact: true }
  | { kind: "label"; label: string; exact: true }
  | { kind: "name"; name: string }
  | { kind: "text"; text: string; exact: true }
  | { kind: "table_cell"; rowLabel: string; column: number }
  | { kind: "css"; selector: string };

export interface TargetLocator {
  frameUrlPattern?: string;
  strategies: LocatorStrategy[];
  robustness: string;
}

export type ValueSource =
  | { source: "parameter"; name: string }
  | { source: "literal"; value: string };

export type Predicate =
  | { kind: "url_matches"; pattern: string }
  | { kind: "text_present"; text: string }
  | { kind: "element_visible"; target: TargetLocator };

export interface CapabilityStep {
  id: string;
  description: string;
  action: ActionKind;
  risk: Risk;
  target?: TargetLocator;
  value?: ValueSource;
  outputName?: string;
  outputType?: PrimitiveType;
  parser?: "text" | "number" | "currency" | "boolean";
  timeoutMs: number;
}

export type RecoveryAction =
  | { kind: "click"; target: TargetLocator }
  | { kind: "reload" }
  | { kind: "wait"; timeoutMs: number };

export type ExceptionRule =
  | {
      id: string;
      category: "business_outcome";
      whenTextPresent: string;
      code: string;
      message: string;
    }
  | {
      id: string;
      category: "recoverable";
      whenTextPresent: string;
      maxAttempts: number;
      recovery: RecoveryAction;
    }
  | {
      id: string;
      category: "hard_failure";
      whenTextPresent: string;
      code: string;
      message: string;
    };

export interface CapabilityArtifact {
  schemaVersion: "1.0";
  capability: {
    id: string;
    name: string;
    description: string;
    revision: number;
    approval: "draft" | "approved";
    recordedAt: string;
  };
  target: {
    adapter: "web";
    appId: string;
    baseOrigin: string;
    entryPath: string;
    vendorProduct: string;
    compatibleVersions: string[];
    tenantOverrides: Record<string, { locatorOverrides: Record<string, TargetLocator> }>;
  };
  contract: {
    inputs: Record<string, InputSpec>;
    outputs: Record<string, OutputSpec>;
    resultVariants: ["success", "business_outcome", "failure"];
  };
  policy: PolicyConfig;
  steps: CapabilityStep[];
  successCondition: Predicate;
  exceptionRules: ExceptionRule[];
  provenance: {
    discoveryRunId: string;
    modelProvider: string;
    model: string;
    rawTranscriptPersisted: false;
  };
}

export interface PolicyConfig {
  allowedOrigins: string[];
  allowedRoutePatterns: string[];
  allowedActions: ActionKind[];
  riskyControlPatterns: string[];
  blockedInputPatterns: string[];
  maxSteps: number;
  timeoutMs: number;
}

export interface ObservedElement {
  ref: string;
  kind: "control" | "readable";
  role: string;
  name: string;
  locator: TargetLocator;
  enabled: boolean;
}

export interface Observation {
  url: string;
  title: string;
  visibleText: string;
  elements: ObservedElement[];
  screenshotPath: string;
}

export type AgentDecision =
  | { action: "click"; targetRef: string; description: string; reason: string }
  | {
      action: "type";
      targetRef: string;
      valueTemplate: string;
      description: string;
      reason: string;
    }
  | {
      action: "extract";
      targetRef: string;
      outputName: string;
      outputType: PrimitiveType;
      parser: "text" | "number" | "currency" | "boolean";
      description: string;
      reason: string;
    }
  | { action: "wait"; timeoutMs: number; description: string; reason: string }
  | { action: "complete"; checkpoint: Predicate; reason: string }
  | { action: "escalate"; reason: string };

export interface StructuredLogEvent {
  timestamp: string;
  runId: string;
  phase: "discovery" | "replay" | "handoff";
  event: string;
  stepId?: string;
  data: Record<string, unknown>;
}

export type RunResult =
  | {
      status: "success";
      runId: string;
      outputs: Record<string, unknown>;
      checkpointVerified: true;
    }
  | {
      status: "business_outcome";
      runId: string;
      code: string;
      message: string;
      stepId: string;
      outputs: Record<string, never>;
    }
  | {
      status: "failure";
      runId: string;
      code: string;
      message: string;
      stepId?: string;
      expected?: unknown;
      observed?: unknown;
      evidencePath: string;
      interventionId?: string;
    };

export interface InterventionRequest {
  id: string;
  runId: string;
  capabilityId?: string;
  goal?: string;
  stepId?: string;
  reason: string;
  screenshotPath: string;
  observedUrl: string;
  control: "human";
  requestedAt: string;
}
