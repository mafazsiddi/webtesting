/* Extracts the inline <script> from index.html and asks Node to parse it, so a
   syntax error in the 4,600-line block fails a build instead of a page load. */
import fs from "node:fs/promises";
import vm from "node:vm";

const html = await fs.readFile(new URL("../index.html", import.meta.url), "utf8");

const marker = /<script>\s*"use strict";/.exec(html);
if (!marker) {
  console.error("check-html: could not find the main inline script block");
  process.exit(1);
}
const open = marker.index;
const start = html.indexOf(">", open) + 1;
const end = html.indexOf("</script>", start);
if (end === -1) {
  console.error("check-html: main script block is not closed");
  process.exit(1);
}

const source = html.slice(start, end);
try {
  new vm.Script(source, { filename: "index.html<script>" });
} catch (e) {
  console.error("check-html: " + e.message);
  process.exit(1);
}

const stats = [
  ["lines", source.split("\n").length],
  ["kb", Math.round(html.length / 1024)],
];

/* Cheap guards against the mistakes that would silently un-fix the security
   work: a measurement frame created without a sandbox attribute, or the Claude
   call pointed straight at Anthropic again. */
const frames = source.match(/createElement\("iframe"\)/g) || [];
const sandboxed = source.match(/setAttribute\("sandbox"/g) || [];
if (sandboxed.length < frames.length) {
  console.error(
    `check-html: ${frames.length} iframe(s) created but only ${sandboxed.length} sandbox attribute(s) set`
  );
  process.exit(1);
}
if (/fetch\(\s*["']https:\/\/api\.anthropic\.com/.test(source)) {
  console.error("check-html: the browser must not call api.anthropic.com directly — go through /api/claude");
  process.exit(1);
}
if (/fonts\.googleapis\.com|fonts\.gstatic\.com/.test(html)) {
  console.error("check-html: Google Fonts reference found — fonts are self-hosted under /fonts");
  process.exit(1);
}

console.log("check-html: ok (" + stats.map(([k, v]) => v + " " + k).join(", ") + ")");
