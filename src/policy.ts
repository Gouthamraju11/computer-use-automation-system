import type { ActionKind, PolicyConfig, Risk, TargetLocator } from "./types.js";

export class PolicyViolation extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "PolicyViolation";
  }
}

export class PolicyEngine {
  constructor(readonly config: PolicyConfig) {}

  assertUrl(rawUrl: string): void {
    const url = new URL(rawUrl);
    if (!this.config.allowedOrigins.includes(url.origin)) {
      throw new PolicyViolation("ORIGIN_NOT_ALLOWED", `Origin ${url.origin} is not allowlisted`);
    }
    if (!this.config.allowedRoutePatterns.some((pattern) => new RegExp(pattern).test(url.pathname))) {
      throw new PolicyViolation("ROUTE_NOT_ALLOWED", `Route ${url.pathname} is not allowlisted`);
    }
  }

  assertAction(action: ActionKind): void {
    if (!this.config.allowedActions.includes(action)) {
      throw new PolicyViolation("ACTION_NOT_ALLOWED", `Action ${action} is not allowlisted`);
    }
  }

  assertInputTarget(locator: TargetLocator): void {
    const serialized = JSON.stringify(locator).toLowerCase();
    const blocked = this.config.blockedInputPatterns.find((pattern) => serialized.includes(pattern.toLowerCase()));
    if (blocked) {
      throw new PolicyViolation("SENSITIVE_FIELD_BLOCKED", `Typing into a ${blocked} field is blocked`);
    }
  }

  classify(action: ActionKind, locator?: TargetLocator): Risk {
    if (action !== "click" || locator === undefined) return "safe";
    const serialized = JSON.stringify(locator).toLowerCase();
    return this.config.riskyControlPatterns.some((pattern) =>
      serialized.includes(pattern.toLowerCase())
    )
      ? "risky"
      : "safe";
  }
}
