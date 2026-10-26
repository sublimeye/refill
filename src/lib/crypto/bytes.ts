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

/** Strict canonical standard base64 (padded, zero trailing bits). Throws `TypeError` on anything else. */
export function fromB64(s: string): Uint8Array {
  if (typeof s !== "string" || !B64_RE.test(s)) {
    throw new TypeError("invalid base64");
  }
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  if (toB64(out) !== s) throw new TypeError("non-canonical base64"); // non-zero trailing bits
  return out;
}

export function utf8(s: string): Uint8Array {
  return encoder.encode(s);
}

export function fromUtf8(b: Uint8Array): string {
  return decoder.decode(b);
}

function canon(v: unknown, stack: object[]): string {
  if (v === null) return "null";
  switch (typeof v) {
    case "string":
    case "boolean":
      return JSON.stringify(v);
    case "number":
      if (!Number.isFinite(v))
        throw new TypeError("canonicalJson: non-finite number");
      return JSON.stringify(v);
    case "object":
      break;
    default:
      throw new TypeError(`canonicalJson: unsupported value (${typeof v})`);
  }
  const o = v as object;
  if (stack.includes(o)) throw new TypeError("canonicalJson: cyclic structure");
  stack.push(o);
  let out: string;
  if (Array.isArray(o)) {
    const parts: string[] = [];
    for (let i = 0; i < o.length; i++) parts.push(canon(o[i], stack)); // holes read as undefined -> throw
    out = `[${parts.join(",")}]`;
  } else {
    const proto = Object.getPrototypeOf(o);
    if (proto !== Object.prototype && proto !== null) {
      throw new TypeError("canonicalJson: only plain objects are supported");
    }
    const rec = o as Record<string, unknown>;
    const parts = Object.keys(rec)
      .sort() // UTF-16 code-unit order; no object is rebuilt, so integer-like and "__proto__" keys are safe
      .map((k) => `${JSON.stringify(k)}:${canon(rec[k], stack)}`);
    out = `{${parts.join(",")}}`;
  }
  stack.pop();
  return out;
}

/**
 * Canonical JSON: object keys in UTF-16 code-unit order at every level, no whitespace. Accepts only
 * plain objects, arrays, strings, finite numbers, booleans and null; anything else (undefined,
 * functions, Date, Map, class instances, bigint, symbols, non-finite numbers, cycles) throws TypeError.
 */
export function canonicalJson(v: unknown): string {
  return canon(v, []);
}
