#!/usr/bin/env node
// Fails if any file under <dir> contains the e2e seam marker. Run on the PRODUCTION build:
//   node scripts/check-no-seams.mjs .output/chrome-mv3
// Every e2e-only seam identifier contains SEAM_MARKER and exists only under
// `import.meta.env.MODE === "e2e"`, which the bundler folds away in production. Fail closed:
// a missing or empty directory is an error, not a pass. No allowlist.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const SEAM_MARKER = "__refillE2E";

function* walk(base, rel = "") {
  for (const entry of readdirSync(join(base, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(base, relPath);
    else yield relPath;
  }
}

const dir = process.argv[2];
if (!dir) {
  console.error("usage: check-no-seams.mjs <dir>");
  process.exit(2);
}
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`check-no-seams: ${dir} is not a directory (build first)`);
  process.exit(2);
}

let files = 0;
const hits = [];
for (const rel of walk(dir)) {
  files++;
  if (readFileSync(join(dir, rel)).includes(SEAM_MARKER)) hits.push(rel);
}

if (files === 0) {
  console.error(`check-no-seams: no files under ${dir} (build first)`);
  process.exit(2);
}
if (hits.length > 0) {
  console.error(`check-no-seams: ${SEAM_MARKER} found in the built output:`);
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`check-no-seams: ${files} files, no ${SEAM_MARKER} seams`);
