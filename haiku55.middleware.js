// Runs in Magpie's moejs engine: no dependencies, Node APIs, fetch, or timers.
const MODEL = /(?:^|\/)(?:anthropic\.)?(?:claude[-_.])?haiku[-_.]?5[-_.]5(?:-\d{8})?(?:@[-\w.]+)?$/i;
const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

function object(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function effort(value) {
  if (typeof value !== "string") return undefined;
  const text = value.toLowerCase();
  if (text === "minimal") return "low";
  if (text === "ultra") return "max";
  if (text === "none" || text === "off") return "none";
  return EFFORTS.indexOf(text) >= 0 ? text : undefined;
}

export function onRequest(body, ctx) {
  if (!object(body)) return body;
  const options = object(ctx.options) ? ctx.options : {};
  const model = typeof body.model === "string" ? body.model : ctx.model;
  const aliases = Array.isArray(options.models) ? options.models : [];
  if (typeof model !== "string" || (!MODEL.test(model) && aliases.indexOf(model) < 0)) return body;
  if (["anthropic", "chat", "responses"].indexOf(ctx.protocol) < 0) return body;

  const mode = options.mode === undefined ? "adaptive" : options.mode;
  if (mode !== "adaptive" && mode !== "disabled") {
    return ctx.reject(400, "haiku55-thinking: mode must be adaptive or disabled");
  }
  const configured = options.effort === undefined ? undefined : effort(options.effort);
  const fallback = options.defaultEffort === undefined ? "medium" : effort(options.defaultEffort);
  if ((options.effort !== undefined && configured === undefined) || !fallback || fallback === "none") {
    return ctx.reject(400, "haiku55-thinking: invalid effort/defaultEffort option");
  }

  const thinking = object(body.thinking) ? body.thinking : {};
  const output = object(body.output_config) ? body.output_config : {};
  const reasoning = object(body.reasoning) ? body.reasoning : {};
  // Read the agent's native control first; output_config remains authoritative
  // for Anthropic. A configured effort is an explicit operator override.
  const requested = ctx.protocol === "responses"
    ? effort(reasoning.effort) || effort(output.effort) || effort(body.reasoning_effort)
    : ctx.protocol === "chat"
      ? effort(body.reasoning_effort) || effort(output.effort) || effort(reasoning.effort)
      : effort(output.effort) || effort(body.reasoning_effort) || effort(reasoning.effort);
  const selected = configured || requested || fallback;
  const disabled = mode === "disabled" || selected === "none" || thinking.type === "disabled";
  // Disabled thinking is rejected with xhigh/max. Keep the off request and use
  // an allowed effort rather than quietly turning thinking back on.
  const level = disabled
    ? selected === "none" || mode === "disabled" ? "low" : ["xhigh", "max"].indexOf(selected) >= 0 ? "high" : selected
    : selected;

  if (ctx.protocol === "anthropic" || ctx.protocol === "chat") {
    body.thinking = { ...thinking, type: disabled ? "disabled" : "adaptive" };
    delete body.thinking.budget_tokens;
    body.output_config = { ...output, effort: level };
  } else if (object(body.thinking)) {
    // Clean a nonstandard legacy extension too, but do not rely on this field
    // surviving Responses -> provider protocol translation.
    body.thinking = { ...thinking, type: disabled ? "disabled" : "adaptive" };
    delete body.thinking.budget_tokens;
  }

  if (ctx.protocol === "responses") {
    body.reasoning = { ...reasoning, effort: disabled ? "none" : level };
    // In compatibility mode omit the entire control. An empty reasoning object
    // still makes Magpie generate adaptive thinking during protocol conversion.
    if (mode === "disabled") delete body.reasoning;
    delete body.reasoning_effort;
    delete body.output_config;
  } else if (ctx.protocol === "chat") {
    body.reasoning_effort = disabled ? "none" : level;
    if (mode === "disabled") delete body.reasoning_effort;
    delete body.reasoning;
  } else {
    delete body.reasoning_effort;
    delete body.reasoning;
  }

  if (options.removeSampling !== false) {
    delete body.temperature;
    delete body.top_p;
    delete body.top_k;
  }
  return body;
}
