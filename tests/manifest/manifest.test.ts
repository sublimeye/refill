import { readFileSync } from "node:fs";
import { expect, test } from "vitest";

interface Manifest {
  permissions: string[];
  optional_host_permissions?: string[];
  host_permissions?: string[];
  externally_connectable?: unknown;
  content_security_policy?: unknown;
  web_accessible_resources?: unknown[];
  content_scripts?: unknown[];
  minimum_chrome_version?: string;
  key?: string;
}

const built = JSON.parse(
  readFileSync(".output/chrome-mv3/manifest.json", "utf8"),
) as Manifest;

const pick = (m: Manifest) => ({
  permissions: [...m.permissions].sort(),
  optional_host_permissions: m.optional_host_permissions,
  host_permissions: m.host_permissions ?? [],
  externally_connectable: m.externally_connectable,
  content_security_policy: m.content_security_policy,
  web_accessible_resources: m.web_accessible_resources ?? [],
  content_scripts: m.content_scripts ?? [],
  minimum_chrome_version: m.minimum_chrome_version,
  has_key: typeof m.key === "string",
});

test("security-relevant manifest keys match the reviewed snapshot", () => {
  expect(pick(built)).toEqual(
    JSON.parse(readFileSync("security/manifest.expected.json", "utf8")),
  );
});
