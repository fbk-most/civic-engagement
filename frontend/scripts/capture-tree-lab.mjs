#!/usr/bin/env node
/** Screenshots the whole tree-lab.html grid — see src/treeLab.ts. Same
 * Chrome/SwiftShader launch as scripts/capture-view.mjs, but waits for
 * `document.body[data-ready]` (set once every cell has actually painted)
 * instead of a fixed timeout, since there's no async texture/environment
 * loading here to pad for, and shoots the full page rather than one
 * `.viewer-canvas` element, since the point is comparing the whole grid.
 *
 * Usage: node scripts/capture-tree-lab.mjs [url] [outputPath]
 */

import { existsSync } from "node:fs";
import puppeteer from "puppeteer-core";

const url = process.argv[2] ?? "http://localhost:5173/tree-lab.html";
const outputPath = process.argv[3] ?? "/tmp/tree-lab.png";

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
  await page.setViewport({ width: 1700, height: 900, deviceScaleFactor: 1 });
  page.on("pageerror", (err) => console.error("[page error]", err));
  page.on("console", (msg) => {
    if (msg.type() === "error" || msg.type() === "warning") console.error("[page]", msg.text());
  });

  await page.goto(url, { waitUntil: "networkidle0", timeout: 30000 });
  await page.waitForSelector("body[data-ready]", { timeout: 20000 });

  const ready = await page.$eval("body", (el) => el.getAttribute("data-ready"));
  if (ready === "error") throw new Error("treeLab.ts threw — see [page] console output above");

  await page.screenshot({ path: outputPath, fullPage: true });
  console.log(`Saved ${outputPath}`);
} finally {
  await browser.close();
}
