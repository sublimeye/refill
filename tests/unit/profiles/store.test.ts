import { fakeBrowser } from "wxt/testing/fake-browser";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { aad } from "../../../src/lib/crypto/aad";
import { newKdfParams } from "../../../src/lib/crypto/kdf";
import {
  loadProfileForOrigin,
  newId,
  saveProfile,
} from "../../../src/lib/profiles/store";
import type { Profile } from "../../../src/lib/profiles/types";
import { readSites, upsertSite } from "../../../src/lib/sites";
import { getItem, profileKey } from "../../../src/lib/store/local";
import { putEncrypted } from "../../../src/lib/vault/records";
import { LockedError } from "../../../src/lib/vault/types";
import {
  __resetForTests,
  createVault,
  lock,
  unlockWithPassphrase,
} from "../../../src/lib/vault/vault";

const P = "correct horse battery staple";
const A = "https://a.example";
const B = "https://b.example";

const sig = {
  name: "email",
  idStable: null,
  autocomplete: "email",
  type: "email",
  labelText: "Email",
  ordinal: 0,
  formAction: null,
  nameIdDerived: false,
};

function profile(id: string, origin = A, name = "Jane Doe"): Profile {
  return {
    v: 1,
    id,
    name,
    origin,
    pathPrefix: "/signup",
    fillMode: "auto",
    createdAt: 1000,
    lastUsedAt: null,
    steps: [{ index: 0, pathHint: "/signup", fingerprint: ["x"] }],
    fields: [
      {
        id: "f1",
        sig,
        step: 0,
        kind: "text",
        value: "jane@secret.example",
        pageDefault: "",
        policy: "save",
      },
    ],
  };
}

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

afterEach(() => vi.restoreAllMocks());

describe("newId", () => {
  it("is 22 chars of base64url, unique, without padding or pipe", () => {
    const ids = new Set(Array.from({ length: 200 }, newId));
    expect(ids.size).toBe(200);
    for (const id of ids) expect(id).toMatch(/^[A-Za-z0-9_-]{22}$/);
  });
});

describe("profiles", { timeout: 30_000 }, () => {
  it("round-trips through the site index; ciphertext only at rest", async () => {
    const p = profile("p1");
    await saveProfile(p);
    expect(await loadProfileForOrigin(A)).toEqual(p);
    expect((await readSites())[A]!.profileId).toBe("p1");
    const stored = JSON.stringify(await getItem(profileKey("p1")));
    expect(stored).not.toContain("secret.example");
    expect(stored).not.toContain("Jane Doe");
  });

  it("returns null when there is no site, no profile or no record", async () => {
    expect(await loadProfileForOrigin(A)).toBeNull();
    await upsertSite(A, {});
    expect(await loadProfileForOrigin(A)).toBeNull();
    await upsertSite(A, { profileId: "ghost" });
    expect(await loadProfileForOrigin(A)).toBeNull();
  });

  it("returns null for a non-canonical origin and for a stored id that is not an id", async () => {
    expect(await loadProfileForOrigin("https://a.example/x")).toBeNull();
    await upsertSite(A, { profileId: "a|b" });
    expect(await loadProfileForOrigin(A)).toBeNull();
  });

  it("replacing a site's profile removes the old record", async () => {
    await saveProfile(profile("old"));
    await saveProfile(profile("new", A, "Newer"));
    expect(await getItem(profileKey("old"))).toBeUndefined();
    expect((await loadProfileForOrigin(A))!.name).toBe("Newer");
    expect((await readSites())[A]!.profileId).toBe("new");
  });

  it("saving the same id again overwrites and keeps the record", async () => {
    await saveProfile(profile("p1"));
    await saveProfile(profile("p1", A, "Renamed"));
    expect((await loadProfileForOrigin(A))!.name).toBe("Renamed");
    expect(await getItem(profileKey("p1"))).toBeDefined();
  });

  it("keeps other sites' profiles and site settings", async () => {
    await upsertSite(A, { drafts: true, ttl: null });
    await saveProfile(profile("pa"));
    await saveProfile(profile("pb", B));
    const sites = await readSites();
    expect(sites[A]).toMatchObject({
      profileId: "pa",
      drafts: true,
      ttl: null,
    });
    expect(sites[B]!.profileId).toBe("pb");
    expect((await loadProfileForOrigin(B))!.id).toBe("pb");
  });

  it("rejects an invalid profile and writes nothing", async () => {
    const bad = { ...profile("p1"), fillMode: "x" } as unknown as Profile;
    await expect(saveProfile(bad)).rejects.toThrow(TypeError);
    expect(await getItem(profileKey("p1"))).toBeUndefined();
    expect(await readSites()).toEqual({});
  });

  it("rejects an id already used by another site", async () => {
    await saveProfile(profile("shared"));
    await expect(saveProfile(profile("shared", B))).rejects.toThrow(TypeError);
    expect((await readSites())[B]).toBeUndefined();
    expect((await loadProfileForOrigin(A))!.id).toBe("shared");
  });

  it("AAD binds the origin: a record copied under another site's key fails", async () => {
    await saveProfile(profile("pa"));
    await saveProfile(profile("pb", B));
    // Attacker with storage write access copies A's record over B's.
    await fakeBrowser.storage.local.set({
      [profileKey("pb")]: await getItem(profileKey("pa")),
    });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadProfileForOrigin(B)).toBeNull();
    expect(err).toHaveBeenCalledWith(expect.any(String), "DecryptError");
    // ...and the same record under a new id for B also fails.
    await fakeBrowser.storage.local.set({
      [profileKey("pc")]: await getItem(profileKey("pa")),
    });
    await upsertSite(B, { profileId: "pc" });
    expect(await loadProfileForOrigin(B)).toBeNull();
  });

  it("rejects a profile whose plaintext origin differs from the requested one", async () => {
    // Sealed with A's AAD but claiming origin B inside: only the in-plaintext check catches it.
    await putEncrypted(profileKey("t"), aad.profile("t", A), profile("t", B));
    await upsertSite(A, { profileId: "t" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadProfileForOrigin(A)).toBeNull();
  });

  it("rejects a profile whose plaintext id differs from the record's id", async () => {
    await putEncrypted(profileKey("t"), aad.profile("t", A), profile("other"));
    await upsertSite(A, { profileId: "t" });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadProfileForOrigin(A)).toBeNull();
  });

  it("returns null and logs the name only when the record does not parse", async () => {
    await putEncrypted(profileKey("t"), aad.profile("t", A), {
      ...profile("t"),
      extra: "SECRET-VALUE",
    });
    await upsertSite(A, { profileId: "t" });
    const err = vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadProfileForOrigin(A)).toBeNull();
    expect(err).toHaveBeenCalled();
    expect(JSON.stringify(err.mock.calls)).not.toContain("SECRET-VALUE");
    expect(JSON.stringify(err.mock.calls)).not.toContain("Jane");
  });

  it("returns null for a tampered ciphertext", async () => {
    await saveProfile(profile("p1"));
    const rec = (await getItem(profileKey("p1"))) as { iv: string; ct: string };
    const ct = rec.ct.startsWith("A")
      ? "B" + rec.ct.slice(1)
      : "A" + rec.ct.slice(1);
    await fakeBrowser.storage.local.set({ [profileKey("p1")]: { ...rec, ct } });
    vi.spyOn(console, "error").mockImplementation(() => {});
    expect(await loadProfileForOrigin(A)).toBeNull();
  });

  it("locked: load throws LockedError, save throws LockedError and writes nothing", async () => {
    await saveProfile(profile("p1"));
    await lock();
    await expect(loadProfileForOrigin(A)).rejects.toBeInstanceOf(LockedError);
    await expect(saveProfile(profile("p2", A))).rejects.toBeInstanceOf(
      LockedError,
    );
    // Old record and pointer untouched by the failed replace.
    expect(await getItem(profileKey("p1"))).toBeDefined();
    expect(await getItem(profileKey("p2"))).toBeUndefined();
    expect((await readSites())[A]!.profileId).toBe("p1");
  });

  it("locked with no profile attached still returns null (site index is plaintext)", async () => {
    await lock();
    expect(await loadProfileForOrigin(A)).toBeNull();
  });
});
