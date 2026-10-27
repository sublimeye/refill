import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = join(__dirname, "../../scripts/check-no-seams.mjs");
const run = (dir?: string) =>
  spawnSync("node", dir === undefined ? [script] : [script, dir], {
    encoding: "utf8",
  });

describe("scripts/check-no-seams.mjs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "check-seams-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes on a clean directory", () => {
    writeFileSync(join(dir, "ok.js"), "const a = 1;");
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 files");
  });

  it("fails naming the file that contains the seam marker", () => {
    writeFileSync(join(dir, "a.js"), "globalThis.__refillE2E_clock = 1;");
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("a.js");
  });

  it("finds the marker in a nested file and in a non-JS file", () => {
    mkdirSync(join(dir, "chunks"));
    writeFileSync(join(dir, "chunks", "c.html"), "<p>__refillE2E</p>");
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("chunks/c.html");
  });

  it("fails closed on an empty directory, a missing directory and no argument", () => {
    expect(run(dir).status).not.toBe(0);
    expect(run(join(dir, "missing")).status).not.toBe(0);
    expect(run().status).not.toBe(0);
  });
});
