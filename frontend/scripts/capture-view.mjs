#!/usr/bin/env node
/** Renders the 3D viewer headlessly and saves a screenshot — the point being
 * to close the loop on rendering bugs without a screenshot-and-describe round
 * trip through a human. Point it at a URL from the app's own "Copia URL
 * vista" button (or build one by hand: `?viewer=1&t=&month=&day=&hour=` and
 * optionally `&lng=&lat=&eyeHeight=&bearing=&pitch=&fov=` for a placed pose —
 * see src/debugParams.ts) against an *already-running* dev server; this does
 * not start one itself, since a facilitator or developer may already have
 * their own session live on the same machine.
 *
 * Uses the system's real Chrome via puppeteer-core (not the full `puppeteer`
 * package's bundled download) so this actually is the browser the app ships
 * to, software-rendering WebGL2 through SwiftShader since a CI/dev box
 * commonly has no GPU.
 *
 * Usage: node scripts/capture-view.mjs "<url>" [outputPath]
 */

import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const url = process.argv[2];
const outputPath = process.argv[3] ?? "/tmp/capture.png";

if (!url) {
  console.error("Usage: node scripts/capture-view.mjs <url> [outputPath]");
  process.exit(1);
}

const CHROME_CANDIDATES = ["/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

function findChrome() {
  for (const path of CHROME_CANDIDATES) {
    if (existsSync(path)) return path;
  }
  throw new Error(`No Chrome/Chromium found in: ${CHROME_CANDIDATES.join(", ")}`);
}

const browser = await puppeteer.launch({
  executablePath: findChrome(),
  headless: true,
  args: [
    "--no-sandbox",
    "--disable-setuid-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-webgl",
    "--ignore-gpu-blocklist",
  ],
});

try {
  const page = await browser.newPage();
  await page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 });
  page.on("pageerror", (err) => console.error("[page error]", err));
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") console.error("[page]", msg.text());
  });

  await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector(".viewer-canvas canvas", { timeout: 20000 });
  // The scene rebuilds asynchronously after load (baseline fetch, ground/
  // facade textures, sky→environment prefilter), and the render loop needs a
  // few frames to settle after that — cheaper and more reliable than trying
  // to hook a "done rendering" signal out of three.js's animation loop.
  await new Promise((resolve) => setTimeout(resolve, 3000));

  const canvas = await page.$(".viewer-canvas");
  if (!canvas) throw new Error("'.viewer-canvas' not found — did ?viewer=1 open the panel?");
  await canvas.screenshot({ path: outputPath });
  console.log(`Saved ${outputPath}`);
} finally {
  await browser.close();
}
