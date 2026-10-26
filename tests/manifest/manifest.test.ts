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
