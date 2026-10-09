// Real Magpie/moejs + local mock upstream. No vendor keys or real account data.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir, homedir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const bin = process.env.MAGPIE_BIN;
if (!bin) throw new Error("Set MAGPIE_BIN to a Magpie CLI executable first.");
const root = await mkdtemp(join(tmpdir(), "magpie-haiku55-test-"));
const config = join(root, "config");
await mkdir(join(config, "magpie"), { recursive: true });
const captured = [];
let liveKey;
const upstream = createServer(async (req, res) => {
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    if (req.url.endsWith("/models")) {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify({ data: [{ id: "claude-haiku-5.5" }] }));
      return;
    }
    captured.push({ path: req.url, body });
    if (liveKey) {
      assert.equal(req.url, "/v1/chat/completions");
      const remote = await fetch("https://amr-link.open-design.ai/v1/chat/completions", {
        method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${liveKey}` },
        body: raw, signal: AbortSignal.timeout(30000)
      });
      res.writeHead(remote.status, { "Content-Type": remote.headers.get("Content-Type") || "application/json" });
      res.end((await remote.text()).split(liveKey).join("[REDACTED]"));
      return;
    }
    const native = req.url.endsWith("/messages");
    if (body.thinking?.type === "enabled") {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: { type: "invalid_request_error", message: "thinking.type.enabled is not supported" } }));
      return;
    }
    if (body.stream) {
      res.setHeader("Content-Type", "text/event-stream");
      if (native) {
        const events = [
          { type: "message_start", message: { id: "msg_test", type: "message", role: "assistant", model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 1, output_tokens: 0 } } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "OK" } },
          { type: "content_block_stop", index: 0 },
          { type: "message_delta", delta: { stop_reason: "end_turn", stop_sequence: null }, usage: { output_tokens: 1 } },
          { type: "message_stop" }
        ];
        for (const event of events) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
      } else {
        for (const part of [
          { choices: [{ index: 0, delta: { role: "assistant", content: "OK" }, finish_reason: null }] },
          { choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }
        ]) res.write(`data: ${JSON.stringify({ id: "chat_test", object: "chat.completion.chunk", model: body.model, ...part })}\n\n`);
        res.write("data: [DONE]\n\n");
      }
      res.end();
    } else {
      res.setHeader("Content-Type", "application/json");
      res.end(JSON.stringify(native
        ? { id: "msg_test", type: "message", role: "assistant", model: body.model, content: [{ type: "text", text: "OK" }], stop_reason: "end_turn", usage: { input_tokens: 1, output_tokens: 1 } }
        : { id: "chat_test", object: "chat.completion", model: body.model, choices: [{ index: 0, message: { role: "assistant", content: "OK" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } }));
    }
  } catch {
    res.writeHead(500);
    res.end("Mock fixture failed");
  }
});
await new Promise((r) => upstream.listen(0, "127.0.0.1", r));
const upstreamPort = upstream.address().port;
const reservation = createServer();
await new Promise((r) => reservation.listen(0, "127.0.0.1", r));
const port = reservation.address().port;
await new Promise((r) => reservation.close(r));
const env = { ...process.env, XDG_CONFIG_HOME: config, XDG_CACHE_HOME: join(root, "cache"), MAGPIE_ADDR: `127.0.0.1:${port}`, MAGPIE_PLUGIN_MARKET: "off" };
const plugin = resolve(fileURLToPath(new URL("..", import.meta.url)));
const command = (args) => new Promise((resolvePromise, reject) => {
  const child = spawn(bin, args, { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  let log = "";
  child.stdout.on("data", (b) => log += b);
  child.stderr.on("data", (b) => log += b);
  child.on("error", reject);
  child.on("close", (code) => code === 0 ? resolvePromise(log) : reject(new Error(`magpie ${args[0]} failed: ${log}`)));
});
let gateway;
let gatewayLog = "";
try {
  await command(["provider", "add", "native", `anthropic=http://127.0.0.1:${upstreamPort}/v1`, "key=fixture-key", "models=claude-haiku-5.5"]);
  await command(["provider", "add", "chat", `url=http://127.0.0.1:${upstreamPort}/v1`, "key=chat-fixture-key", "models=claude-haiku-5.5"]);
  await command(["plugin", "add", plugin]);
  // Exercise the packaged middleware in moejs, not just its Node import.
  const pluginsFile = join(config, "magpie", "plugins.json");
  await writeFile(pluginsFile, JSON.stringify({ plugins: [{ spec: plugin, options: { mode: "adaptive" } }] }));
  gateway = spawn(bin, ["serve"], { env, windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
  gateway.stdout.on("data", (b) => gatewayLog += b);
  gateway.stderr.on("data", (b) => gatewayLog += b);
  let ready = false;
  for (let n = 0; n < 200; n++) {
    try { await fetch(`http://127.0.0.1:${port}/v1/models`); ready = true; break; } catch {}
    await new Promise((r) => setTimeout(r, 100));
  }
  assert.ok(ready, `gateway did not start: ${gatewayLog}`);
  async function send(path, model, fields) {
    captured.length = 0;
    const res = await fetch(`http://127.0.0.1:${port}/v1/${path}`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, ...fields }), signal: AbortSignal.timeout(20000)
    });
    const text = await res.text();
    assert.equal(res.status, 200, text);
    assert.ok(captured.length, "request never reached the mock upstream");
    assert.ok(text.includes("OK"), "response text or stream was lost");
    return captured.at(-1).body;
  }
  const user = [{ role: "user", content: "Reply OK" }];
  for (const stream of [false, true]) {
    const body = await send("messages", "native/claude-haiku-5.5", { messages: user, max_tokens: 1024, stream, thinking: { type: "enabled", budget_tokens: 1024 }, output_config: { effort: "high" } });
    assert.deepEqual(body.thinking, { type: "adaptive" });
    assert.equal(body.output_config.effort, "high");
    console.log(`PASS packaged moejs native adaptive; stream=${stream}`);
  }
  const chat = await send("chat/completions", "chat/claude-haiku-5.5", { messages: user, reasoning_effort: "ultra" });
  assert.equal(chat.reasoning_effort, "max");
  assert.deepEqual(chat.thinking, { type: "adaptive" });
  console.log("PASS packaged moejs Chat adaptive parameters");

  await writeFile(pluginsFile, JSON.stringify({ plugins: [{ spec: plugin, options: { mode: "disabled" } }] }));
  await new Promise((r) => setTimeout(r, 1600));
  for (const provider of ["native", "chat"]) {
    for (const [path, fields] of [
      ["messages", { messages: user, max_tokens: 1024, thinking: { type: "enabled", budget_tokens: 1024 } }],
      ["chat/completions", { messages: user, reasoning_effort: "high" }],
      ["responses", { input: "Reply OK", reasoning: { effort: "high" } }]
    ]) {
      const body = await send(path, `${provider}/claude-haiku-5.5`, fields);
      if (provider === "native") assert.ok(body.thinking === undefined || body.thinking.type === "disabled");
      else assert.ok(body.reasoning_effort === undefined || body.reasoning_effort === "none");
      assert.notEqual(body.thinking?.type, "enabled");
      console.log(`PASS packaged moejs disabled; ${path} -> ${provider}`);
    }
  }
  if (process.argv.includes("--live")) {
    // Explicit opt-in only. The key stays in this process; no credentials are
    // written to the sandbox or sent to the Magpie process/mock configuration.
    const profile = JSON.parse(await readFile(join(homedir(), ".amr", "config.json"), "utf8"));
    liveKey = profile.profiles?.prod?.runtimeKey;
    assert.ok(typeof liveKey === "string" && liveKey.length > 0, "No local OpenDesign prod runtime key");
    for (const [path, fields] of [
      ["messages", { messages: user, max_tokens: 1024, thinking: { type: "enabled", budget_tokens: 1024 } }],
      ["chat/completions", { messages: user, max_tokens: 1024, reasoning_effort: "high" }],
      ["responses", { input: "Reply OK", max_output_tokens: 1024, reasoning: { effort: "high" } }]
    ]) {
      const body = await send(path, "chat/claude-haiku-5.5", fields);
      assert.equal(body.reasoning_effort, undefined);
      console.log(`PASS LIVE OpenDesign compatibility; ${path} -> Chat upstream; HTTP 200`);
    }
    liveKey = undefined;
  }
  assert.doesNotMatch(gatewayLog, /middleware.*(?:error|failed|panic)/i);
  console.log(`Sandbox retained at ${root}`);
} finally {
  gateway?.kill();
  upstream.closeAllConnections();
  await new Promise((r) => upstream.close(r));
}
