// Byte/encoding helpers. WebCrypto only; `globalThis.crypto` works in the service worker and Node.

const B64_RE =
  /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const encoder = new TextEncoder();
const decoder = new TextDecoder("utf-8", { fatal: true });

export function randomBytes(n: number): Uint8Array {
  return globalThis.crypto.getRandomValues(new Uint8Array(n));
}

export function toB64(b: Uint8Array): string {
  let s = "";
  for (let i = 0; i < b.length; i += 0x8000) {
    s += String.fromCharCode(...b.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

/** Strict standard base64 (padded). Throws `TypeError` on anything else. */
export function fromB64(s: string): Uint8Array {
  if (typeof s !== "string" || !B64_RE.test(s)) {
    throw new TypeError("invalid base64");
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return decoder.decode(b);
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(o).sort()) out[k] = sortKeys(o[k]);
    return out;
  }
  return v;
}

/** JSON with object keys sorted (by UTF-16 code unit) at every level and no whitespace. */
export function canonicalJson(v: unknown): string {
  const s = JSON.stringify(sortKeys(v));
  if (s === undefined) throw new TypeError("value is not JSON-serializable");
  return s;
}
