import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { aad } from "../../../src/lib/crypto/aad";
import { DecryptError } from "../../../src/lib/crypto/aead";
import { newKdfParams } from "../../../src/lib/crypto/kdf";
import { getItem, withStoreLock } from "../../../src/lib/store/local";
import { getEncrypted, putEncrypted } from "../../../src/lib/vault/records";
import { LockedError } from "../../../src/lib/vault/types";
import {
  __resetForTests,
  createVault,
  lock,
  unlockWithPassphrase,
} from "../../../src/lib/vault/vault";

const P = "correct horse battery staple";
const A = aad.profile("x", "https://a.example");
const B = aad.profile("x", "https://b.example");

let snapshot: Record<string, unknown>;

beforeAll(async () => {
  fakeBrowser.reset();
  await createVault(P, newKdfParams());
  snapshot = structuredClone(await fakeBrowser.storage.local.get(null));
}, 30_000);

beforeEach(async () => {
  fakeBrowser.reset();
  __resetForTests();
  await fakeBrowser.storage.local.set(structuredClone(snapshot));
  expect((await unlockWithPassphrase(P)).ok).toBe(true);
});

describe("records", { timeout: 30_000 }, () => {
  it("putEncrypted / getEncrypted round-trip JSON; ciphertext only at rest", async () => {
    const value = { name: "Jane", n: 3, list: [1, "two", null], ok: true };
    await putEncrypted("p:x", A, value);
    expect(await getEncrypted("p:x", A)).toEqual(value);
    const stored = await getItem("p:x");
    expect(stored).toEqual({ iv: expect.any(String), ct: expect.any(String) });
    expect(JSON.stringify(stored)).not.toContain("Jane");
  });

  it("returns undefined for a missing record", async () => {
    expect(await getEncrypted("p:missing", A)).toBeUndefined();
  });

  it("reading with a different AAD throws DecryptError", async () => {
    await putEncrypted("p:x", A, { name: "Jane" });
    await expect(getEncrypted("p:x", B)).rejects.toBeInstanceOf(DecryptError);
  });

  it("a malformed stored record throws DecryptError", async () => {
    await fakeBrowser.storage.local.set({ "p:x": "garbage" });
    await expect(getEncrypted("p:x", A)).rejects.toBeInstanceOf(DecryptError);
  });

  it("writes through a StoreTx inside withStoreLock", async () => {
    await withStoreLock((tx) => putEncrypted("p:y", A, { a: 1 }, tx));
    expect(await getEncrypted("p:y", A)).toEqual({ a: 1 });
  });

  it("rejects a value that has no JSON form", async () => {
    await expect(putEncrypted("p:z", A, undefined)).rejects.toBeInstanceOf(
      TypeError,
    );
  });

  it("when locked both throw LockedError", async () => {
    await putEncrypted("p:x", A, { name: "Jane" });
    await lock();
    await expect(
      putEncrypted("p:x", A, { name: "Bob" }),
    ).rejects.toBeInstanceOf(LockedError);
    await expect(getEncrypted("p:x", A)).rejects.toBeInstanceOf(LockedError);
    await expect(getEncrypted("p:missing", A)).rejects.toBeInstanceOf(
      LockedError,
    );
  });
});
