// Throwaway automation for probes (b) and (d). Usage: npm i playwright (outside repo); node run-playwright.mjs [chromium|brave]
import { chromium } from "playwright";
import os from "os"; import fs from "fs"; import path from "path";
const ext = path.dirname(new URL(import.meta.url).pathname);
const [,, which = "chromium"] = process.argv;
const opts = { headless: false, args: [`--disable-extensions-except=${ext}`, `--load-extension=${ext}`], ignoreDefaultArgs: ["--disable-extensions"] };
if (which === "brave") opts.executablePath = "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser";
else opts.channel = "chromium";
const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pw-prof-"));
const ctx = await chromium.launchPersistentContext(dir, opts);
console.log("browser:", ctx.browser()?.version?.());
let sw = ctx.serviceWorkers()[0];
if (!sw) { try { sw = await ctx.waitForEvent("serviceworker", { timeout: 5000 }); } catch {} }
console.log("sw:", sw?.url());
// no background in manifest; find extension id via chrome://extensions fallback
let id = sw ? new URL(sw.url()).host : null;
if (!id) {
  const p = await ctx.newPage();
  await p.goto("chrome://extensions");
  await p.waitForTimeout(1500);
  id = await p.evaluate(() => { const m = document.querySelector("extensions-manager"); return m?.shadowRoot?.querySelector("extensions-item-list")?.shadowRoot?.querySelector("extensions-item")?.id; }).catch(()=>null);
  console.log("ext id from page:", id);
}
if (!id) { console.log("NO EXTENSION LOADED"); await ctx.close(); process.exit(2); }
const page = await ctx.newPage();
await page.goto(`chrome-extension://${id}/probe.html`);
console.log("UA:", await page.evaluate(() => navigator.userAgent));
console.log("hashwasm:", await page.evaluate(() => typeof hashwasm?.argon2id));
await page.click("#b-run");
await page.waitForFunction(() => window.__results?.b?.t6, null, { timeout: 120000 });
console.log("RESULT_B", JSON.stringify(await page.evaluate(() => window.__results.b)));
const ins = await ctx.newPage();
await ins.goto(`chrome-extension://${id}/insert.html`);
await ins.click("#go");
await ins.waitForTimeout(300);
console.log("RESULT_D", JSON.stringify(await ins.evaluate(() => ({ events: window.__events, execOk: window.__execOk, value: document.getElementById("field").value }))));
await ctx.close();
