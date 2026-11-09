import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

type Manifest = Record<string, unknown>;

const built = JSON.parse(
  readFileSync(".output/chrome-mv3/manifest.json", "utf8"),
) as Manifest;

// Absent arrays become [] and absent objects become null, so a missing or
// unexpected key shows up as a snapshot diff, never as a TypeError.
const arr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
const obj = (v: unknown): unknown => v ?? null;

const pick = (m: Manifest) => ({
  permissions: arr(m.permissions).map(String).sort(),
  optional_permissions: arr(m.optional_permissions),
  optional_host_permissions: arr(m.optional_host_permissions),
  host_permissions: arr(m.host_permissions),
  externally_connectable: obj(m.externally_connectable),
  content_security_policy: obj(m.content_security_policy),
  sandbox: obj(m.sandbox),
  commands: obj(m.commands),
  declarative_net_request: obj(m.declarative_net_request),
  background: obj(m.background),
  web_accessible_resources: arr(m.web_accessible_resources),
  content_scripts: arr(m.content_scripts),
  minimum_chrome_version: m.minimum_chrome_version,
  has_key: typeof m.key === "string",
});

test("security-relevant manifest keys match the reviewed snapshot", () => {
  expect(pick(built)).toEqual(
    JSON.parse(readFileSync("security/manifest.expected.json", "utf8")),
  );
});

// ADR 0026: page markup can answer a `globalThis.browser` lookup in the content script's isolated
// world (`<form id="browser">`), so the content bundle reads only the `chrome` it checks itself
// and must not carry WXT's `browser` fallback (it arrives with any runtime import of `wxt/browser`).
test("the content script never looks up globalThis.browser", () => {
  const js = readFileSync(".output/chrome-mv3/refill-content.js", "utf8");
  expect(js).not.toMatch(
    /globalThis\s*\.\s*browser|globalThis\s*\[\s*["'`]browser/,
  );
  expect(js).toContain("globalThis.chrome");
});

// Chrome accepts raster icons only, and the store needs the 128 px one in the package.
test("the package ships a PNG icon of every size the manifest names", () => {
  const icons = built.icons as Record<string, string>;
  expect(Object.keys(icons).sort()).toEqual(["128", "16", "32", "48"]);
  for (const [size, path] of Object.entries(icons)) {
    const png = readFileSync(`.output/chrome-mv3/${path}`);
    expect(png.subarray(1, 4).toString()).toBe("PNG");
    expect(png.readUInt32BE(16)).toBe(Number(size)); // IHDR width
    expect(png.readUInt32BE(20)).toBe(Number(size)); // IHDR height
  }
});
