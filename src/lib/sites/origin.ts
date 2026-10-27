/** `URL.origin` for https URLs; `null` for anything else (including unparsable input). */
export function normalizeOrigin(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== "https:") return null;
  // A match-pattern wildcard must never ride in on an origin: "https://*" + "/*" would match every
  // site. WHATWG parsers keep "*" in a host, Chromium escapes it to "%2A"; reject both so the
  // result does not depend on the parser.
  if (/[*%]/.test(u.hostname)) return null;
  return u.origin;
}

/** Match pattern covering a whole origin, as used for content-script registration. */
export function originPattern(origin: string): string {
  return origin + "/*";
}
