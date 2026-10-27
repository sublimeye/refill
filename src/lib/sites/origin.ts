/** `URL.origin` for https URLs; `null` for anything else (including unparsable input). */
export function normalizeOrigin(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  return u.protocol === "https:" ? u.origin : null;
}

/** Match pattern covering a whole origin, as used for content-script registration. */
export function originPattern(origin: string): string {
  return origin + "/*";
}
