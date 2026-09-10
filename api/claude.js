import { rateLimit, clientIp } from "./_guard.js";

export const config = { maxDuration: 60 };

const ENDPOINT = "https://api.anthropic.com/v1/messages";
const MAX_BODY_BYTES = 1_500_000;
const MAX_TOKENS_CEILING = 16_000;
const RATE_MAX = Number(process.env.CLAUDE_RATE_MAX || 10);
const RATE_WINDOW_MS = Number(process.env.CLAUDE_RATE_WINDOW_MS || 60_000);

const DEFAULT_MODEL = process.env.CLAUDE_MODEL || "claude-opus-5";

async function readBody(req) {
  if (req.body && typeof req.body === "object") return req.body;
  let size = 0;
  const chunks = [];
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) throw new Error("request body is too large");
    chunks.push(chunk);
  }
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type,x-user-api-key");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "POST") return res.status(405).json({ error: "use POST" });

  if (!rateLimit(clientIp(req), RATE_MAX, RATE_WINDOW_MS)) {
    return res.status(429).json({ error: "too many fix-plan requests — wait a minute and try again" });
  }

  /* Two ways to authenticate, in this order:
     1. ANTHROPIC_API_KEY on the deployment — the key never reaches the browser.
     2. A key the visitor typed in, forwarded for this one request and not stored.
     Set REQUIRE_SERVER_KEY=1 to refuse visitor-supplied keys entirely. */
  const userKey = typeof req.headers["x-user-api-key"] === "string" ? req.headers["x-user-api-key"].trim() : "";
  const serverKey = (process.env.ANTHROPIC_API_KEY || "").trim();
  const requireServerKey = process.env.REQUIRE_SERVER_KEY === "1";

  const apiKey = serverKey || (requireServerKey ? "" : userKey);
  if (!apiKey) {
    return res.status(401).json({
      error: requireServerKey
        ? "this deployment has no ANTHROPIC_API_KEY configured"
        : "no API key — set ANTHROPIC_API_KEY on the deployment, or paste one under “Fetching and keys”",
    });
  }
  if (!/^sk-ant-/.test(apiKey)) {
    return res.status(401).json({ error: "that does not look like an Anthropic API key" });
  }

  let body;
  try {
    body = await readBody(req);
  } catch (e) {
    return res.status(400).json({ error: e.message || "could not read the request body" });
  }

  const model = typeof body.model === "string" && /^claude-[a-z0-9.\-]+$/i.test(body.model)
    ? body.model
    : DEFAULT_MODEL;

  if (!Array.isArray(body.messages) || !body.messages.length) {
    return res.status(400).json({ error: "messages are required" });
  }

  const maxTokens = Math.min(Number(body.max_tokens) || 12_000, MAX_TOKENS_CEILING);

  const payload = {
    model,
    max_tokens: maxTokens,
    /* Thinking is on by default on current models and shares the max_tokens
       budget with the reply, so the ceiling above is deliberately generous.
       Medium effort keeps this inside the function's time limit. */
    thinking: { type: "adaptive" },
    output_config: { effort: process.env.CLAUDE_EFFORT || "medium" },
    /* A site audit can look like security research to the safety classifiers.
       Rather than hand the visitor a bare refusal, let the API re-run the same
       request on its recommended fallback model. */
    fallbacks: "default",
    messages: body.messages,
  };

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 55_000);

  try {
    const upstream = await fetch(ENDPOINT, {
      method: "POST",
      signal: ctrl.signal,
      headers: {
        "content-type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        "anthropic-beta": "server-side-fallback-2026-07-01",
      },
      body: JSON.stringify(payload),
    });
    clearTimeout(timer);

    const text = await upstream.text();
    if (!upstream.ok) {
      let detail = text.slice(0, 400);
      try { detail = JSON.parse(text)?.error?.message || detail; } catch { /* keep raw */ }
      return res.status(upstream.status).json({ error: "Anthropic API " + upstream.status + ": " + detail });
    }

    const data = JSON.parse(text);

    if (data.stop_reason === "refusal") {
      return res.status(422).json({
        error: "the model declined this request" +
          (data.stop_details?.category ? " (" + data.stop_details.category + ")" : "") +
          " — the rule-based findings are unaffected",
      });
    }
    if (data.stop_reason === "max_tokens") {
      return res.status(502).json({ error: "the fix plan was cut off before it finished — try again, or lower the page count" });
    }

    const reply = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("\n");
    return res.status(200).json({ text: reply, model: data.model, usage: data.usage });
  } catch (e) {
    clearTimeout(timer);
    if (e.name === "AbortError") {
      return res.status(504).json({ error: "the fix plan took too long — try fewer pages, or set CLAUDE_EFFORT=low" });
    }
    return res.status(502).json({ error: "could not reach the Anthropic API" });
  }
}
