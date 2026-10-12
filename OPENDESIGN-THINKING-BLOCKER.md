# Open Design Haiku 5.5 thinking: the fix, and where it stops

The middleware now repairs the reported failure **through the Responses path**,
which is the path Codex and the other OpenAI-shaped agents use. It no longer
needs Open Design to change anything.

## What the relay does

Measured directly against `https://amr-link.open-design.ai/v1` (2026-10-11),
model id `claude-haiku-5.5`:

| Request | Result |
| --- | --- |
| Messages, `thinking.type: adaptive` (+ `display`, + `output_config.effort`) | HTTP 400, `"thinking.type.enabled" is not supported for this model` |
| Messages, `thinking.type: enabled` + `budget_tokens` | HTTP 400, the same |
| Messages, `output_config.effort` alone | HTTP 200 |
| Responses, `reasoning: {effort}` (any effort, with or without `summary`) | HTTP 400, the same `enabled` error |
| Responses, `output_config.effort` alone | HTTP 200, thinking item returned with a signature |
| Responses, `thinking.type: adaptive` | HTTP 200 (its native field, not OpenAI's) |

So the relay refuses *any* OpenAI `reasoning` object and *any* Anthropic
`thinking` block, but takes `output_config.effort` and thinks from it. Its
error text names `enabled` because its own translator turns whatever it is
given back into that field.

## What the middleware does

- **Responses** (Codex, the OpenAI SDK, anything speaking `/v1/responses`):
  `reasoning.effort` (or the client's `output_config.effort`, or a
  `thinking.budget_tokens`) is rewritten to `output_config.effort`, and the
  `reasoning` / `thinking` fields are dropped before the relay sees them.
  Thinking is preserved and the effort is carried.
- **Anthropic `/v1/messages` and Chat `/v1/chat/completions`**: Magpie rebuilds
  these into the `reasoning` object the relay refuses, and it drops a client's
  `output_config` in that rebuild. No request-level middleware can affect the
  rebuilt body, so these keep working with thinking off.

## Codex tool-search history

Compaction drops the `tool_search` declaration and leaves `tool_search_call` /
`tool_search_output` items. The relay mis-serializes their `arguments` object
and answers `Invalid type for 'input[1].arguments': expected an object, but got
a string instead`. The middleware rewrites those items (client execution only)
as the `function_call` / `function_call_output` pair the relay reads.

## Boundary

The middleware runs on the request the agent sends. Magpie's own
`compaction_trigger` summary turn is made by `s.serve`, which does not pass
through gateway middleware, so a compaction summary that carries this history
is still made by Open Design upstream and can still fail; Magpie falls back to
its local summary. A normal turn that carries the history is repaired.
