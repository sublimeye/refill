// Step boundaries while recording (spec 6.2). Runs once per scan-report with the page's `sigKey`
// keys, the sender's document id and pathname. Pure; returns a new body. Decisions: ADR 0028.
import { jaccard, MIN_JACCARD } from "../match/match";
import { LIMITS } from "../profiles/types";
import type { RecBody, RecStep } from "./types";

/** `pathname`, or when too long for a path hint, its longest prefix that ends with "/". */
function pathHintOf(pathname: string): string {
  if (pathname.length <= LIMITS.pathHint) return pathname;
  const cut = pathname.slice(0, LIMITS.pathHint);
  return cut.slice(0, cut.lastIndexOf("/") + 1);
}

/** `base` followed by the entries of `add` it lacks, distinct, at most LIMITS.fingerprint. */
function union(base: string[], add: string[]): string[] {
  const out = [...base];
  const seen = new Set(base);
  for (const k of add) {
    if (out.length >= LIMITS.fingerprint) break;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(k);
  }
  return out;
}

const contains = (keys: Set<string>, fingerprint: string[]): boolean =>
  fingerprint.every((k) => keys.has(k));

/** The step this page belongs to, or null for a new one. */
function stepFor(
  body: RecBody,
  keys: string[],
  documentId: string | null,
): RecStep | null {
  const current = body.steps.find((s) => s.index === body.current);
  if (
    current !== undefined &&
    documentId !== null &&
    documentId === body.lastDocument &&
    // Same document: an accordion that opens keeps every earlier control.
    (contains(new Set(keys), current.fingerprint) ||
      jaccard(keys, current.fingerprint) >= MIN_JACCARD)
  ) {
    return current;
  }
  // Back, a reload or a failed-validation re-render: the most similar known step, the latest on a tie.
  let best: RecStep | null = null;
  let bestJ = MIN_JACCARD;
  for (const s of body.steps) {
    const j = jaccard(keys, s.fingerprint);
    if (j >= bestJ) {
      best = s;
      bestJ = j;
    }
  }
  return best;
}

export function observePage(
  body: RecBody,
  rawKeys: string[],
  documentId: string | null,
  pathname: string,
): RecBody | "full" {
  const keys = rawKeys.filter((k) => k.length <= LIMITS.fingerprintEntry);
  // A page with no eligible controls is no step: nothing on it can be captured or filled.
  if (keys.length === 0) {
    return { ...body, current: null, lastDocument: documentId };
  }
  const join = stepFor(body, keys, documentId);
  if (join !== null) {
    return {
      ...body,
      steps: body.steps.map((s) =>
        s === join ? { ...s, fingerprint: union(s.fingerprint, keys) } : s,
      ),
      current: join.index,
      lastDocument: documentId,
    };
  }
  if (body.steps.length >= LIMITS.steps) return "full";
  // The lowest free index: a seeded profile's indexes need not be 0..n-1.
  const used = new Set(body.steps.map((s) => s.index));
  let index = 0;
  while (used.has(index)) index++;
  return {
    ...body,
    steps: [
      ...body.steps,
      { index, pathHint: pathHintOf(pathname), fingerprint: union([], keys) },
    ],
    current: index,
    lastDocument: documentId,
  };
}
