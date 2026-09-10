import { safeFetch, readCapped, rateLimit, clientIp, ProxyError } from "./_guard.js";

export const config = { maxDuration: 30 };

const MAX_BYTES = 6 * 1024 * 1024;
const RATE_MAX = Number(process.env.PROXY_RATE_MAX || 120);
const RATE_WINDOW_MS = Number(process.env.PROXY_RATE_WINDOW_MS || 60_000);

/* Upstream response headers the audit actually reads. They are re-emitted under
   an x-up- prefix so the caller can see them without this response inheriting
   somebody else's CSP or X-Frame-Options. */
const FORWARD = [
  "content-type",
  "strict-transport-security",
  "content-security-policy",
  "x-frame-options",
  "referrer-policy",
  "x-content-type-options",
  "permissions-policy",
  "cross-origin-opener-policy",
  "server",
  "cache-control",
  "content-encoding",
  "last-modified",
  "etag",
];

export default async function handler(req, res) {
  const allowOrigin = process.env.ALLOWED_ORIGIN || "*";
  res.setHeader("Access-Control-Allow-Origin", allowOrigin);
  res.setHeader("Vary", "Origin");
  res.setHeader("Access-Control-Allow-Methods", "GET,OPTIONS");
  res.setHeader("Access-Control-Allow-Headers", "content-type");
  res.setHeader(
    "Access-Control-Expose-Headers",
    ["x-up-status", "x-up-final-url", "x-up-redirected", "x-up-truncated", ...FORWARD.map(h => "x-up-" + h)].join(",")
  );
  res.setHeader("Cache-Control", "no-store");

  if (req.method === "OPTIONS") return res.status(204).end();
  if (req.method !== "GET") return res.status(405).json({ error: "use GET" });

  if (!rateLimit(clientIp(req), RATE_MAX, RATE_WINDOW_MS)) {
    return res.status(429).json({ error: "too many requests — slow down" });
  }

  const target = typeof req.query.url === "string" ? req.query.url : "";

  try {
    const { res: upstream, finalUrl, chain } = await safeFetch(target, {
      maxRedirects: 5,
      timeoutMs: 20_000,
      headers: {
        /* Identify the crawler. Browsers refuse to let fetch() set this, which
           is part of why the audit needs a server-side hop at all. */
        "user-agent": process.env.PROXY_USER_AGENT ||
          "ClearPageTesting/1.0 (+site auditor; https://github.com/mafazsiddi/webtesting)",
        accept: "text/html,application/xhtml+xml,application/xml;q=0.9,text/plain;q=0.8,*/*;q=0.5",
        "accept-language": "en-US,en;q=0.9",
      },
    });

    for (const name of FORWARD) {
      const v = upstream.headers.get(name);
      if (v) res.setHeader("x-up-" + name, v.slice(0, 1024).replace(/[\r\n]/g, " "));
    }
    res.setHeader("x-up-status", String(upstream.status));
    res.setHeader("x-up-final-url", encodeURI(finalUrl));
    res.setHeader("x-up-redirected", chain.length ? "1" : "0");

    const ctype = upstream.headers.get("content-type") || "";
    const isText = /text\/|xml|json|javascript|\+xml/i.test(ctype) || ctype === "";

    if (!isText) {
      /* Binary: report the weight, don't ship the bytes. Asset weighing only
         needs the size, and streaming images through here would be wasteful. */
      const declared = Number(upstream.headers.get("content-length") || 0);
      let bytes = declared;
      if (!bytes) {
        const capped = await readCapped(upstream, MAX_BYTES);
        bytes = capped.bytes;
      } else {
        try { await upstream.body?.cancel(); } catch { /* already closing */ }
      }
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.setHeader("x-up-truncated", "0");
      return res.status(200).json({ binary: true, bytes, contentType: ctype, finalUrl });
    }

    const { text, truncated } = await readCapped(upstream, MAX_BYTES);
    res.setHeader("x-up-truncated", truncated ? "1" : "0");
    res.setHeader("Content-Type", "text/plain; charset=utf-8");
    /* Never let a proxied body be sniffed as HTML and rendered on our origin. */
    res.setHeader("X-Content-Type-Options", "nosniff");
    return res.status(200).send(text);
  } catch (e) {
    const status = e instanceof ProxyError ? e.status : 500;
    return res.status(status).json({ error: e.message || "proxy failed" });
  }
}
