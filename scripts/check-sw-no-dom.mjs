#!/usr/bin/env node
// Fails if the built service-worker file references a DOM-only API. Run on the PRODUCTION build,
// on the file named by the manifest's background.service_worker:
//   node scripts/check-sw-no-dom.mjs .output/chrome-mv3/background.js
// The worker has no DOM, and DOM modules capture prototypes and getters at import time, so one
// pulled in by a stray import throws at worker startup. The markers below are what such modules
// reference. Fail closed: a missing or empty file is an error (exit 2), not a pass. No allowlist.
import { existsSync, readFileSync, statSync } from "node:fs";

const MARKERS = [
  "HTMLInputElement",
  "MutationObserver",
  "getComputedStyle",
  "elementFromPoint",
  "execCommand",
  "checkVisibility",
  "Node.prototype",
  "Element.prototype",
];

const file = process.argv[2];
if (!file) {
  console.error("usage: check-sw-no-dom.mjs <service-worker-file>");
  process.exit(2);
}
if (!existsSync(file) || !statSync(file).isFile()) {
  console.error(`check-sw-no-dom: ${file} is not a file (build first)`);
  process.exit(2);
}
const text = readFileSync(file, "utf8");
if (text.length === 0) {
  console.error(`check-sw-no-dom: ${file} is empty (build first)`);
  process.exit(2);
}

const hits = MARKERS.filter((m) => text.includes(m));
if (hits.length > 0) {
  console.error(`check-sw-no-dom: DOM-only APIs found in ${file}:`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`check-sw-no-dom: ${file} is DOM-free (${text.length} chars)`);
