import type { Sealed } from "../crypto/aead";
import type { KdfParams } from "../crypto/kdf";

export interface LockPolicy {
  idleMinutes: number;
  maxHours: number;
  passphraseEveryDays: number;
}

export const DEFAULT_LOCK: LockPolicy = {
  idleMinutes: 15,
  maxHours: 12,
  passphraseEveryDays: 14,
};

/** `vault:header` in storage.local. Plaintext: every field is a hint until verified at unlock. */
export interface VaultHeader {
  v: 1;
  kdf: KdfParams;
  wrappedDek: Sealed;
  prf?: { credentialId: string; salt: string; wrappedDek: Sealed };
  draftPub: JsonWebKey;
  wrappedDraftPriv: Sealed;
  lock: LockPolicy;
  lastPassphraseAt: number;
}

/** Plaintext of `vault:integrity` (sealed with the DEK): copies of the header's tamper-relevant fields. */
export interface IntegrityPayload {
  draftPub: JsonWebKey;
  lock: LockPolicy;
  kdf: KdfParams;
}

export type VaultStatus =
  | { state: "none" }
  | { state: "corrupt" }
  | { state: "locked"; lock: LockPolicy }
  | { state: "unlocked"; unlockedAt: number; lock: LockPolicy };

export type UnlockResult =
  | { ok: true; warning?: "integrity-restored" }
  | {
      ok: false;
      /** `locked-during-unlock`: the passphrase was right, but `lock()` ran before the unlock committed. */
      reason:
        | "wrong-passphrase"
        | "no-vault"
        | "corrupt"
        | "backoff"
        | "locked-during-unlock";
      retryAfterMs?: number;
    };

export class LockedError extends Error {
  constructor() {
    super("vault is locked");
    this.name = "LockedError";
  }
}
