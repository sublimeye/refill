// Refill's replacement for the `deepmerge` npm package (vendor/deepmerge, wired in through
// pnpm.overrides). Same 4.x API; refuses prototype-poisoning keys (GHSA-gcqx-w48m-w2h4).
import { createRequire } from "node:module";
import { afterEach, describe, expect, it } from "vitest";

type Merge = {
  (a: unknown, b: unknown, options?: Record<string, unknown>): unknown;
  all(items: unknown[], options?: Record<string, unknown>): unknown;
};

const require = createRequire(import.meta.url);
const deepmerge = require("../../vendor/deepmerge/index.cjs") as Merge;

afterEach(() => {
  delete (Object.prototype as Record<string, unknown>)["polluted"];
});

describe("vendored deepmerge: API", () => {
  it("merges nested objects without mutating the inputs", () => {
    const a = { x: { y: 1 }, keep: true };
    const b = { x: { z: 2 } };
    const out = deepmerge(a, b) as Record<string, unknown>;
    expect(out).toEqual({ x: { y: 1, z: 2 }, keep: true });
    expect(a).toEqual({ x: { y: 1 }, keep: true });
    expect(out["x"]).not.toBe(a.x);
  });

  it("concatenates arrays by default and honours arrayMerge", () => {
    expect(deepmerge({ a: [1] }, { a: [2] })).toEqual({ a: [1, 2] });
    const replace = (t: unknown[], s: unknown[]) => s ?? t;
    expect(deepmerge({ a: [1] }, { a: [2] }, { arrayMerge: replace })).toEqual({
      a: [2],
    });
  });

  it("source wins for non-mergeable values; Date and RegExp are not merged", () => {
    const d = new Date(0);
    const out = deepmerge({ a: 1, d: { x: 1 } }, { a: 2, d }) as Record<
      string,
      unknown
    >;
    expect(out["a"]).toBe(2);
    expect(out["d"]).toBe(d);
  });

  it("merges the way vite-plugin-svelte calls it", () => {
    const replace = (t: unknown[], s: unknown[]) => s ?? t;
    let result: unknown = {};
    for (const config of [
      { compilerOptions: { dev: true }, extensions: [".svelte"] },
      { compilerOptions: { css: "external" }, extensions: [".svx"] },
    ]) {
      result = deepmerge(result, config, { arrayMerge: replace });
    }
    expect(result).toEqual({
      compilerOptions: { dev: true, css: "external" },
      extensions: [".svx"],
    });
  });

  it("all() merges left to right and rejects a non-array", () => {
    expect(deepmerge.all([{ a: 1 }, { b: 2 }, { a: 3 }])).toEqual({
      a: 3,
      b: 2,
    });
    expect(() => deepmerge.all({} as unknown as unknown[])).toThrow();
  });
});

describe("vendored deepmerge: prototype poisoning", () => {
  it("ignores a __proto__ key in the source", () => {
    const evil = JSON.parse('{"__proto__": {"polluted": "yes"}, "ok": 1}');
    const out = deepmerge({}, evil) as Record<string, unknown>;
    expect(out["ok"]).toBe(1);
    expect(out["polluted"]).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("ignores a nested __proto__ and constructor.prototype", () => {
    const evil = JSON.parse(
      '{"a": {"__proto__": {"polluted": "yes"}}, "constructor": {"prototype": {"polluted": "yes"}}}',
    );
    const out = deepmerge({ a: {} }, evil) as Record<string, unknown>;
    expect((out["a"] as Record<string, unknown>)["polluted"]).toBeUndefined();
    expect(Object.hasOwn(out, "constructor")).toBe(false);
    expect(({} as Record<string, unknown>)["polluted"]).toBeUndefined();
  });

  it("does not overwrite keys the target only inherits", () => {
    const out = deepmerge({}, { toString: "x", hasOwnProperty: 1 }) as Record<
      string,
      unknown
    >;
    expect(Object.hasOwn(out, "toString")).toBe(false);
    expect(Object.hasOwn(out, "hasOwnProperty")).toBe(false);
  });

  it("tolerates a non-object target", () => {
    expect(deepmerge(undefined, { a: 1 })).toEqual({ a: 1 });
  });
});
