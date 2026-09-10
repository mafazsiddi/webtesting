import dns from "node:dns/promises";
import net from "node:net";

/* Address ranges that must never be reachable through this proxy. Cloud
   metadata endpoints are the expensive ones to get wrong: 169.254.169.254 hands
   out instance credentials to anything that asks. */
const BLOCKED_V4 = [
  ["0.0.0.0", 8],        // this host
  ["10.0.0.0", 8],       // private
  ["100.64.0.0", 10],    // carrier NAT
  ["127.0.0.0", 8],      // loopback
  ["169.254.0.0", 16],   // link-local, incl. cloud metadata
  ["172.16.0.0", 12],    // private
  ["192.0.0.0", 24],     // IETF protocol assignments
  ["192.0.2.0", 24],     // TEST-NET-1
  ["192.168.0.0", 16],   // private
  ["198.18.0.0", 15],    // benchmarking
  ["198.51.100.0", 24],  // TEST-NET-2
  ["203.0.113.0", 24],   // TEST-NET-3
  ["224.0.0.0", 4],      // multicast
  ["240.0.0.0", 4],      // reserved
];

function v4ToInt(ip) {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    const b = Number(p);
    if (!Number.isInteger(b) || b < 0 || b > 255) return null;
    n = (n << 8) | b;
  }
  return n >>> 0;
}

function isBlockedV4(ip) {
  const addr = v4ToInt(ip);
  if (addr === null) return true;
  for (const [base, bits] of BLOCKED_V4) {
    const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
    if ((addr & mask) === (v4ToInt(base) & mask)) return true;
  }
  return false;
}

function isBlockedV6(ip) {
  const a = ip.toLowerCase().split("%")[0];
  if (a === "::" || a === "::1") return true;              // unspecified, loopback
  if (a.startsWith("fe80") || a.startsWith("fec0")) return true; // link/site-local
  if (/^f[cd]/.test(a)) return true;                        // unique local fc00::/7
  if (a.startsWith("ff")) return true;                      // multicast
  // IPv4-mapped (::ffff:a.b.c.d) and IPv4-compatible forms
  const mapped = a.match(/(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isBlockedV4(mapped[1]);
  if (a.startsWith("2002:")) return true;                   // 6to4, can wrap private v4
  if (a.startsWith("64:ff9b:")) return true;                // NAT64
  return false;
}

export function isBlockedAddress(ip) {
  const kind = net.isIP(ip);
  if (kind === 4) return isBlockedV4(ip);
  if (kind === 6) return isBlockedV6(ip);
  return true;
}

/* Resolve first, then check every address the name maps to. Checking the
   hostname string alone is useless — "localtest.me" and a thousand other names
   resolve to 127.0.0.1, and an attacker controls their own DNS. */
export async function assertPublicHost(hostname) {
  if (net.isIP(hostname)) {
    if (isBlockedAddress(hostname)) throw new ProxyError(403, "that address is not reachable through this proxy");
    return [hostname];
  }
  const lower = hostname.toLowerCase();
  if (lower === "localhost" || lower.endsWith(".localhost") || lower.endsWith(".internal") ||
      lower.endsWith(".local") || lower.endsWith(".home.arpa") || !lower.includes(".")) {
    throw new ProxyError(403, "that host is not reachable through this proxy");
  }
  let records;
  try {
    records = await dns.lookup(hostname, { all: true, verbatim: true });
  } catch {
    throw new ProxyError(502, "that host could not be resolved");
  }
  if (!records.length) throw new ProxyError(502, "that host could not be resolved");
  for (const r of records) {
    if (isBlockedAddress(r.address)) {
      throw new ProxyError(403, "that host resolves to a non-public address");
    }
  }
  return records.map(r => r.address);
}

export class ProxyError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function parseTarget(raw) {
  if (!raw || typeof raw !== "string") throw new ProxyError(400, "no url given");
  if (raw.length > 2048) throw new ProxyError(400, "url is too long");
  let u;
  try { u = new URL(raw); } catch { throw new ProxyError(400, "that url could not be parsed"); }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    throw new ProxyError(400, "only http and https are proxied");
  }
  if (u.username || u.password) throw new ProxyError(400, "credentials in the url are not accepted");
  return u;
}

/* Redirects are followed by hand so every hop gets the same address check —
   `redirect: "follow"` would let a public host bounce us straight to 127.0.0.1. */
export async function safeFetch(url, { maxRedirects = 5, timeoutMs = 20000, headers = {} } = {}) {
  let current = parseTarget(url);
  const chain = [];
  for (let hop = 0; hop <= maxRedirects; hop++) {
    await assertPublicHost(current.hostname);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res;
    try {
      res = await fetch(current.href, {
        redirect: "manual",
        signal: ctrl.signal,
        headers,
      });
    } catch (e) {
      clearTimeout(timer);
      if (e.name === "AbortError") throw new ProxyError(504, "the target timed out");
      throw new ProxyError(502, "the target could not be reached");
    }
    clearTimeout(timer);

    const location = res.headers.get("location");
    if (res.status >= 300 && res.status < 400 && location) {
      let next;
      try { next = new URL(location, current); } catch { throw new ProxyError(502, "the target sent an unusable redirect"); }
      if (next.protocol !== "http:" && next.protocol !== "https:") {
        throw new ProxyError(403, "the target redirected to a scheme that is not proxied");
      }
      chain.push({ from: current.href, to: next.href, status: res.status });
      current = next;
      try { await res.body?.cancel(); } catch { /* nothing to drain */ }
      continue;
    }
    return { res, finalUrl: current.href, chain };
  }
  throw new ProxyError(502, "too many redirects");
}

/* Read at most `limit` bytes. A target that streams forever would otherwise pin
   the function open until Vercel kills it. */
export async function readCapped(res, limit) {
  if (!res.body) return { text: "", truncated: false, bytes: 0 };
  const reader = res.body.getReader();
  const chunks = [];
  let total = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      chunks.push(value.subarray(0, value.byteLength - (total - limit)));
      truncated = true;
      try { await reader.cancel(); } catch { /* already closing */ }
      break;
    }
    chunks.push(value);
  }
  return {
    text: Buffer.concat(chunks.map(c => Buffer.from(c))).toString("utf8"),
    truncated,
    bytes: Math.min(total, limit),
  };
}

/* Best-effort burst control. Serverless instances are ephemeral and not shared,
   so this stops a single client hammering one warm instance — it is not a
   substitute for a real rate limiter if this is exposed publicly. */
const buckets = new Map();
export function rateLimit(key, max, windowMs) {
  const now = Date.now();
  const hits = (buckets.get(key) || []).filter(t => now - t < windowMs);
  if (buckets.size > 5000) buckets.clear();
  if (hits.length >= max) {
    buckets.set(key, hits);
    return false;
  }
  hits.push(now);
  buckets.set(key, hits);
  return true;
}

export function clientIp(req) {
  const fwd = req.headers["x-forwarded-for"];
  if (typeof fwd === "string" && fwd.length) return fwd.split(",")[0].trim();
  return req.socket?.remoteAddress || "unknown";
}
