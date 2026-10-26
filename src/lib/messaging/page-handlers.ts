// Page-request handlers backed by the vault. None of them forwards a timestamp or any other
// value from a message into the vault except the passphrase (ADR 0012 / 0014).
import type { KdfParams } from "../crypto/kdf";
import {
  createVault,
  lock,
  status,
  unlockWithPassphrase,
} from "../vault/vault";
import type { PageHandlers } from "./router";

/** `calibrate` is injected: production measures this device, tests use the fast floor. */
export function createPageHandlers(
  calibrate: () => Promise<KdfParams>,
): PageHandlers {
  return {
    "vault-status": () => status(),
    "vault-create": async ({ passphrase }) => {
      try {
        await createVault(passphrase, await calibrate());
        return { ok: true };
      } catch (err) {
        if (err instanceof Error) {
          if (err.message === "exists") return { ok: false, error: "exists" };
          if (err.message === "weak") return { ok: false, error: "weak" };
        }
        throw err;
      }
    },
    "vault-unlock": ({ passphrase }) => unlockWithPassphrase(passphrase),
    "vault-lock": async () => {
      await lock();
      return { ok: true };
    },
  };
}
