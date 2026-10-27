import { describe, expect, it } from "vitest";
import { normalizeOrigin, originPattern } from "../../../src/lib/sites/origin";

describe("normalizeOrigin", () => {
  it("punycodes, drops default port, path and query", () => {
    expect(normalizeOrigin("https://BÜCHER.example:443/x?y")).toBe(
      "https://xn--bcher-kva.example",
    );
  });

  it("keeps a non-default port", () => {
    expect(normalizeOrigin("https://example.com:8443/a")).toBe(
      "https://example.com:8443",
    );
  });

  it.each([
    "http://example.com",
    "file:///etc/passwd",
    "chrome-extension://abcdefghijklmnop/page.html",
    "garbage",
    "",
  ])("rejects %s", (u) => {
    expect(normalizeOrigin(u)).toBeNull();
  });
});

describe("originPattern", () => {
  it("appends /*", () => {
    expect(originPattern("https://example.com:8443")).toBe(
      "https://example.com:8443/*",
    );
  });
});
