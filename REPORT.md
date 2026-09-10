# 1. Architecture

The system is one TypeScript process with deliberately narrow boundaries. The CLI starts either discovery or replay. `BrowserSurface` owns perception and UI actions; `DecisionProvider` owns the one-step LLM decision; `PolicyEngine` authorizes every navigation and action; the recorder builds a `CapabilityArtifact`; `replay` consumes that artifact without any decision provider; `HandoffCoordinator` owns pause/control/resume; and `RunLogger` persists redacted JSONL evidence. A local Node HTTP server supplies a safe, live legacy-style member-servicing target with synthetic data.

During discovery, the surface observes the current page, takes a masked screenshot, and enumerates visible controls and label-relative table values. It assigns short-lived refs such as `c1` and `r4`. The model receives the goal, runtime parameters, prior structured actions, current output state, and those refs. It returns exactly one schema-constrained action. The trusted adapter resolves the selected ref, executes it after a policy check, and records the ref's locator bundle rather than the raw model response. This separation is important: the model discovers intent, but trusted code decides what locator data is safe and reusable.

The implementation uses browser DOM/accessibility signals because they make a small working vertical slice possible, while the `Surface` boundary prevents discovery, replay, and handoff from depending on Playwright. The interface includes perception, actions, verification, lifecycle, and human-action capture; `BrowserSurface` is the concrete adapter. The local target uses tables and ordinary labels but no test IDs. This is a proxy for a stable legacy web application, not a claim that all bank surfaces expose a useful DOM. The trade-off is depth over breadth: one process and one concrete adapter make lifecycle, policy, and control ownership easy to audit.

# 2. Artifact schema

The JSON artifact is explicitly versioned (`schemaVersion: 1.0`) and reviewable. Its capability identity includes a stable ID, revision, description, draft/approved state, and recording time. Target metadata names the adapter, application, vendor product, compatible versions, base origin, entry path, and an empty seam for tenant locator overrides. Provenance names the discovery run and model while asserting that no raw transcript was persisted.

The contract declares typed, required inputs and typed outputs. Each field says whether it is sensitive. A type mismatch or undeclared parameter stops replay before the browser acts. The result contract is a three-way union: `success` with outputs, `business_outcome` with a domain code, or `failure` with step, expectation, observation, and evidence.

Each ordered step has an ID, plain-language purpose, action, risk class, timeout, optional parameter source, optional output parser, and a locator bundle. Locator strategies are ordered strongest to weakest: semantic role/name, associated label or stable HTML name, then structural CSS. Table values use `table_cell(rowLabel, column)`, which anchors “Savings balance” by its label rather than recording the member's runtime balance. A final checkpoint proves the goal state. Exception rules are artifact data so business outcomes, bounded recovery, and hard failures remain explicit and reviewable rather than hidden in control flow.

Discovery accepts a model-proposed checkpoint but canonicalizes it against stable text currently observed on the page and rejects invocation-specific or data-valued checkpoints. This prevents a model from turning a balance or member number into a brittle success assertion. The canonicalization decision is logged.

# 3. Determinism & error handling

Replay has no LLM dependency. It validates the artifact and input types, opens the recorded entry point, applies the allowlist, then executes the fixed step sequence. Each locator strategy must resolve to exactly one visible element before use; ambiguous or missing targets fail with the active step, expected action, observed page identity, and screenshot. Navigation is checked again after clicks. Extraction applies the recorded parser, and completion requires the saved checkpoint to be observable.

The artifact demonstrates three runtime categories. “No member found” returns `business_outcome/MEMBER_NOT_FOUND`; it is not a crash and should not be retried as one. “Session expired” is recoverable: replay clicks the recorded “Resume session” locator once, logs the recovery, rescans the page, and continues the same step. “Permission denied” is a hard failure: replay captures masked evidence and routes a human intervention. All other exceptions become a structured failure with the active step, expected condition when available, observed page identity, and failure screenshot. Recovery counts are bounded to prevent loops.

The current resolver handles the stable-UI/runtime-error assumption well. For drift, it tries ordered locator fallbacks but never uses fuzzy autonomous clicks. A production extension would record per-strategy success rates, compare a surface fingerprint before unattended replay, and require review when confidence falls below policy.

# 4. Heterogeneity & multi-tenant

The seam is the `Surface` interface: open, observe, click, type, extract, wait/reload, text detection, and checkpoint verification. The flow engine understands actions, predicates, and locator strategies, not Playwright pages. A legacy frameset adapter can use the existing optional frame URL pattern and add image/coordinate or OCR-anchored strategies. A desktop adapter would map role/name strategies to the OS accessibility tree and add window/process identity. The artifact's adapter discriminator lets validation reject strategies a surface cannot support.

For tenant reuse, the vendor-level artifact should remain the base capability. Target metadata already carries `vendorProduct`, compatible versions, and a `tenantOverrides` map. In production, each tenant binding would supply origin, authentication/session policy, locale, and only the locator or outcome overrides that differ. The base steps and typed contract stay shared. A preflight fingerprint (vendor version plus stable landmarks) and replay telemetry would detect drift; compatible changes update a tenant override, while vendor-wide changes create a new artifact revision. Approved revisions remain immutable so a broken update can be rolled back and audited.

This project does not implement the tenant registry or desktop adapter because Section 3.7 asks for a credible design, not that infrastructure. The current types reserve the boundary without pretending the unsupported surfaces already work.

# 5. Escalation & handoff

Discovery can escalate when the model reports ambiguity or when policy classifies the selected control as risky. Replay escalates on hard application states, exhausted/unknown errors, and risky recorded steps. The intervention record carries run/capability/goal identity as applicable, current step, reason, masked screenshot, redacted current URL, time, and the fact that control belongs to the human.

Interactive handoff is real but minimal. Automation awaits a promise and performs no UI actions while the human owns control. The original headed Chrome page remains open; the operator acts in that exact session. A local operator page explains the stop and exposes the “Return control to automation” signal. Capture listeners record click targets and input events from the live page, with input values always replaced by `[REDACTED]`; init-script registration preserves capture across navigation. On resume, ownership is logged as automation. Replay rescans the current page before continuing, so it does not assume the human produced a particular state. If the block remains, it returns a failure instead of looping.

In noninteractive environments, the same mechanism writes the intervention request and returns `INTERVENTION_REQUIRED` or the specific hard-failure result. The integration suite drives a replay through pause, human ownership, a captured action in the same page, return of control, checkpoint verification, and successful completion. The operator console is intentionally unauthenticated and localhost-only; a production version needs operator authentication, session brokering, an expiring control lease, and an append-only audit trail.

# 6. Safety

Policy is explicit JSON. It allowlists origins, route patterns, and action types on both discovery and replay. Typing into configured secret/password/SSN-like fields is blocked. Click targets matching irreversible patterns such as “close account,” “delete,” or “send payment” are classified as risky and are never executed unattended; the human must perform the step. Replay recomputes effective risk from the saved locator and current artifact policy, with a recorded `risky` classification acting as a one-way safety floor, so changing a step to `safe` cannot bypass intervention.

Artifacts store parameter references rather than invocation values. Model-written descriptions are parameterized before saving. Input and output contracts mark sensitive fields. Logs redact known invocation values, credentials/tokens, account-like numbers, emails, SSNs, and money; full visible text is represented by length and SHA-256 rather than persisted raw. Readable element logs retain their stable labels but replace values. Persisted result files redact sensitive outputs, while the in-memory caller result can still carry the requested value. Screenshots mask form fields and table data.

The main limit is policy expressiveness. Text-pattern risk classification is transparent and safe for this target, but production financial actions need institution-owned semantic policy (amount thresholds, dual control, account class, operator entitlements), encrypted evidence storage with retention limits, and explicit approval tokens rather than a local resume button.

# 7. Cuts

I deliberately did not build queues, distributed workers, a capability catalog/API, code generation, automatic LLM fallback during replay, multi-run scoring, desktop automation, a tenant registry, or a production co-browsing console. Those are either stretch goals or infrastructure around the evaluated core.

With more time, the next work would be: harden the operator channel with authenticated expiring leases; add a surface fingerprint and artifact approval workflow; implement per-tenant binding/override resolution; add an accessibility-tree desktop adapter; and run repeated replay stability measurements. I would not add model recovery to replay until policy, approval, and audit boundaries were strong enough to keep that recovery narrowly bounded.
