// Field signatures (spec 5.1). DOM-only, zero runtime dependencies: this runs in the content script.

import {
  firstChild,
  hasAttr,
  localName,
  nextSibling,
  nodeType,
  parentNode,
} from "./dom";

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

const FIELD_MAX = 256;
const LABEL_MAX = FIELD_MAX;
// Page content is hostile: label text is gathered under fixed budgets so one control cannot cost
// unbounded time or memory (ADR 0019).
const TEXT_NODE_BUDGET = 2000;
const TEXT_CHAR_BUDGET = 1024;
const MAX_LABEL_SOURCES = 16;

interface Budget {
  nodes: number;
  chars: number;
}

const newBudget = (): Budget => ({
  nodes: TEXT_NODE_BUDGET,
  chars: TEXT_CHAR_BUDGET,
});

const SKIPPED_TAGS = new Set([
  "input",
  "select",
  "textarea",
  "button",
  "script",
  "style",
  "template",
  "noscript",
]);

/**
 * Text of `root`'s subtree in document order, iterative (no recursion depth limit) and bounded by `b`.
 * Skips nested form controls (a wrapping label must not read the control's options/value), script,
 * style, template, noscript and [hidden] subtrees.
 */
function textOf(root: Node, b: Budget): string {
  let out = "";
  // Accessors, not properties: the label's content can be a <form> whose named controls shadow
  // `firstChild` / `nextSibling` / `parentNode` (dom.ts). Every step, including each climb, spends
  // budget, so no markup can keep this loop running.
  let node: Node | null = firstChild(root);
  while (node !== null && b.nodes > 0 && b.chars > 0) {
    b.nodes--;
    let descend = false;
    const type = nodeType(node);
    if (type === Node.TEXT_NODE) {
      const take = (node.nodeValue ?? "").slice(0, b.chars);
      out += take;
      b.chars -= take.length;
    } else if (type === Node.ELEMENT_NODE) {
      const el = node as Element;
      if (!SKIPPED_TAGS.has(localName(el)) && !hasAttr(el, "hidden")) {
        out += " ";
        descend = firstChild(el) !== null;
      }
    }
    if (descend) {
      node = firstChild(node);
      continue;
    }
    while (node !== null && nextSibling(node) === null) {
      if (--b.nodes <= 0) return out;
      node = parentNode(node);
      if (node === root) node = null;
      else out += " ";
    }
    if (node !== null) node = nextSibling(node);
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

function isHiddenInput(el: FormControl): boolean {
  return el.localName === "input" && (el as HTMLInputElement).type === "hidden";
}

export function labelText(el: FormControl): string | null {
  const root = rootOf(el);
  // `labels` follows the browser's own association (duplicate ids resolve to the first element);
  // it is null for non-labelable controls (hidden), which fall back to a label[for] lookup.
  // Reading it walks the whole tree scope, which makes a scan quadratic on a page of many controls,
  // so skip it when no label can point at this control: no id for a `for` to name and no wrapping label.
  const nodeList =
    el.id === "" && el.closest("label") === null ? undefined : el.labels;
  const labels =
    nodeList === null || (nodeList === undefined && isHiddenInput(el))
      ? null
      : nodeList === undefined
        ? []
        : Array.from(
            { length: Math.min(nodeList.length, MAX_LABEL_SOURCES * 4) },
            (_, i) => nodeList[i],
          ).filter((l): l is HTMLLabelElement => l !== undefined);
  const candidates: Array<() => string | null> = [
    // 1. label[for=id]
    () => {
      const b = newBudget();
      const forLabels = labels
        ? labels.filter((l) => l.hasAttribute("for"))
        : el.id === ""
          ? []
          : Array.from(
              root.querySelectorAll(`label[for="${CSS.escape(el.id)}"]`),
            );
      return forLabels
        .slice(0, MAX_LABEL_SOURCES)
        .map((l) => textOf(l, b))
        .join(" ");
    },
    // 2. wrapping <label>
    () => {
      const wrapping = labels
        ? labels.find((l) => !l.hasAttribute("for"))
        : el.closest("label");
      return wrapping ? textOf(wrapping, newBudget()) : null;
    },
    // 3. aria-labelledby (<= 16 ids, in listed order, unknown ids ignored, one shared budget)
    () => {
      const b = newBudget();
      const ids = (el.getAttribute("aria-labelledby") ?? "")
        .split(/\s+/, MAX_LABEL_SOURCES)
        .filter(Boolean);
      const parts: string[] = [];
      for (const id of ids) {
        const n = root.getElementById(id);
        if (n !== null) parts.push(textOf(n, b));
      }
      return parts.join(" ");
    },
    // 4. aria-label, 5. placeholder
    () => el.getAttribute("aria-label")?.slice(0, TEXT_CHAR_BUDGET) ?? null,
    () => el.getAttribute("placeholder")?.slice(0, TEXT_CHAR_BUDGET) ?? null,
  ];
  for (const source of candidates) {
    const text = source();
    if (text === null) continue;
    const normalized = normalizeLabel(text);
    if (normalized !== null) return normalized;
  }
  return null;
}

const GENERATED_PREFIX =
  /^(?:radix-|headlessui-|react-select-|ember\d|j_idt\d)/i;

/**
 * The id if it looks hand-written, else null (generated ids carry no evidence across loads).
 * Generated: empty or longer than 256; a run of >= 4 digits; a React `:r1:` / `«r1»` / `_r_1_` token
 * anywhere in the id; sequential `<prefix>-<n>` / `<prefix>_<n>`; a known generated prefix (radix-,
 * headlessui-, react-select-, ember<n>, j_idt<n>); >= 3 `-`/`_` separated hex groups mixing digits and
 * letters (`user-a8f3-c9e2-1b7d-44e0`); a hash-like token. A token is a maximal [A-Za-z0-9] run (`-` and
 * `_` are word separators), hash-like when it is >= 12 chars with letters and digits mixed, ignoring up
 * to 3 trailing digits for the mix test so `billing_address_line1` / `billingAddressLine1` stay stable
 * (ADR 0019).
 */
export function idStable(id: string): string | null {
  if (id === "" || id.length > FIELD_MAX) return null;
  if (/\d{4}/.test(id)) return null;
  if (/[:«]r[0-9a-z]+[:»]/i.test(id)) return null;
  if (/(?:^|[^A-Za-z0-9])_r_[0-9a-z]+_/i.test(id)) return null;
  if (GENERATED_PREFIX.test(id)) return null;
  if (/^[a-z][\w-]*[-_]\d+$/i.test(id)) return null;
  const hexGroups = id
    .split(/[-_]/)
    .filter(
      (g) => /^[0-9a-f]{3,}$/i.test(g) && /\d/.test(g) && /[a-f]/i.test(g),
    );
  if (hexGroups.length >= 3) return null;
  for (const token of id.match(/[A-Za-z0-9]{12,}/g) ?? []) {
    const body = token.replace(/\d{1,3}$/, "");
    if (/\d/.test(body) && /[A-Za-z]/.test(body)) return null;
  }
  return id;
}

/**
 * `name` and `id` are one piece of evidence when equal after `$` to `_` (ASP.NET), `a[b][c]` to
 * `a_b_c` (Rails/PHP), or case-insensitively.
 */
export function nameIdDerived(name: string, id: string): boolean {
  if (name === "" || id === "") return false;
  const mapped = name
    .replaceAll("$", "_")
    .replaceAll("[", "_")
    .replaceAll("]", "");
  return mapped === id || name.toLowerCase() === id.toLowerCase();
}

function normalizeAutocomplete(raw: string | null): string | null {
  const tokens = (raw ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const joined = tokens.join(" ");
  return joined === "on" || joined === "off"
    ? null
    : joined.slice(0, FIELD_MAX);
}

/** Never throws: a hostile DOM that breaks label collection yields `labelText: null` for that field. Every string is <= 256. */
export function buildSignature(
  el: FormControl,
  ordinal: number,
  formAction: string | null,
): Sig {
  const name = el.getAttribute("name");
  // Derived-ness is computed from the full values, before any cap.
  const derived = nameIdDerived(name ?? "", el.id);
  let label: string | null;
  try {
    label = labelText(el);
  } catch {
    label = null;
  }
  return {
    name: name === null || name === "" ? null : name.slice(0, FIELD_MAX),
    idStable: idStable(el.id),
    autocomplete: normalizeAutocomplete(el.getAttribute("autocomplete")),
    type: el.type,
    labelText: label,
    ordinal,
    formAction: formAction === null ? null : formAction.slice(0, FIELD_MAX),
    nameIdDerived: derived,
  };
}
