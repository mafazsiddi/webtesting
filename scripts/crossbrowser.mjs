#!/usr/bin/env node
/* Real Chromium, Firefox and WebKit — not BrowserStack, not emulation. Each
   engine is launched by Playwright, which ships the actual browser binaries,
   so this needs a machine that can run them: your own, or a CI runner (see
   .github/workflows/real-world-check.yml for the free, on-demand version). */
import { chromium, firefox, webkit } from "playwright";
import fs from "node:fs/promises";
import path from "node:path";

const ENGINES = { chromium, firefox, webkit };

function parseArgs(argv) {
  const out = { url: null, width: 1280, height: 900, outDir: "crossbrowser-output", engines: Object.keys(ENGINES) };
  const rest = [];
  for (const a of argv) {
    if (a.startsWith("--width=")) out.width = parseInt(a.slice(8), 10) || out.width;
    else if (a.startsWith("--height=")) out.height = parseInt(a.slice(9), 10) || out.height;
    else if (a.startsWith("--out=")) out.outDir = a.slice(6);
    else if (a.startsWith("--engines=")) out.engines = a.slice(10).split(",").map(s => s.trim()).filter(Boolean);
    else if (!a.startsWith("--")) rest.push(a);
  }
  if (rest.length) out.url = rest[0];
  return out;
}

async function shoot(engineName, url, width, height, outDir) {
  const launcher = ENGINES[engineName];
  if (!launcher) return { engine: engineName, ok: false, error: "unknown engine — use chromium, firefox or webkit" };
  let browser;
  try {
    browser = await launcher.launch();
    const page = await browser.newPage({ viewport: { width, height } });
    await page.goto(url, { waitUntil: "networkidle", timeout: 45_000 });
    await page.waitForTimeout(500); // late webfonts/images a step past load
    const file = path.join(outDir, engineName + ".png");
    await page.screenshot({ path: file, fullPage: true });
    console.log(engineName + " -> " + file);
    return { engine: engineName, ok: true, file };
  } catch (e) {
    console.error(engineName + " failed: " + e.message);
    return { engine: engineName, ok: false, error: e.message };
  } finally {
    if (browser) await browser.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (!opts.url) {
    console.error("usage: node scripts/crossbrowser.mjs <url> [--width=1280] [--height=900] [--out=dir] [--engines=chromium,firefox,webkit]");
    process.exit(1);
  }
  await fs.mkdir(opts.outDir, { recursive: true });
  const results = [];
  for (const engine of opts.engines) {
    results.push(await shoot(engine, opts.url, opts.width, opts.height, opts.outDir));
  }
  await fs.writeFile(path.join(opts.outDir, "results.json"), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok);
  console.log((results.length - failed.length) + " of " + results.length + " engine(s) captured into " + opts.outDir);
  if (failed.length) process.exitCode = 1;
}

main();
