import { createHash } from "node:crypto";
import { describe, expect, test } from "vitest";
import { EXTENSION_ID, MANIFEST_KEY } from "../../src/manifest-key";

describe("manifest key", () => {
  test("EXTENSION_ID is Chrome's derivation of MANIFEST_KEY", () => {
    const der = Buffer.from(MANIFEST_KEY, "base64");
    const hex = createHash("sha256").update(der).digest("hex").slice(0, 32);
    const id = [...hex]
      .map((c) => String.fromCharCode("a".charCodeAt(0) + parseInt(c, 16)))
      .join("");
    expect(id).toBe(EXTENSION_ID);
  });
});
