# Validation — 2026-10-11

Environment: macOS (Apple Silicon), Node.js v22.23.1, the pristine official
Magpie **v0.1.1185** (`/Applications/magpie.app`, binary sha256
`29d03009ea2a43417feb729be15a7db9383acc5c1cd9f7fed072b44140877696`), the
`opencode-opendesign-auth` provider plugin, and this middleware installed from
the working tree. No change was made to the Magpie binary or its configuration.

## Local checks

- `node --check opendesign-compatible-fix.middleware.js`: passed.
- `node --test test/*.test.mjs`: **31 passed, 0 failed** — model matching,
  the Responses `reasoning` -> `output_config` rewrite, effort mapping and
  override precedence, disabled mode, sampling removal, the tool-search
  history rewrite (client items only, any relay model), the ChatGPT/codex
  skip, idempotence, option validation, and non-object/unknown-protocol edges.

## Upstream behavior measured directly

`https://amr-link.open-design.ai/v1`, model `claude-haiku-5.5`, 2026-10-11:

| Request | Result |
| --- | --- |
| Messages `thinking: adaptive` (with or without `display`/`output_config`) | 400, `"thinking.type.enabled" is not supported` |
| Messages `thinking: enabled` + `budget_tokens` | 400, same |
| Messages `output_config.effort` alone | 200 |
| Responses `reasoning: {effort}` (low/medium/high, with or without `summary`) | 400, same |
| Responses `output_config.effort` alone | 200, a signed reasoning item comes back |
| Responses `thinking: {type: adaptive}` | 200 (its native field) |
| Responses with client `tool_search_call`/`tool_search_output` items | 400, `Invalid type for 'input[1].arguments': expected an object, but got a string instead` |
| The same history rewritten as `function_call`/`function_call_output` | 200 |

`reasoning.effort=none` and `reasoning.summary=auto` alone both returned 200,
so the offending field is a non-empty `reasoning.effort`.

## Live verification on the running raw Magpie + this middleware

`verify_final.py` -> `verify-final.json`, 17 checks, all HTTP 200:

- Haiku 5.5 via `/v1/responses` and `/backend-api/codex/responses` at every
  effort (`low`, `medium`, `high`, `xhigh`, `max`): each returned a
  `reasoning` output item, so thinking is preserved.
- Anthropic `/v1/messages` with `thinking: enabled` and with
  `thinking: adaptive`: 200 (thinking off, since Magpie rebuilds these).
- Chat `/v1/chat/completions` with `reasoning_effort: high`: 200.
- Codex client tool-search history on a normal turn, for
  `opendesign/gpt-6-luna`, `opendesign/deepseek-v4.1-flash`,
  `opendesign/claude-haiku-5.5`, and `group/auto-gpt-6-1-sol`: 200.

With the middleware **off**, the same Haiku reasoning request failed
(502 origin error during the run; the 400 `thinking.type.enabled` and the 400
`input[1].arguments` are the recorded steady-state failures), and the same
tool-search history returned 400 `input[1].arguments`. This is the control.

## Boundary

- Magpie's own `compaction_trigger` summary turn is made by `s.serve`, which
  does not run gateway middleware, so that specific summary request still goes
  to Open Design unmodified and Magpie falls back to its local summary. Every
  other request the agent makes passes through the middleware and is repaired.
- The Anthropic and Chat client protocols cannot carry thinking to this relay
  from request middleware: Magpie rebuilds those bodies and drops a client's
  `output_config`. They run with thinking off instead of failing.


## DeepSeek doubled-bar DSML — 2026-10-11

Live gateway test on raw Magpie 0.1.1185, model pin `opendesign/deepseek-v4.1-flash: chat`:

- One complete native `<｜DSML｜...>` chunk, with `<tool_call>` directly before it: HTTP 200 and a real `tool_calls` delta (`exec_command`, arguments `{"cmd":"echo ok"}`, finish `tool_calls`).
- The same doubled-bar block split into 7-character SSE chunks: the reloaded middleware buffers every fragment, then emits one Chat `tool_calls` delta. HTTP 200; name `exec_command`; arguments `{"cmd":"echo ok"}`; finish `tool_calls`; no DSML text remains. All 32 plugin tests pass.
- Temporary provider `dsmldouble` and the local mock servers on ports 51286-51290 were removed after the test. The Chat pin and provider sign-ins remain.

## DSML text preservation and Magpie 0.1.1211 retest — 2026-10-12

Environment: macOS (Apple Silicon), Node.js v22.23.1, official Magpie
**v0.1.1211** at `/Applications/magpie.app` (binary sha256
`8139263454d8f7f27a26bf072826066c6ae69166f2eb37dd35b9a0d4038b19b0`). The app
binary and production `settings.json`, `providers.json`, and `plugins.json`
were not changed. All live checks used isolated `HOME`, `XDG_CONFIG_HOME`,
`XDG_CACHE_HOME`, fake provider keys, and local mock upstreams.

The DSML response parser now changes text only when a complete DSML block
contains a tool invocation. Incomplete prefixes are buffered and released if
they are not DSML or when the stream finishes. The hooks run for a known
DeepSeek model or an unknown model, but a known non-DeepSeek model is left
byte-identical even when its content contains DSML.

Checks against the installed plugin:

- `node --check` on the middleware, unit tests, and gateway script: passed.
- `node --test test/*.test.mjs`: **41 passed, 0 failed**, including plain
  non-streaming and streaming text, non-DeepSeek controls, whole and split
  DSML chunks, mixed text, and incomplete blocks.
- `MAGPIE_BIN=/path/to/magpie MAGPIE_NO_ACCOUNTS=1 node scripts/test-gateway.mjs`:
  **16/16 passed**. Native Messages and Chat now assert the current
  `thinking.type=disabled` behavior rather than the stale adaptive assertion.
- Real isolated ON/OFF harness: **96 requests, 48 per state; all 48 plugin-ON
  content checks passed**. All five original fixes still fail OFF and pass ON,
  so none was dropped. Plugin-ON Chat controls return `OK` or the exact plain
  split text instead of empty content.

The plugin was left enabled. No optional live Open Design request was made.
