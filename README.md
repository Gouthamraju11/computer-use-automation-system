# Computer-Use Automation System

This repository is a focused end-to-end implementation of the assignment's core thread:

`natural-language goal -> LLM discovery on a live UI -> versioned capability -> deterministic replay -> structured result or human handoff`

The target is a local, intentionally old-fashioned member-servicing application: table layouts, sparse semantics, no test IDs, multi-step member lookup, and injected runtime outcomes. All records are synthetic.

## Setup

Requirements: Node.js 20+, npm, and Google Chrome or Chromium.

```bash
npm install
export CHROME_PATH="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
export OPENAI_API_KEY="your-key"
export OPENAI_MODEL="gpt-5-mini" # optional
npm run build
npm test
```

`CHROME_PATH` is optional on macOS when Chrome is installed at the path above. On Linux or Windows, pass `--chrome-path /path/to/chrome` to `discover` and `replay` if Chrome is elsewhere.

The key is used only during discovery. The saved capability replays with no model call. To run without any live model service, start the local target and run the replay command below against the checked-in artifact; `npm test` is also completely model-free.

## Demo path

Terminal 1 - start the local live UI:

```bash
npm run target
```

Terminal 2 - let the model discover the goal and save a capability:

```bash
npm run discover -- \
  --goal "Look up member 10001 and read their current savings balance" \
  --params '{"memberId":"10001"}' \
  --artifact evidence/capability.json \
  --run-dir evidence/discovery
```

Replay that artifact deterministically:

```bash
npm run replay -- \
  --artifact evidence/capability.json \
  --inputs '{"memberId":"10001"}' \
  --run-dir evidence/replay-success
```

Useful synthetic inputs exercise the required result classes:

```bash
# Recoverable session expiry, then success
npm run replay -- --artifact evidence/capability.json --inputs '{"memberId":"20002"}' --run-dir evidence/replay-recovered

# Expected business outcome (process exits normally)
npm run replay -- --artifact evidence/capability.json --inputs '{"memberId":"99999"}' --run-dir evidence/replay-not-found

# Hard permission failure plus intervention request (process exits 2)
npm run replay -- --artifact evidence/capability.json --inputs '{"memberId":"40300"}' --run-dir evidence/replay-denied
```

For an interactive handoff, add `--headed --interactive-handoff`. Automation pauses, leaves the same target Chrome session open for the operator, prints a local operator-console URL, records the operator's redacted DOM actions, and resumes only after the operator returns control.

The checked-in discovery evidence was produced by a real structured model CLI with `gpt-5.6-luna`, not the scripted test provider. The public default is the OpenAI Responses API; a compatible authenticated CLI can be supplied with `MODEL_CLI_PATH` and `--provider model-cli`.

## What to inspect

- `src/discovery.ts` owns the observe-decide-act loop and converts selected ephemeral refs into artifact steps.
- `src/surface.ts` is the browser perception/action adapter and locator resolver.
- `src/types.ts` is the artifact and result contract.
- `src/replay.ts` is the model-free executor and error taxonomy.
- `src/policy.ts` enforces origin, route, action, field, and risk policy on both paths.
- `src/handoff.ts` implements pause, intervention routing, same-session human control, action capture, and resume.
- `evidence/capability.json` is the reviewable capability produced by the live discovery.
- `evidence/*/events.jsonl` and `result.json` show discovery, success, recovery, business outcome, and hard failure.

Evidence files persist no raw model transcript, invocation-specific member number, or balance. Sensitive runtime values remain available to the caller in memory/stdout, while persisted results redact them. Screenshots mask input and table-value cells.
