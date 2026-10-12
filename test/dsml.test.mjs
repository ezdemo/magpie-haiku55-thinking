import test from "node:test";
import assert from "node:assert/strict";
import { onEvent, onResponse } from "../opendesign-compatible-fix.middleware.js";

const model = "relay/deepseek-v4.1-flash";
const block = (bars = "\uff5c\uff5c", kind = "tool_calls") => {
  const tag = (name, close = false) => `<${close ? "/" : ""}${bars}DSML${bars}${name}>`;
  return tag(kind) + tag('invoke name="exec_command"') +
    tag('parameter name="cmd" string="true"') + "echo ok" +
    tag("parameter", true) + tag("invoke", true) + tag(kind, true);
};
const reply = (content, responseModel = model) => ({
  model: responseModel, choices: [{ index: 0, message: { role: "assistant", content }, finish_reason: "stop" }],
});
const event = (content, finish_reason = null, responseModel = model) => ({
  model: responseModel,
  choices: [{ index: 0, delta: content === undefined ? {} : { content }, finish_reason }],
});
function stream(parts, ctx = { model, state: {} }) {
  const events = parts.map(part => onEvent(event(part), ctx));
  events.push(onEvent(event(undefined, "stop"), ctx));
  return {
    events,
    text: events.map(item => item.choices[0].delta.content || "").join(""),
    calls: events.flatMap(item => item.choices[0].delta.tool_calls || []),
  };
}
function checkCall(calls) {
  assert.equal(calls.length, 1);
  assert.equal(calls[0].function.name, "exec_command");
  assert.deepEqual(JSON.parse(calls[0].function.arguments), { cmd: "echo ok" });
}

test("plain non-streaming DeepSeek and unknown-model replies remain byte-identical", () => {
  for (const responseModel of [model, undefined]) {
    for (const text of ["OK", "", "Hello\nworld <html> & < 5", "text <", "<||DSML||metadata>text", block().slice(0, -1)]) {
      const body = reply(text, responseModel);
      if (responseModel === undefined) delete body.model;
      const before = structuredClone(body);
      assert.strictEqual(onResponse(body), body);
      assert.deepEqual(body, before);
    }
  }
});

test("plain streamed chunks pass through immediately without DSML", () => {
  const ctx = { model, state: {} };
  for (const text of ["Hello", " ", "world\n", "OK", "<html>", "1 < 5", ""]) {
    const chunk = event(text);
    const before = structuredClone(chunk);
    assert.strictEqual(onEvent(chunk, ctx), chunk);
    assert.deepEqual(chunk, before);
  }
});

test("possible DSML prefixes are released on mismatch or terminal chunks", () => {
  for (const parts of [["hello <", "html> world"], ["<||DS", "MX ordinary"], ["last <"], ["<tool_call>"], [block().slice(0, -8)]]) {
    const result = stream(parts);
    assert.equal(result.text, parts.join(""));
    assert.deepEqual(result.calls, []);
    assert.equal(result.events.at(-1).choices[0].finish_reason, "stop");
  }
});

test("known non-DeepSeek models remain untouched even when content contains DSML", () => {
  for (const other of ["relay/gpt-6-luna", "claude-haiku-5.5", "group/auto", "some-deepseek-proxy"]) {
    for (const text of ["OK", block(), "<||DS"]) {
      for (const ctx of [{ model: other, state: {} }, undefined]) {
        const body = reply(text, other);
        const before = structuredClone(body);
        onResponse(body, ctx);
        assert.deepEqual(body, before);
        const chunk = event(text, null, other);
        const expected = structuredClone(chunk);
        onEvent(chunk, ctx);
        assert.deepEqual(chunk, expected);
      }
    }
  }
});

test("ctx.model gates DSML when the response omits its model", () => {
  const body = reply(block());
  delete body.model;
  const before = structuredClone(body);
  onResponse(body, { model: "relay/gpt-6-luna" });
  assert.deepEqual(body, before);
  onResponse(body, { model });
  checkCall(body.choices[0].message.tool_calls);
});

test("DSML converts for known DeepSeek and unknown models, preserving surrounding text", () => {
  for (const ctx of [{ model }, undefined]) {
    const body = reply("Before " + block() + " after");
    delete body.model;
    onResponse(body, ctx);
    assert.equal(body.choices[0].message.content, "Before  after");
    assert.equal(body.choices[0].finish_reason, "tool_calls");
    checkCall(body.choices[0].message.tool_calls);
  }
});

test("whole and split DSML chunks convert with single/double ASCII/full-width bars", () => {
  for (const bars of ["|", "||", "\uff5c", "\uff5c\uff5c"]) {
    for (const kind of ["tool_calls", "function_calls"]) {
      const text = "Before " + block(bars, kind) + " after";
      for (const size of [1, 7, text.length]) {
        const parts = [];
        for (let i = 0; i < text.length; i += size) parts.push(text.slice(i, i + size));
        for (const ctx of [{ model, state: {} }, { state: {} }]) {
          const result = stream(parts, ctx);
          assert.equal(result.text, "Before  after");
          checkCall(result.calls);
          assert.equal(result.events.at(-1).choices[0].finish_reason, "tool_calls");
        }
      }
    }
  }
});

test("a DSML block with no invoke is preserved verbatim", () => {
  const text = "<||DSML||tool_calls>ordinary</||DSML||tool_calls>";
  const body = reply(text);
  onResponse(body);
  assert.equal(body.choices[0].message.content, text);
  const result = stream([...text]);
  assert.equal(result.text, text);
  assert.deepEqual(result.calls, []);
});

test("choices have independent stream state and tool indices advance", () => {
  const ctx = { model, state: {} };
  const first = { model, choices: [{ index: 0, delta: { content: block().slice(0, 25) } }, { index: 1, delta: { content: "OK" } }] };
  onEvent(first, ctx);
  assert.equal(first.choices[1].delta.content, "OK");
  const last = onEvent({ model, choices: [{ index: 0, delta: { content: block().slice(25) } }] }, ctx);
  checkCall(last.choices[0].delta.tool_calls);
  const next = onEvent(event(block()), ctx).choices[0].delta.tool_calls[0];
  assert.equal(next.index, 1);
  assert.equal(next.id, "call_dsml_1");
});
