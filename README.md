# ClearPage Testing

Crawl a website and audit every page it finds for SEO, accessibility, link
health, technical hygiene, performance weight, forms, transport security and
device compatibility. Results come back as an on-screen report plus downloadable
Markdown and JSON.

The audit is a single static page. Two serverless functions sit behind it — one
to fetch pages the browser is not allowed to read, one to talk to the Anthropic
API without putting a key in the browser.

## Deploying on Vercel

```
vercel            # preview
vercel --prod     # production
```

No build step. `index.html` is served as-is, `api/*.js` become Node functions,
and `vercel.json` supplies the security headers.

### Environment variables

All optional — see [.env.example](.env.example) for the full list. The two worth
deciding on before you go live:

| Variable | Effect |
| --- | --- |
| `ANTHROPIC_API_KEY` | Enables the fix plan with no key in the browser. **On a public deployment this spends your tokens for every visitor** — leave it unset to make visitors bring their own. |
| `ALLOWED_ORIGIN` | Restricts the API endpoints to one origin. Defaults to `*`, which lets any page call your proxy. Set it. |

## How the pieces fit

### `api/proxy.js` — the fetch route

Browsers cannot read another origin's HTML unless that origin opts in, so pages
are fetched server-side. That makes this endpoint an SSRF liability by
construction, and it is written accordingly:

- only `http:` and `https:`, no credentials in the URL, 2 KB URL ceiling
- the hostname is **resolved first**, then every returned address is checked
  against loopback, private, carrier-NAT, link-local, multicast and reserved
  ranges — in v4, v6, and the IPv4-mapped, 6to4 and NAT64 forms that smuggle a
  v4 address inside a v6 one
- `169.254.169.254` and the rest of link-local are blocked, so instance
  credentials are not reachable
- redirects are followed **one hop at a time**, re-checking each target;
  `redirect: "follow"` would let a public host bounce the request to `127.0.0.1`
- responses are capped at 6 MB and 20 s
- binary responses come back as a weight, not as bytes
- upstream headers are re-emitted under an `x-up-` prefix, so the header audit
  can read them and this response cannot inherit somebody else's CSP

`scripts/test-guard.mjs` covers the address logic with 72 assertions, including
the boundary cases either side of each blocked range.

The consequence of all this: **the proxy cannot reach anything on a private
network.** To audit staging on an internal host, run your own proxy inside that
network and point "My proxy" at it — and give it the same address checks, or you
have published an open relay.

### `api/claude.js` — the fix plan

The browser never calls `api.anthropic.com`. This endpoint holds the key
server-side when `ANTHROPIC_API_KEY` is set, or forwards a visitor's key for a
single request without storing it. It also caps `max_tokens`, restricts the
model to `claude-*`, rate-limits per IP, and turns a refusal or a truncated
response into a readable message instead of a parse error.

Note it sets `thinking: {type: "adaptive"}` and a `medium` effort. Thinking is on
by default on current models and shares the `max_tokens` budget with the reply,
which is why the ceiling is 16 K rather than the 6 K this used to send.

### Rendering pages for measurement

Responsiveness is measured, not inferred: each sampled page is re-rendered in a
hidden frame at 390, 768 and 1280 px with its own stylesheets, and real geometry
is read back. That means putting a crawled page inside a frame, which needs care:

- scripts are removed by **parsing** the HTML and deleting nodes, not by running
  a regex over the source — a regex can be walked past with malformed markup
- the frame that reads geometry is `sandbox="allow-same-origin"`: readable by
  the page, but nothing inside it can execute
- layout shift and largest paint need our probe to *run*, and a frame that can
  execute must not also be same-origin — so those get a second,
  `sandbox="allow-scripts"` frame with an opaque origin that reports back by
  `postMessage`
- display-only frames are fully sandboxed

### Content Security Policy

`vercel.json` sets a CSP with `object-src 'none'`, `frame-ancestors 'none'` and
`script-src 'self' 'unsafe-inline'` (the page is one inline script).

`srcdoc` frames **inherit the parent's CSP**, so `style-src`, `font-src`,
`img-src` and `base-uri` deliberately allow `https:`. Tightening them to `'self'`
would stop audited pages from loading their own stylesheets, and every
measurement would come back as "stylesheets did not load into the preview frame".
`connect-src` allows `https:` for the same reason — "Direct only" fetch mode
exists to audit CORS-enabled sites without a hop.

## Local development

```
npm run check     # syntax-check the functions and the inline script
node scripts/test-guard.mjs
vercel dev
```

`npm run check` also fails if an iframe is created without a sandbox attribute,
if the browser is pointed back at `api.anthropic.com`, or if a Google Fonts
reference reappears — the three regressions that would quietly undo the
hardening.

Fonts are self-hosted under `fonts/` (Latin subsets only) so there is no
third-party request on page load.

## What this cannot see

Read the footer of the tool itself for the full list; the short version:
JavaScript-rendered layout, real-user field metrics without a CrUX key, colour
contrast defined in external stylesheets, and anything behind a login. Those are
reported as "needs a human" rather than passing silently.

Scores are a triage order, not a grade. Read the findings.
