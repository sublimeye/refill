#!/usr/bin/env node
// Fails (exit 1) if any file under <dir> carries a React or Vue runtime marker. Run on the build:
//   node scripts/check-no-frameworks.mjs .output/chrome-mv3
// react, react-dom and vue are devDependencies used only by browser-mode fill tests (Task 10); the
// extension UI is Svelte. If one of them is ever imported from src/ it would ship in the bundle, so
// the gate looks for strings the libraries cannot work without (they survive minification): React's
// element/portal symbols, fiber and props expando prefixes, devtools hook and internals names, Vue's
// reactive flags and app/component expandos. Fail closed: a missing or empty directory is an error.
// No allowlist.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const MARKERS = [
  "react.transitional.element",
  "react.element",
  "react.portal",
  "__reactFiber$",
  "__reactProps$",
  "__REACT_DEVTOOLS_GLOBAL_HOOK__",
  "__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE",
  "__v_isRef",
  "__v_skip",
  "__vue_app__",
  "__vueParentComponent",
  "__VUE__",
];

function* walk(base, rel = "") {
  for (const entry of readdirSync(join(base, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) yield* walk(base, relPath);
    else yield relPath;
  }
}

const dir = process.argv[2];
if (!dir) {
  console.error("usage: check-no-frameworks.mjs <dir>");
  process.exit(2);
}
if (!existsSync(dir) || !statSync(dir).isDirectory()) {
  console.error(`check-no-frameworks: ${dir} is not a directory (build first)`);
  process.exit(2);
}

let files = 0;
const hits = [];
for (const rel of walk(dir)) {
  files++;
  const text = readFileSync(join(dir, rel), "latin1");
  for (const marker of MARKERS) {
    if (text.includes(marker)) hits.push(`${rel}: ${marker}`);
  }
}

if (files === 0) {
  console.error(`check-no-frameworks: no files under ${dir} (build first)`);
  process.exit(2);
}
if (hits.length > 0) {
  console.error(
    "check-no-frameworks: React/Vue marker(s) in the built output:",
  );
  for (const h of hits) console.error(`  ${h}`);
  process.exit(1);
}
console.log(`check-no-frameworks: ${files} files, no React/Vue markers`);
