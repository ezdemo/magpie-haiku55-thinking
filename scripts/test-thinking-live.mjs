// This acceptance test intentionally does not start or call Magpie.
// A 200 without evidence of reasoning is not counted as a thinking fix.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";

if (!process.argv.includes("--live")) {
  console.error("Explicit opt-in required: node scripts/test-thinking-live.mjs --live");
  process.exit(2);
}

const profile = JSON.parse(await readFile(join(homedir(), ".amr", "config.json"), "utf8")).profiles?.prod;
if (typeof profile?.runtimeKey !== "string" || !profile.runtimeKey.trim()) {
  throw new Error("No OpenDesign prod runtime key in ~/.amr/config.json");
}
const key = profile.runtimeKey.trim();
function clean(value) {
  let text = String(value);
  for (const secret of [profile.runtimeKey, profile.controlKey].filter(Boolean)) text = text.split(secret).join("[REDACTED]");
  return text.replace(/Bearer\s+[^\s"<>]+/gi, "Bearer [REDACTED]").slice(0, 800);
}
const prompt = "Find the smallest positive integer n such that n is divisible by 84, n+1 by 85, and n+2 by 86. Verify your answer. Use your reasoning capability and give a concise final answer.";
const messages = [{ role: "user", content: prompt }];
const cases = [
  { path: "messages", body: { messages, max_tokens: 4096, thinking: { type: "adaptive", display: "summarized" }, output_config: { effort: "high" } } },
  { path: "chat/completions", body: { messages, max_tokens: 4096, reasoning_effort: "high" } },
  { path: "responses", body: { input: prompt, max_output_tokens: 4096, reasoning: { effort: "high", summary: "auto" } } }
];
let failed = false;
for (const { path, body } of cases) {
  try {
    const response = await fetch(`https://amr-link.open-design.ai/v1/${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json", "anthropic-version": "2023-06-01" },
      body: JSON.stringify({ model: "claude-haiku-5.5", stream: true, ...body }),
      signal: AbortSignal.timeout(60000)
    });
    const raw = await response.text();
    let error;
    try {
      const data = JSON.parse(raw);
      error = typeof data.error?.message === "string" ? clean(data.error.message) : undefined;
    } catch {}
    const thinking = /"type"\s*:\s*"(?:thinking|thinking_delta|reasoning|reasoning_summary_text.delta)"|"reasoning_content"\s*:\s*"[^"\s]|"reasoning_tokens"\s*:\s*[1-9]/.test(raw)
      || /event:\s*response\.reasoning/.test(raw);
    const passed = response.ok && thinking;
    failed ||= !passed;
    console.log(JSON.stringify({
      endpoint: `/v1/${path}`, model: "claude-haiku-5.5", status: response.status,
      thinkingObserved: thinking, passed,
      error: error || (!response.ok ? "Upstream failed; raw body omitted" : !thinking ? "No reasoning evidence: cannot count this as a thinking fix" : undefined)
    }));
  } catch (error) {
    failed = true;
    console.log(JSON.stringify({ endpoint: `/v1/${path}`, passed: false, error: error.name === "TimeoutError" ? "Request timed out" : "Request failed" }));
  }
}
process.exitCode = failed ? 1 : 0;
