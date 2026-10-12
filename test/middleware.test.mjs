import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { onRequest, onEvent, onResponse } from "../opendesign-compatible-fix.middleware.js";

function run(body, protocol = "anthropic", options = {}) {
  const ctx = { protocol, options, model: body?.model, reject(status, message) { return { rejected: true, status, message }; } };
  const out = onRequest(body, ctx);
  return out === undefined ? body : out;
}
const responses = (fields = {}) => ({ model: "opendesign/claude-haiku-5.5", input: "hello", max_output_tokens: 1024, ...fields });
const request = (fields = {}) => ({ model: "opendesign/claude-haiku-5.5", messages: [{ role: "user", content: "hello" }], ...fields });

// ---- model matching ---------------------------------------------------------
for (const model of ["claude-haiku-5-5", "claude-haiku-5.5", "haiku5.5", "remote-magpie/opendesign/claude-haiku-5.5", "anthropic.claude-haiku-5-5", "relay/anthropic/claude-haiku-5-5", "claude-haiku-5-5-20261001"]) {
  test(`matches ${model}`, () => {
    const body = responses({ model, reasoning: { effort: "low" } });
    run(body, "responses");
    assert.equal(body.output_config.effort, "low");
    assert.equal("reasoning" in body, false);
  });
}

for (const model of ["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5", "group/auto", "some-haiku-5-5-other"]) {
  test(`leaves ${model} untouched`, () => {
    const body = responses({ model, reasoning: { effort: "low" } });
    const before = structuredClone(body);
    run(body, "responses");
    assert.deepEqual(body, before);
  });
}

// ---- the reported fix: Responses asks in output_config ------------------------
test("Responses moves reasoning.effort to output_config.effort", () => {
  const body = responses({ reasoning: { effort: "high", summary: "auto" } });
  run(body, "responses");
  assert.deepEqual(body.output_config, { effort: "high" });
  assert.equal("reasoning" in body, false);
  assert.equal("thinking" in body, false);
});

test("Responses honors output_config.effort already present", () => {
  const body = responses({ output_config: { effort: "max", format: { type: "json_schema", schema: {} } } });
  run(body, "responses");
  assert.equal(body.output_config.effort, "max");
  assert.deepEqual(body.output_config.format, { type: "json_schema", schema: {} });
});

test("Responses accepts the client's thinking budget as an effort", () => {
  const body = responses({ thinking: { type: "enabled", budget_tokens: 16000 } });
  run(body, "responses");
  assert.equal("thinking" in body, false);
  assert.equal(body.output_config.effort, "medium");
});

test("Responses maps minimal to low and ultra to max", () => {
  assert.equal(run(responses({ reasoning: { effort: "minimal" } }), "responses").output_config.effort, "low");
  assert.equal(run(responses({ reasoning: { effort: "ultra" } }), "responses").output_config.effort, "max");
  assert.equal(run(responses({ reasoning: { effort: "HIGH" } }), "responses").output_config.effort, "high");
});

test("Responses defaults to medium when the client asks nothing", () => {
  assert.equal(run(responses(), "responses").output_config.effort, "medium");
});

test("Responses keeps every other field", () => {
  const body = responses({ reasoning: { effort: "high" }, input: [{ type: "message", role: "user", content: "hi" }], tools: [{ type: "function", name: "f" }], tool_choice: "auto", store: false, stream: true, max_output_tokens: 4096, include: ["reasoning.encrypted_content"] });
  const before = structuredClone(body);
  run(body, "responses");
  for (const key of ["input", "tools", "tool_choice", "store", "stream", "max_output_tokens", "include", "model"]) assert.deepEqual(body[key], before[key]);
});

test("Responses disabled mode asks with no reasoning at all", () => {
  for (const options of [{ mode: "disabled" }]) {
    const body = responses({ reasoning: { effort: "high" } });
    run(body, "responses", options);
    assert.equal("reasoning" in body, false);
    assert.equal("output_config" in body, false);
  }
  const off = run(responses({ reasoning: { effort: "none" } }), "responses");
  assert.equal("output_config" in off, false);
});

test("operator override wins over the client's effort", () => {
  const body = responses({ reasoning: { effort: "low" } });
  run(body, "responses", { effort: "max" });
  assert.equal(body.output_config.effort, "max");
  assert.equal(run(responses(), "responses", { defaultEffort: "xhigh" }).output_config.effort, "xhigh");
});

// ---- Codex tool-search history ----------------------------------------------
const HISTORY = [
  { type: "tool_search_call", id: "tsc_1", call_id: "call_1", status: "completed", execution: "client", arguments: { query: "serena", limit: 1 } },
  { type: "tool_search_output", id: "tso_1", call_id: "call_1", status: "completed", execution: "client", tools: [{ type: "function", name: "initial_instructions" }] },
];

test("rewrites client tool-search history to function calls for a relay", () => {
  const body = responses({ reasoning: { effort: "low" }, input: [{ type: "message", role: "user", content: "hi" }, ...structuredClone(HISTORY)] });
  run(body, "responses");
  assert.deepEqual(body.input[1], { type: "function_call", call_id: "call_1", name: "tool_search", arguments: '{"query":"serena","limit":1}' });
  assert.deepEqual(body.input[2], { type: "function_call_output", call_id: "call_1", output: '[{"type":"function","name":"initial_instructions"}]' });
});

test("rewrites tool-search history for any relay model, not only Haiku", () => {
  const body = { model: "opendesign/gpt-6-luna", input: [{ type: "message", role: "user", content: "hi" }, ...structuredClone(HISTORY)], reasoning: { effort: "low" } };
  run(body, "responses");
  assert.equal(body.input[1].type, "function_call");
  assert.equal(body.input[2].type, "function_call_output");
  assert.deepEqual(body.reasoning, { effort: "low" });
});

test("leaves server-executed search and the ChatGPT backend alone", () => {
  const server = responses({ input: [{ type: "tool_search_call", execution: "server", call_id: "c", arguments: { query: "q" } }] });
  run(server, "responses");
  assert.equal(server.input[0].type, "tool_search_call");

  for (const model of ["codex/gpt-6.1-sol", "gpt-6.1-sol"]) {
    const native = { model, input: structuredClone(HISTORY), reasoning: { effort: "low" } };
    const before = structuredClone(native);
    run(native, "responses");
    assert.deepEqual(native, before);
  }
});

test("toolSearchHistory can be turned off", () => {
  const body = responses({ input: structuredClone(HISTORY) });
  run(body, "responses", { toolSearchHistory: false });
  assert.equal(body.input[0].type, "tool_search_call");
});

// ---- other protocols keep working without thinking ---------------------------
for (const protocol of ["anthropic", "chat"]) {
  test(`${protocol} turns thinking off instead of sending a refused block`, () => {
    const body = request({ thinking: { type: "enabled", budget_tokens: 16000 }, output_config: { effort: "high" }, reasoning_effort: "high" });
    run(body, protocol);
    assert.equal(body.thinking.type, "disabled");
    assert.equal("budget_tokens" in body.thinking, false);
    assert.equal("output_config" in body, false);
    assert.equal("reasoning" in body, false);
    assert.equal("reasoning_effort" in body, false);
  });
}

test("removes unsupported sampling, with opt-out", () => {
  const body = responses({ reasoning: { effort: "low" }, temperature: 0.8, top_p: 0.9, top_k: 10 });
  run(body, "responses");
  assert.equal("temperature" in body, false);
  assert.equal("top_p" in body, false);
  assert.equal("top_k" in body, false);
  const keep = responses({ reasoning: { effort: "low" }, temperature: 0.8 });
  run(keep, "responses", { removeSampling: false });
  assert.equal(keep.temperature, 0.8);
});

// ---- options and edges -------------------------------------------------------
test("rejects invalid matching-model options", () => {
  for (const options of [{ mode: "oops" }, { effort: "impossible" }, { defaultEffort: "none" }, { defaultEffort: 20 }]) {
    assert.equal(run(responses(), "responses", options).status, 400);
  }
  assert.equal(run({ model: "gpt-6", reasoning: { effort: "low" } }, "responses", { mode: "oops" }).model, "gpt-6");
});

test("is idempotent and does not share state", () => {
  const body = run(responses({ reasoning: { effort: "high" } }), "responses");
  const once = structuredClone(body);
  onRequest(body, { protocol: "responses", options: {}, model: body.model });
  assert.deepEqual(body, once);
  assert.equal(run(responses(), "responses").output_config.effort, "medium");
});

test("handles non-object requests and unknown protocols", () => {
  assert.equal(onRequest(null, {}), null);
  assert.equal(onRequest("text", {}), "text");
  const body = request();
  const before = structuredClone(body);
  assert.deepEqual(onRequest(body, { protocol: "gemini", options: {} }), before);
});

test("package is middleware-only and ships the file it declares", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  assert.equal(pkg.main, undefined);
  assert.equal(pkg.exports, undefined);
  assert.equal(pkg.dependencies, undefined);
  assert.ok((await readFile(new URL(`../${pkg.magpie.middleware}`, import.meta.url), "utf8")).includes("export function onRequest"));
});

test("folds doubled DSML bars into a chat tool call", () => {
  const bar = "｜";
  const ctx = { state: {} };
  const first = { choices: [{ delta: { content: "<" + bar + bar + "DSML" + bar + bar + "tool_calls><" + bar + bar + "DSML" + bar + bar + "invoke" } }] };
  assert.equal(onEvent(first, ctx).choices[0].delta.content, "");
  const second = { choices: [{ delta: { content: " name=\"exec_command\"><" + bar + bar + "DSML" + bar + bar + "parameter name=\"cmd\" string=\"true\">echo ok</" + bar + bar + "DSML" + bar + bar + "parameter></" + bar + bar + "DSML" + bar + bar + "invoke></" + bar + bar + "DSML" + bar + bar + "tool_calls>" } }] };
  const event = onEvent(second, ctx);
  assert.equal(event.choices[0].finish_reason, "tool_calls");
  assert.equal(event.choices[0].delta.tool_calls[0].function.name, "exec_command");
  assert.equal(event.choices[0].delta.tool_calls[0].function.arguments, JSON.stringify({ cmd: "echo ok" }));
  const body = { choices: [{ message: { content: "<" + bar + bar + "DSML" + bar + bar + "tool_calls><" + bar + bar + "DSML" + bar + bar + "invoke name=\"exec_command\"><" + bar + bar + "DSML" + bar + bar + "parameter name=\"cmd\" string=\"true\">echo ok</" + bar + bar + "DSML" + bar + bar + "parameter></" + bar + bar + "DSML" + bar + bar + "invoke></" + bar + bar + "DSML" + bar + bar + "tool_calls>" } }] };
  onResponse(body);
  assert.equal(body.choices[0].message.tool_calls[0].function.name, "exec_command");
  assert.equal(body.choices[0].message.tool_calls[0].function.arguments, JSON.stringify({ cmd: "echo ok" }));
});
