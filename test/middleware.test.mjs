import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { onRequest } from "../haiku55.middleware.js";

function run(body, protocol = "anthropic", options = {}) {
  const ctx = { protocol, options, model: body?.model, reject(status, message) { return { rejected: true, status, message }; } };
  return onRequest(body, ctx);
}
const request = (fields = {}) => ({ model: "opendesign/claude-haiku-5.5", messages: [{ role: "user", content: "hello" }], ...fields });

test("migrates the reported enabled/budget_tokens request and preserves output format", () => {
  const body = request({ thinking: { type: "enabled", budget_tokens: 16000, display: "summarized" }, output_config: { format: { type: "json_schema", schema: {} }, effort: "high" }, max_tokens: 32000, stream: true });
  const messages = body.messages;
  run(body);
  assert.deepEqual(body.thinking, { type: "adaptive", display: "summarized" });
  assert.equal(body.output_config.effort, "high");
  assert.equal(body.output_config.format.type, "json_schema");
  assert.equal(body.messages, messages);
  assert.equal(body.max_tokens, 32000);
  assert.equal(body.stream, true);
});

for (const model of ["claude-haiku-5-5", "claude-haiku-5.5", "haiku5.5", "remote-magpie/opendesign/claude-haiku-5.5", "anthropic.claude-haiku-5-5", "relay/anthropic/claude-haiku-5-5", "claude-haiku-5-5-20261001"]) {
  test(`matches ${model}`, () => {
    const body = run({ model, thinking: { type: "enabled", budget_tokens: 1024 } });
    assert.equal(body.thinking.type, "adaptive");
    assert.equal(body.output_config.effort, "medium");
    assert.equal("budget_tokens" in body.thinking, false);
  });
}

for (const model of ["claude-haiku-4-5", "claude-sonnet-5-5", "claude-opus-5-5", "claude-haiku-5-50", "claude-haiku-15-5", "group/auto", "some-haiku-5-5-other", "my-claude-haiku-5-5"]) {
  test(`leaves ${model} untouched`, () => {
    const body = { model, thinking: { type: "enabled", budget_tokens: 1024 }, temperature: 0.3 };
    const before = structuredClone(body);
    assert.equal(run(body), body);
    assert.deepEqual(body, before);
  });
}

test("accepts explicit exact model aliases and uses a preceding model-map rewrite", () => {
  assert.equal(run({ model: "fast" }, "anthropic", { models: ["fast"] }).thinking.type, "adaptive");
  const body = { model: "claude-sonnet-5-5" };
  onRequest(body, { protocol: "anthropic", model: "claude-haiku-5-5", options: {} });
  assert.deepEqual(body, { model: "claude-sonnet-5-5" });
});

for (const [value, expected] of [["low", "low"], ["medium", "medium"], ["high", "high"], ["xhigh", "xhigh"], ["max", "max"], ["minimal", "low"], ["ultra", "max"], ["HIGH", "high"]]) {
  test(`maps Responses ${value} to ${expected}`, () => {
    const body = run(request({ reasoning: { effort: value, summary: "auto" } }), "responses");
    assert.deepEqual(body.reasoning, { effort: expected, summary: "auto" });
    assert.equal("thinking" in body, false);
  });
}

test("Chat sets native effort and Anthropic relay extensions consistently", () => {
  const body = run(request({ reasoning_effort: "ultra", thinking: { type: "enabled", budget_tokens: 32768 } }), "chat");
  assert.equal(body.reasoning_effort, "max");
  assert.deepEqual(body.thinking, { type: "adaptive" });
  assert.deepEqual(body.output_config, { effort: "max" });
});

test("operator override, protocol-native effort and default have documented precedence", () => {
  assert.equal(run(request({ output_config: { effort: "high" } }), "anthropic", { effort: "low" }).output_config.effort, "low");
  assert.equal(run(request({ output_config: { effort: "high" }, reasoning_effort: "low" })).output_config.effort, "high");
  assert.equal(run(request({ output_config: { effort: "high" }, reasoning_effort: "low" }), "chat").output_config.effort, "low");
  assert.equal(run(request(), "anthropic", { defaultEffort: "xhigh" }).output_config.effort, "xhigh");
});

for (const protocol of ["anthropic", "chat", "responses"]) {
  test(`disabled mode stays off in ${protocol}`, () => {
    const body = run(request({ thinking: { type: "enabled", budget_tokens: 16000 }, reasoning: { effort: "max", summary: "auto" }, reasoning_effort: "max", output_config: { effort: "max" } }), protocol, { mode: "disabled" });
    assert.equal(body.thinking.type, "disabled");
    assert.equal("budget_tokens" in body.thinking, false);
    if (protocol === "responses") assert.equal(body.reasoning, undefined);
    else assert.equal(body.output_config.effort, "low");
    if (protocol === "chat") assert.equal(body.reasoning_effort, undefined);
  });
}

test("honors explicit off and clamps incompatible disabled effort", () => {
  assert.equal(run(request({ thinking: { type: "disabled" }, output_config: { effort: "max" } })).output_config.effort, "high");
  assert.deepEqual(run(request({ reasoning_effort: "none" }), "chat").thinking, { type: "disabled" });
  assert.equal(run(request({ reasoning: { effort: "none" } }), "responses").reasoning.effort, "none");
});

test("removes unsupported sampling, with opt-out", () => {
  const body = request({ temperature: 0.8, top_p: 0.9, top_k: 10 });
  run(body);
  assert.equal("temperature" in body, false);
  assert.equal("top_p" in body, false);
  assert.equal("top_k" in body, false);
  assert.equal(run(request({ temperature: 0.8 }), "chat", { removeSampling: false }).temperature, 0.8);
});

test("preserves tools, signatures, history, output limits and model routing", () => {
  const body = request({ messages: [{ role: "assistant", content: [{ type: "thinking", thinking: "history", signature: "opaque" }, { type: "tool_use", id: "t1", name: "lookup", input: {} }] }, { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "result" }] }], tools: [{ name: "lookup", input_schema: { type: "object" } }], tool_choice: { type: "auto" }, max_tokens: 8192 });
  const before = structuredClone(body);
  run(body);
  for (const key of Object.keys(before)) assert.deepEqual(body[key], before[key]);
});

test("is idempotent and does not share request state", () => {
  const body = run(request({ output_config: { effort: "high" } }));
  const once = structuredClone(body);
  run(body);
  assert.deepEqual(body, once);
  assert.equal(run(request()).output_config.effort, "medium");
});

test("rejects invalid matching-model options instead of a fail-open hook exception", () => {
  for (const options of [{ mode: "oops" }, { effort: "impossible" }, { defaultEffort: "none" }, { defaultEffort: 20 }]) assert.equal(run(request(), "anthropic", options).status, 400);
  assert.equal(run({ model: "gpt-6" }, "chat", { mode: "oops" }).model, "gpt-6");
});

test("handles missing options, non-object requests and unknown protocols", () => {
  assert.equal(onRequest(null, {}), null);
  assert.equal(onRequest("text", {}), "text");
  assert.equal(onRequest(request(), { protocol: "anthropic" }).thinking.type, "adaptive");
  const body = request();
  assert.deepEqual(run(body, "gemini"), { ...body });
  assert.equal("thinking" in body, false);
});

test("package is middleware-only and ships the file it declares", async () => {
  const pkg = JSON.parse(await readFile(new URL("../package.json", import.meta.url)));
  assert.equal(pkg.main, undefined);
  assert.equal(pkg.exports, undefined);
  assert.equal(pkg.dependencies, undefined);
  assert.ok((await readFile(new URL(`../${pkg.magpie.middleware}`, import.meta.url), "utf8")).includes("export function onRequest"));
});
