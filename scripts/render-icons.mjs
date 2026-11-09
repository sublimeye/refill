// Renders public/icon/{16,32,48,128}.png from assets/icon.svg with the Chromium Playwright already
// installs. Run it by hand after changing the SVG: node scripts/render-icons.mjs
import { mkdirSync, readFileSync } from "node:fs";
import { chromium } from "@playwright/test";

const svg = readFileSync("assets/icon.svg", "utf8");
mkdirSync("public/icon", { recursive: true });
const browser = await chromium.launch();
for (const size of [16, 32, 48, 128]) {
  const page = await browser.newPage({
    viewport: { width: size, height: size },
  });
  // The store wants 96 px of art inside 16 px of clear space at 128; small sizes use every pixel.
  const art =
    size === 128
      ? svg.replace('viewBox="0 0 96 96"', 'viewBox="-16 -16 128 128"')
      : svg;
  await page.setContent(
    `<!doctype html><style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${art}`,
  );
  await page.screenshot({
    path: `public/icon/${size}.png`,
    omitBackground: true,
  });
  await page.close();
}
await browser.close();
