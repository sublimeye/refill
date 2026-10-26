import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it } from "vitest";
import {
  checkBackoff,
  delayFor,
  recordFailure,
  resetBackoff,
} from "../../../src/lib/vault/backoff";

const NOW = 1_700_000_000_000;
const KEY = "vault:backoff";

beforeEach(() => {
  fakeBrowser.reset();
});

describe("delayFor", () => {
  it("is 0 for no failures, then 1 s doubling, capped at 60 s", () => {
    expect(delayFor(0)).toBe(0);
    expect(delayFor(1)).toBe(1000);
    expect(delayFor(2)).toBe(2000);
    expect(delayFor(3)).toBe(4000);
    expect(delayFor(6)).toBe(32_000);
    expect(delayFor(7)).toBe(60_000);
    expect(delayFor(20)).toBe(60_000);
    expect(delayFor(10_000)).toBe(60_000);
  });
});

describe("backoff state", () => {
  it("is 0 with no stored state", async () => {
    expect(await checkBackoff(NOW)).toBe(0);
  });

  it("after 3 failures waits 4000 ms, counting down with time", async () => {
    await recordFailure(NOW);
    await recordFailure(NOW);
    await recordFailure(NOW);
    expect(await checkBackoff(NOW)).toBe(4000);
    expect(await checkBackoff(NOW + 1500)).toBe(2500);
    expect(await checkBackoff(NOW + 4000)).toBe(0);
    expect(await checkBackoff(NOW + 9999)).toBe(0);
    expect(await fakeBrowser.storage.session.get(KEY)).toEqual({
      [KEY]: { failures: 3, nextAllowedAt: NOW + 4000 },
    });
  });

  it("resetBackoff clears failures", async () => {
    await recordFailure(NOW);
    await resetBackoff();
    expect(await checkBackoff(NOW)).toBe(0);
    await recordFailure(NOW);
    expect(await checkBackoff(NOW)).toBe(1000); // count restarted at 1
  });

  it("clamps a far-future nextAllowedAt (clock moved back) to 60 s and persists the clamp", async () => {
    await fakeBrowser.storage.session.set({
      [KEY]: { failures: 2, nextAllowedAt: NOW + 10 * 86_400_000 },
    });
    expect(await checkBackoff(NOW)).toBe(60_000);
    expect(await checkBackoff(NOW + 60_000)).toBe(0);
  });

  it("treats malformed stored state as no backoff and recovers", async () => {
    for (const bad of [
      "x",
      null,
      { failures: -1, nextAllowedAt: NOW },
      { failures: 1, nextAllowedAt: "soon" },
      { failures: 1.5, nextAllowedAt: NOW },
    ]) {
      await fakeBrowser.storage.session.set({ [KEY]: bad });
      expect(await checkBackoff(NOW)).toBe(0);
      await recordFailure(NOW);
      expect(await checkBackoff(NOW)).toBe(1000);
      await resetBackoff();
    }
  });
});
