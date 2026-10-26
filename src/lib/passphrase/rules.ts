// The one definition of "long enough", shared by the vault (authoritative), the page handlers
// (early exit before Argon2 calibration) and the onboarding strength check.
export const MIN_PASSPHRASE_CHARS = 12;

/** Code points after NFC, the form that is hashed (ADR 0012). */
export function meetsMinLength(passphrase: string): boolean {
  return [...passphrase.normalize("NFC")].length >= MIN_PASSPHRASE_CHARS;
}
