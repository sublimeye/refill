import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = join(__dirname, "../../scripts/check-sw-no-dom.mjs");
const run = (file?: string) =>
  spawnSync("node", file === undefined ? [script] : [script, file], {
    encoding: "utf8",
  });

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

describe("scripts/check-sw-no-dom.mjs", () => {
  let dir: string;
  let file: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "check-sw-dom-"));
    file = join(dir, "background.js");
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes on a clean file", () => {
    writeFileSync(file, "const a = chrome.storage;");
    const r = run(file);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("DOM-free");
  });

  it.each(MARKERS)("fails naming the marker %s", (marker) => {
    writeFileSync(file, `const a = 1; use(${marker}); const b = 2;`);
    const r = run(file);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(marker);
  });

  it("names every marker found, not only the first", () => {
    writeFileSync(file, "new MutationObserver(); getComputedStyle(x);");
    const r = run(file);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("MutationObserver");
    expect(r.stderr).toContain("getComputedStyle");
    expect(r.stderr).not.toContain("execCommand");
  });

  it("fails closed (exit 2) on a missing file, an empty file, a directory and no argument", () => {
    expect(run(join(dir, "missing.js")).status).toBe(2);
    writeFileSync(file, "");
    expect(run(file).status).toBe(2);
    expect(run(dir).status).toBe(2);
    expect(run().status).toBe(2);
  });
});
