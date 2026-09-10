import { isBlockedAddress, parseTarget, assertPublicHost, ProxyError } from "../api/_guard.js";

let pass = 0;
const failures = [];

function check(name, actual, expected) {
  if (actual === expected) { pass++; return; }
  failures.push(`${name}: expected ${expected}, got ${actual}`);
}

/* --- addresses that must never be reachable --- */
for (const ip of [
  "127.0.0.1", "127.1.2.3", "0.0.0.0", "10.0.0.1", "10.255.255.255",
  "172.16.0.1", "172.31.255.255", "192.168.1.1", "192.168.0.0",
  "169.254.169.254",                 // AWS/GCP/Azure instance metadata
  "169.254.170.2",                   // ECS task metadata
  "100.64.0.1",                      // carrier-grade NAT
  "192.0.0.1", "192.0.2.5", "198.18.0.1", "198.51.100.7", "203.0.113.9",
  "224.0.0.1", "239.255.255.250", "240.0.0.1", "255.255.255.255",
  "::1", "::", "fe80::1", "fc00::1", "fd12:3456::1", "ff02::1",
  "::ffff:127.0.0.1", "::ffff:169.254.169.254", "::ffff:10.0.0.1",
  "2002:7f00:1::",                   // 6to4 wrapping 127.0.0.1
  "64:ff9b::7f00:1",                 // NAT64 wrapping 127.0.0.1
  "not-an-ip", "", "999.1.1.1",
]) check(`block ${ip || "(empty)"}`, isBlockedAddress(ip), true);

/* --- addresses that must remain reachable --- */
for (const ip of [
  "1.1.1.1", "8.8.8.8", "93.184.216.34", "142.250.185.78",
  "172.15.255.255",                  // just below the private block
  "172.32.0.1",                      // just above it
  "11.0.0.1", "9.255.255.255",
  "100.63.255.255", "100.128.0.1",   // either side of CGNAT
  "192.0.1.1", "192.0.3.1",          // either side of 192.0.0.0/24 and TEST-NET-1
  "223.255.255.255",                 // just below multicast
  "2606:4700:4700::1111",            // Cloudflare DNS over v6
  "2001:4860:4860::8888",
]) check(`allow ${ip}`, isBlockedAddress(ip), false);

/* --- URL parsing --- */
function parseFails(raw) {
  try { parseTarget(raw); return false; } catch (e) { return e instanceof ProxyError; }
}
for (const bad of [
  "file:///etc/passwd", "ftp://example.com/x", "gopher://example.com",
  "javascript:alert(1)", "data:text/html,<b>x", "", "not a url",
  "http://user:pass@example.com/",   // credentials in the url
  "http://example.com/" + "a".repeat(2100),
]) check(`reject url ${bad.slice(0, 34) || "(empty)"}`, parseFails(bad), true);

for (const good of ["http://example.com/", "https://example.com/a?b=c#d"]) {
  check(`accept url ${good}`, parseFails(good), false);
}

/* --- hostname resolution guard (no network needed for these) --- */
async function hostFails(h) {
  try { await assertPublicHost(h); return false; } catch (e) { return e instanceof ProxyError; }
}
for (const h of [
  "localhost", "LOCALHOST", "foo.localhost", "db.internal", "printer.local",
  "router.home.arpa", "intranet",     // no dot at all
  "127.0.0.1", "169.254.169.254", "[::1]".replace(/[[\]]/g, ""),
]) check(`reject host ${h}`, await hostFails(h), true);

check("accept literal public ip", await hostFails("1.1.1.1"), false);

if (failures.length) {
  console.error(`test-guard: ${failures.length} FAILED of ${failures.length + pass}`);
  failures.forEach(f => console.error("  - " + f));
  process.exit(1);
}
console.log(`test-guard: ok (${pass} assertions)`);
