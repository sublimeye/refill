#!/usr/bin/env node
// Fails (exit 1) if any JS file under <dir> contains a network-API token. Run after the build:
//   node scripts/check-built-network.mjs .output/chrome-mv3
// Source-level bans are enforced by Semgrep on src/ only; this gives the shipped bundle
// (including dependencies and Vite's own helpers) the same check. ADR 0016. No allowlist.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const TOKENS = [
  ["fetch(", /fetch\s*\(/],
  ["XMLHttpRequest", /XMLHttpRequest/],
  ["WebSocket(", /WebSocket\s*\(/],
  ["EventSource(", /EventSource\s*\(/],
  ["sendBeacon", /sendBeacon/],
];

function* walk(base, rel = "") {
  for (const entry of readdirSync(join(base, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(base, relPath);
    else if (/\.(?:js|mjs|cjs)$/.test(entry.name)) yield relPath;
  }
}

const dir = process.argv[2];
if (!dir) {
  console.error("usage: check-built-network.mjs <dir>");
  process.exit(2);
}

let files = 0;
const hits = [];
for (const rel of walk(dir)) {
  files++;
  const text = readFileSync(join(dir, rel), "utf8");
  for (const [name, re] of TOKENS) {
    const m = re.exec(text);
    if (!m) continue;
    const from = Math.max(0, m.index - 40);
    const context = text.slice(from, m.index + 60).replace(/\s+/g, " ");
    hits.push(`${rel}: ${name} ... ${context}`);
  }
}

if (files === 0) {
  console.error(`check-built-network: no JS files under ${dir} (build first)`);
  process.exit(2);
}
if (hits.length > 0) {
  console.error(
    "check-built-network: network API token(s) in the built output:",
  );
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`check-built-network: ${files} JS files, no network tokens`);
