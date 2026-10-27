// Field signatures (spec 5.1). DOM-only, zero runtime dependencies: this runs in the content script.

export type FormControl =
  HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement;

export interface Sig {
  name: string | null;
  idStable: string | null;
  autocomplete: string | null;
  type: string;
  labelText: string | null;
  ordinal: number;
  formAction: string | null;
  nameIdDerived: boolean;
}

const LABEL_MAX = 256;

/** Text of `node`, skipping nested form controls and non-text elements (a wrapping label must not read the control's options/value). */
function textOf(node: Node): string {
  let out = "";
  for (const child of node.childNodes) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.nodeValue ?? "";
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = (child as Element).localName;
      if (
        tag === "input" ||
        tag === "select" ||
        tag === "textarea" ||
        tag === "button" ||
        tag === "script" ||
        tag === "style"
      ) {
        continue;
      }
      out += " " + textOf(child) + " ";
    }
  }
  return out;
}

/** lowercase, collapse whitespace, trim, strip trailing `*` / `:` repeatedly (digits kept), then truncate. */
function normalizeLabel(raw: string): string | null {
  let s = raw.toLowerCase().replace(/\s+/g, " ").trim();
  for (;;) {
    const next = s.replace(/[*:]$/, "").trimEnd();
    if (next === s) break;
    s = next;
  }
  s = s.slice(0, LABEL_MAX);
  return s === "" ? null : s;
}

function rootOf(el: Element): Document | ShadowRoot {
  const root = el.getRootNode();
  return root instanceof ShadowRoot ? root : el.ownerDocument;
}

export function labelText(el: FormControl): string | null {
  const root = rootOf(el);
  const candidates: Array<() => string | null> = [
    // 1. label[for=id]
    () => {
      if (el.id === "") return null;
      const labels = root.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`);
      return Array.from(labels, (l) => textOf(l)).join(" ");
    },
    // 2. wrapping <label>
    () => {
      const label = el.closest("label");
      return label ? textOf(label) : null;
    },
    // 3. aria-labelledby (joined, in listed order; unknown ids ignored)
    () => {
      const ids = (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/)
        .filter(Boolean);
      return ids
        .map((id) => root.getElementById(id))
        .filter((n): n is HTMLElement => n !== null)
        .map((n) => textOf(n))
        .join(" ");
    },
    // 4. aria-label, 5. placeholder
    () => el.getAttribute("aria-label"),
    () => el.getAttribute("placeholder"),
  ];
  for (const source of candidates) {
    const text = source();
    if (text === null) continue;
    const normalized = normalizeLabel(text);
    if (normalized !== null) return normalized;
  }
  return null;
}

/**
 * The id if it looks hand-written, else null (generated ids carry no evidence across loads).
 * Generated: empty; a run of >= 4 digits; React `:r1:` / `«r1»`; sequential `<prefix>-<n>` / `<prefix>_<n>`;
 * a hash-like token. A token is a maximal [A-Za-z0-9] run (`-` and `_` are word separators), and it is
 * hash-like when it is >= 12 chars with letters and digits mixed. A trailing run of up to 3 digits is
 * ignored for the mix test so `billing_address_line1` / `billingAddressLine1` stay stable (ADR 0019).
 */
export function idStable(id: string): string | null {
  if (id === "") return null;
  if (/\d{4}/.test(id)) return null;
  if (/^[:«]r[0-9a-z]*[:»]$/i.test(id)) return null;
  if (/^[a-z][\w-]*[-_]\d+$/i.test(id)) return null;
  for (const token of id.match(/[A-Za-z0-9]{12,}/g) ?? []) {
    const body = token.replace(/\d{1,3}$/, "");
    if (/\d/.test(body) && /[A-Za-z]/.test(body)) return null;
  }
  return id;
}

/** `name` and `id` are one piece of evidence when equal after `$` to `_` (ASP.NET) or case-insensitively. */
export function nameIdDerived(name: string, id: string): boolean {
  if (name === "" || id === "") return false;
  return (
    name.replaceAll("$", "_") === id || name.toLowerCase() === id.toLowerCase()
  );
}

function normalizeAutocomplete(raw: string | null): string | null {
  const tokens = (raw ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const joined = tokens.join(" ");
  return joined === "on" || joined === "off" ? null : joined;
}

export function buildSignature(
  el: FormControl,
  ordinal: number,
  formAction: string | null,
): Sig {
  const name = el.getAttribute("name");
  return {
    name: name === "" ? null : name,
    idStable: idStable(el.id),
    autocomplete: normalizeAutocomplete(el.getAttribute("autocomplete")),
    type: el.type,
    labelText: labelText(el),
    ordinal,
    formAction,
    nameIdDerived: nameIdDerived(name ?? "", el.id),
  };
}
