// Additional-authenticated-data builders. Each ciphertext is bound to its role/location so a
// blob cannot be swapped between slots. Format is versioned: `refill/v1|...`.
import { utf8 } from "./bytes";

// "|" is the field separator; a "|" inside a non-final field would make encodings ambiguous.
function field(name: string, v: string): string {
  if (v.includes("|")) throw new TypeError(`AAD ${name} must not contain "|"`);
  return v;
}

export const aad = {
  dekPw: (): Uint8Array => utf8("refill/v1|dek|pw"),
  dekPrf: (credentialId: string): Uint8Array =>
    utf8(`refill/v1|dek|prf|${credentialId}`),
  draftPriv: (): Uint8Array => utf8("refill/v1|draft-priv"),
  integrity: (): Uint8Array => utf8("refill/v1|integrity"),
  profile: (id: string, origin: string): Uint8Array =>
    utf8(`refill/v1|profile|${field("profile id", id)}|${origin}`),
  draft: (id: string, expiresAt: number | null): Uint8Array =>
    utf8(`refill/v1|draft|${field("draft id", id)}|${expiresAt ?? "none"}`),
};
