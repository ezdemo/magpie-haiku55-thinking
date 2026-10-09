# Validation — 2026-10-09

**The user's required outcome, preserving thinking with automatic conversion, remains blocked.** A subsequent independent acceptance test bypassed Magpie entirely: all three official OpenDesign protocols returned HTTP 400 at high effort, with no reasoning evidence. See [the direct reproduction](./OPENDESIGN-THINKING-BLOCKER.md) and `npm run test:thinking:live`. The successful disabled-mode checks below are not evidence that this requirement is fulfilled.

Environment: Windows, Node.js v24.13.1, Magpie CLI v0.1.1137.
Magpie binary SHA-256: `22f6e6a0cf84de16ea0d155cb362e7b4f701f1e579cfe48faf18e440572700a1`.

## Local checks

- `npm run check`: passed.
- `npm test`: 37 passed, 0 failed.
- `npm pack --dry-run`: middleware file, package manifest, README, validation record and license included; no dependencies or build required.
- Packaged middleware loaded by Magpie's actual moejs engine: passed.
- Anthropic native `enabled` → `adaptive`, effort preserved: passed with both streaming and non-streaming replies.
- Chat `ultra` → `max`, native relay extensions: passed.
- Plugin Options hot reload from adaptive to disabled: passed.
- Disabled compatibility: three agent protocols × two upstream protocols (Anthropic and Chat), six mock gateway cases passed.

## Live OpenDesign

Host: `https://amr-link.open-design.ai`. Model ID returned by its catalog: `claude-haiku-5.5`.
All requests were short smoke checks. No account credentials, identifiers, conversations or raw responses are stored here.

| Request | Result |
| --- | --- |
| Direct Messages with legacy `thinking.type: enabled` | HTTP 400, same unsupported-thinking error as reported |
| Direct Messages with `thinking.type: adaptive`, `output_config.effort: low`, `max_tokens: 1024` | HTTP 400, still reported `thinking.type.enabled` |
| Direct Chat with `reasoning_effort: low` | HTTP 502 during the diagnostic checks |
| Direct Chat with `reasoning_effort: none` | HTTP 200, visible text |
| Direct Messages with `thinking.type: disabled`, effort low | HTTP 200, visible text |
| Packaged disabled middleware: Messages → Magpie → Chat → OpenDesign | HTTP 200, visible text |
| Packaged disabled middleware: Chat → Magpie → Chat → OpenDesign | HTTP 200, visible text |
| Packaged disabled middleware: Responses → Magpie → Chat → OpenDesign | HTTP 200, visible text |

The final three checks used `node scripts/test-gateway.mjs --live`. They exercise the real packaged middleware and actual Magpie conversion, not only a standalone function.

The standard adaptive mode is verified for request normalization and supported mock paths. It is **not** a verified fix for OpenDesign's server-side adaptive conversion. Disabled mode removes the incompatible reasoning controls as a temporary workaround; it does not restore adjustable reasoning, and omitted controls may leave a model's own default thinking behavior in effect.

Re-run live tests after upstream updates; service behavior can change. This file is a dated record, not an ongoing availability guarantee.
