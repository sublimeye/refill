import { describe, expect, it } from "vitest";
import {
  FILL_GRANT_MS,
  grantFill,
  takeGrant,
} from "../../../src/lib/sites/fill-now";

const A = "https://a.example.com";
const B = "https://b.example.com";
const T = 1_700_000_000_000;

describe("fill grants", () => {
  it("lasts ten seconds", () => {
    expect(FILL_GRANT_MS).toBe(10_000);
  });

  it("succeeds once, then false", () => {
    grantFill(1, A, T);
    expect(takeGrant(1, A, T + 1)).toBe(true);
    expect(takeGrant(1, A, T + 2)).toBe(false);
  });

  it("is false with no grant", () => {
    expect(takeGrant(90, A, T)).toBe(false);
  });

  it("is false for another tab", () => {
    grantFill(2, A, T);
    expect(takeGrant(3, A, T)).toBe(false);
    expect(takeGrant(2, A, T)).toBe(true);
  });

  it("is false for another origin and keeps the grant for its own", () => {
    grantFill(4, A, T);
    expect(takeGrant(4, B, T)).toBe(false);
    expect(takeGrant(4, A, T)).toBe(true);
  });

  it("is valid until, and not at, grantedAt + 10 s", () => {
    grantFill(5, A, T);
    expect(takeGrant(5, A, T + FILL_GRANT_MS - 1)).toBe(true);
    grantFill(5, A, T);
    expect(takeGrant(5, A, T + FILL_GRANT_MS)).toBe(false);
  });

  it("an expired grant stays spent", () => {
    grantFill(6, A, T);
    expect(takeGrant(6, A, T + FILL_GRANT_MS)).toBe(false);
    expect(takeGrant(6, A, T + 1)).toBe(false);
  });

  it("a new grant replaces the old one", () => {
    grantFill(7, A, T);
    grantFill(7, B, T + 5_000);
    expect(takeGrant(7, A, T + 5_001)).toBe(false);
    expect(takeGrant(7, B, T + 5_002)).toBe(true);
    // The new grant's own clock, not the old one's.
    grantFill(8, A, T);
    grantFill(8, A, T + 9_000);
    expect(takeGrant(8, A, T + 15_000)).toBe(true);
  });
});
