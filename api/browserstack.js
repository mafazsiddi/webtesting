import { rateLimit, clientIp } from "./_guard.js";

export const config = { maxDuration: 30 };

/* BrowserStack's Screenshots API: one call starts a job across a list of
   real browsers and real devices, a second call polls it until every shot is
   rendered. Credentials are Basic-Auth and never reach the browser — the
   frontend only ever talks to this endpoint. */
const BASE = "https://www.browserstack.com/screenshots";
const MAX_BODY_BYTES = 50_000;

/* Starting a job is what spends the account's BrowserStack quota, so it gets
   its own tighter limit; listing browsers and polling a job already in
   flight are cheap and share a looser one. */
const START_RATE_MAX = Number(process.env.BROWSERSTACK_START_RATE_MAX || 5);
const RATE_MAX = Number(process.env.BROWSERSTACK_RATE_MAX || 40);
const RATE_WINDOW_MS = Number(process.env.BROWSERSTACK_RATE_WINDOW_MS || 60_000);

function creds() {
  const username = (process.env.BROWSERSTACK_USERNAME || "").trim();
  const key = (process.env.BROWSERSTACK_ACCESS_KEY || "").trim();
  if (!username || !key) return null;
  return "Basic " + Buffer.from(username + ":" + key).toString("base64");
}

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

function sendJson(res, status, text) {
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  return res.status(status).send(text);
}

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", process.env.ALLOWED_ORIGIN || "*");
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,POST,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();

  const auth = creds();
  if (!auth) {
    return res.status(401).json({
      error: "this deployment has no BROWSERSTACK_USERNAME / BROWSERSTACK_ACCESS_KEY configured — " +
        "real cross-browser and real-device screenshots are unavailable until both are set",
    });
  }

  const action = typeof req.query.action === "string" ? req.query.action : "";
  const ip = clientIp(req);

  try {
    if (req.method === "GET" && action === "browsers") {
      if (!rateLimit(ip + ":bs-list", RATE_MAX, RATE_WINDOW_MS)) {
        return res.status(429).json({ error: "too many requests — wait a minute and try again" });
      }
      const upstream = await fetch(BASE + "/browsers.json", { headers: { authorization: auth } });
      const text = await upstream.text();
      if (!upstream.ok) return res.status(upstream.status).json({ error: "BrowserStack " + upstream.status + ": " + text.slice(0, 300) });
      return sendJson(res, 200, text);
    }

    if (req.method === "GET" && action === "status") {
      if (!rateLimit(ip + ":bs-list", RATE_MAX, RATE_WINDOW_MS)) {
        return res.status(429).json({ error: "too many requests — wait a minute and try again" });
      }
      const job = typeof req.query.job === "string" ? req.query.job : "";
      if (!/^[a-z0-9]+$/i.test(job)) return res.status(400).json({ error: "a job id is required" });
      const upstream = await fetch(BASE + "/" + encodeURIComponent(job) + ".json", { headers: { authorization: auth } });
      const text = await upstream.text();
      if (!upstream.ok) return res.status(upstream.status).json({ error: "BrowserStack " + upstream.status + ": " + text.slice(0, 300) });
      return sendJson(res, 200, text);
    }

    if (req.method === "POST" && action === "start") {
      if (!rateLimit(ip + ":bs-start", START_RATE_MAX, RATE_WINDOW_MS)) {
        return res.status(429).json({ error: "too many screenshot jobs started — wait a minute and try again" });
      }
      const body = await readBody(req);
      const url = typeof body.url === "string" ? body.url.trim() : "";
      if (!/^https?:\/\//i.test(url) || url.length > 2048) {
        return res.status(400).json({ error: "a http(s) url under 2048 characters is required" });
      }
      const browsers = Array.isArray(body.browsers) ? body.browsers.slice(0, 8) : [];
      if (!browsers.length) return res.status(400).json({ error: "at least one browser or device is required" });
      const upstream = await fetch(BASE, {
        method: "POST",
        headers: { authorization: auth, "content-type": "application/json" },
        body: JSON.stringify({ url, browsers, wait_time: 5, quality: "compressed" }),
      });
      const text = await upstream.text();
      if (!upstream.ok) return res.status(upstream.status).json({ error: "BrowserStack " + upstream.status + ": " + text.slice(0, 300) });
      return sendJson(res, 200, text);
    }

    return res.status(400).json({ error: "unknown request — use ?action=browsers, POST ?action=start, or ?action=status&job=" });
  } catch (e) {
    return res.status(502).json({ error: "could not reach BrowserStack: " + (e.message || "network error") });
  }
}
