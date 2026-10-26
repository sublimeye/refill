// Public half of the dev/test signing key (private key: .refill-dev-key.pem, gitignored).
// Pins the extension ID across builds. See docs/adr/0003-manifest-key.md.
export const MANIFEST_KEY =
  "MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAydDEkq2BHjDHBm8SdDyAq223RuouTdVsrxBVhrudNtaodPcb63Pk8w8VMwBpPQNGyES2kBlPIkNOPzFaDymqGx42JZQuF2b9XTeJyoPUngejuXa2n7sZLh8xB3MLThOHU+H61wbndtM44KHZESiIYbDCHvO2MTZGLItaHT+ZulDibvKcA6lJsL4b+QD4y6kq0QHKZV2Cj9+2sG2BKyBnArSYBeJkQ4ryxSdZ3HESuhCp/wev2RKWDhejgRKGud+dUzKuOtQc//tAizoeSNRC+paR2iLsPC3DhzkF4+KwWl6ANFVMCS05r2P9zFOEq0iYxUBiO+nkFyAova1DIkL87wIDAQAB";

// Chrome's derivation: sha256(DER SubjectPublicKeyInfo), first 16 bytes, hex nibbles 0-f mapped to a-p.
// Hard-coded; tests/unit/manifest-key.test.ts recomputes it from MANIFEST_KEY.
export const EXTENSION_ID = "mpkgcobephioakhgajlkoogmmhdkbook";
