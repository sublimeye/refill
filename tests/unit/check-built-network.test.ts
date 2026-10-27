import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = join(__dirname, "../../scripts/check-built-network.mjs");
const run = (dir: string) =>
  spawnSync("node", [script, dir], { encoding: "utf8" });

describe("scripts/check-built-network.mjs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "check-net-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes on JS without network tokens", () => {
    writeFileSync(join(dir, "ok.js"), "const a=document.createElement('p');");
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 JS files");
  });

  it("fails on a fake file containing fetch(", () => {
    writeFileSync(join(dir, "bad.js"), "fetch('https://x.test')");
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("bad.js: fetch(");
  });

  it.each([
    "fetch (u)",
    "new XMLHttpRequest()",
    "new WebSocket(u)",
    "new EventSource(u)",
    "navigator.sendBeacon(u)",
  ])("fails on %s, also in a nested chunk", (code) => {
    mkdirSync(join(dir, "chunks"));
    writeFileSync(join(dir, "chunks", "c.js"), `x();${code};`);
    expect(run(dir).status).toBe(1);
  });

  it("ignores non-JS files and does not flag innerHTML or a bare 'fetch' word", () => {
    writeFileSync(join(dir, "a.html"), "fetch(");
    writeFileSync(join(dir, "b.js"), "t.innerHTML=1;const fetchCount=2;");
    expect(run(dir).status).toBe(0);
  });

  it("exits 2 with no JS files or no argument", () => {
    expect(run(dir).status).toBe(2);
    expect(spawnSync("node", [script]).status).toBe(2);
  });
});
