#!/usr/bin/env node
// Prints one line: sha256 over the sorted list of `relativePath\0sha256(file)\n`
// for every file under <dir>. Used by CI to compare two clean builds.
import { createHash } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: hash-dir.mjs <dir>");
  process.exit(2);
}

function walk(base, rel = "") {
  const files = [];
  for (const entry of readdirSync(join(base, rel), { withFileTypes: true })) {
    const relPath = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...walk(base, relPath));
    else files.push(relPath);
  }
  return files;
}

const sha256 = (data) => createHash("sha256").update(data).digest("hex");

// Default sort compares UTF-16 code units, which is deterministic across platforms.
const files = walk(dir).sort();
const total = createHash("sha256");
for (const rel of files) {
  total.update(`${rel}\0${sha256(readFileSync(join(dir, rel)))}\n`);
}
console.log(total.digest("hex"));
