declare const d: BufferSource;

// ruleid: refill-subtle-only-in-crypto
crypto.subtle.digest("SHA-256", d);
// ruleid: refill-subtle-only-in-crypto
self.crypto.subtle.digest("SHA-256", d);
// ruleid: refill-subtle-only-in-crypto
window.crypto.subtle.digest("SHA-256", d);
// ruleid: refill-subtle-only-in-crypto
globalThis.crypto.subtle.digest("SHA-256", d);
// ruleid: refill-subtle-only-in-crypto
crypto["subtle"].digest("SHA-256", d);
// ruleid: refill-subtle-only-in-crypto
globalThis.crypto["subtle"].digest("SHA-256", d);
// ruleid: refill-subtle-only-in-crypto
const sub = crypto.subtle;

// ok: refill-subtle-only-in-crypto
crypto.getRandomValues(new Uint8Array(16));
// ok: refill-subtle-only-in-crypto
crypto.randomUUID();
