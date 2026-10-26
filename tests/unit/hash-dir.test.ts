import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = join(__dirname, "../../scripts/hash-dir.mjs");
const sha = (s: string) => createHash("sha256").update(s).digest("hex");
const run = (dir: string) =>
  execFileSync("node", [script, dir], { encoding: "utf8" });

describe("scripts/hash-dir.mjs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "hash-dir-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("hashes sorted `relativePath\\0sha256(file)\\n` entries and prints one line", () => {
    mkdirSync(join(dir, "sub"));
    writeFileSync(join(dir, "b.txt"), "bee");
    writeFileSync(join(dir, "a.txt"), "ay");
    writeFileSync(join(dir, "sub", "c.txt"), "sea");
    const expected = sha(
      `a.txt\0${sha("ay")}\nb.txt\0${sha("bee")}\nsub/c.txt\0${sha("sea")}\n`,
    );
    expect(run(dir)).toBe(`${expected}\n`);
  });

  it("changes when content or file name changes, not with creation order", () => {
    writeFileSync(join(dir, "a.txt"), "1");
    writeFileSync(join(dir, "b.txt"), "2");
    const base = run(dir);

    const other = mkdtempSync(join(tmpdir(), "hash-dir-"));
    try {
      writeFileSync(join(other, "b.txt"), "2");
      writeFileSync(join(other, "a.txt"), "1");
      expect(run(other)).toBe(base);

      writeFileSync(join(other, "a.txt"), "changed");
      expect(run(other)).not.toBe(base);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });

  it("exits 2 with usage when no directory is given", () => {
    expect(() =>
      execFileSync("node", [script], { stdio: "pipe" }),
    ).toThrowError(/usage/);
  });
});
