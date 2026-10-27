import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const script = join(__dirname, "../../scripts/check-no-frameworks.mjs");
const run = (dir?: string) =>
  spawnSync("node", dir === undefined ? [script] : [script, dir], {
    encoding: "utf8",
  });

// One line per framework marker, as the minified libraries spell them.
const SAMPLES: [string, string][] = [
  ["react element symbol", `Symbol.for("react.transitional.element")`],
  ["legacy react element symbol", `Symbol.for("react.element")`],
  ["react portal symbol", `Symbol.for("react.portal")`],
  ["react fiber expando", `"__reactFiber$"+Math.random()`],
  ["react props expando", `"__reactProps$"+Math.random()`],
  ["react devtools hook", `window.__REACT_DEVTOOLS_GLOBAL_HOOK__`],
  [
    "react client internals",
    `e.__CLIENT_INTERNALS_DO_NOT_USE_OR_WARN_USERS_THEY_CANNOT_UPGRADE`,
  ],
  ["vue ref flag", `t.__v_isRef===!0`],
  ["vue skip flag", `e.__v_skip`],
  ["vue app expando", `el.__vue_app__=app`],
  ["vue component expando", `el.__vueParentComponent`],
  ["vue feature flag", `globalThis.__VUE__=!0`],
];

describe("scripts/check-no-frameworks.mjs", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "check-frameworks-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("passes on a clean directory", () => {
    writeFileSync(
      join(dir, "ok.js"),
      "const reactive = 1; // react and vue are fine as words",
    );
    const r = run(dir);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("1 files");
  });

  it.each(SAMPLES)("fails on %s", (_name, text) => {
    writeFileSync(join(dir, "a.js"), `var x=${JSON.stringify("pad")};${text};`);
    const r = run(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("a.js");
  });

  it("finds a marker in a nested file and in a non-JS file", () => {
    mkdirSync(join(dir, "chunks"));
    writeFileSync(join(dir, "chunks", "c.html"), "<p>__v_isRef</p>");
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
