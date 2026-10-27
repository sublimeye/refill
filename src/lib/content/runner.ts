// Content-script runtime (spec 5.2, 5.4 to 5.6): scan the page, send the signatures, apply the
// fill plan, re-scan when the page changes. DOM-only plus an injected `send`: no extension API is
// touched here, so it runs unchanged in browser-mode tests. The page is hostile: every DOM member
// used on page objects is captured from the prototypes at import time, nothing is logged, and a
// failure stops quietly. Decisions: ADR 0026.

import { getter, shadowRoot as ownShadowRoot } from "../fields/dom";
import type { ControlKind } from "../fields/eligibility";
import {
  pageFingerprint,
  scanDocument,
  type ScannedControl,
} from "../fields/scan";
import { PasswordHistory } from "../fields/sensitive";
import {
  canFill,
  fillControl,
  withFillingGuard,
  type FillItem as ControlItem,
} from "../fill/fill";
import {
  MAX_CONTROLS,
  type ContentRequest,
  type FillItem,
} from "../messaging/content-protocol";

/** Quiet period after the last DOM change or scroll before a re-scan (spec 5.4). */
export const RESCAN_DEBOUNCE_MS = 250;
/** A page that never stops mutating is still re-scanned this long after the first change. */
export const RESCAN_MAX_WAIT_MS = 1000;

export interface ContentEnv {
  win: Window;
  doc: Document;
  /** `location.origin` of the document; nothing is sent or filled unless it is https. */
  origin: string;
  /** `runtime.sendMessage`. A rejection that says the context is invalidated stops the run. */
  send(msg: ContentRequest): Promise<unknown>;
  /** False once the extension is gone (`runtime.id` undefined): the run stops. */
  alive(): boolean;
  /** `dom.openOrClosedShadowRoot` where the browser has it, so closed roots are scanned too. */
  openOrClosedShadowRoot?: ((el: Element) => ShadowRoot | null) | undefined;
  /** Tests only (see `isEligible`). */
  isTopWindow?: (win: Window) => boolean;
  /** Tests only: defaults to the captured `Document.prototype.prerendering` getter. */
  isPrerendering?: () => boolean;
}

export interface ContentRun {
  /** Disconnects every observer and listener; idempotent. */
  stop(): void;
}

const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;
// Chromium 108+; the minimum is 127, but a missing accessor must not kill the script at load.
const prerenderingGet = Object.getOwnPropertyDescriptor(
  Document.prototype,
  "prerendering",
)?.get;
const prerendering = (doc: Document): boolean =>
  prerenderingGet?.call(doc) === true;
const persisted = getter<boolean>(PageTransitionEvent.prototype, "persisted");
const now = (): number => performance.now();

const KINDS: readonly string[] = ["text", "select", "checkbox", "radio"];

const OBSERVE: MutationObserverInit = {
  subtree: true,
  childList: true,
  attributes: true,
  characterData: true,
};

/** The started flag, kept in the content script's own global scope (unreachable from the page). */
const STARTED = "refillContentStarted";

/**
 * Strict check of the worker's answer to a scan-report: the fill items, or null for any other
 * state (locked, none, gesture), a router error, or anything malformed.
 */
function fillItems(plan: unknown): FillItem[] | null {
  if (typeof plan !== "object" || plan === null) return null;
  const p = plan as Record<string, unknown>;
  const items = p["items"];
  if (p["state"] !== "fill" || !Array.isArray(items)) return null;
  if (items.length > MAX_CONTROLS) return null;
  const out: FillItem[] = [];
  for (const raw of items as unknown[]) {
    if (typeof raw !== "object" || raw === null) return null;
    const r = raw as Record<string, unknown>;
    const { fieldId, i, kind, value, pageDefault } = r;
    if (
      typeof fieldId !== "string" ||
      typeof i !== "number" ||
      !Number.isInteger(i) ||
      typeof kind !== "string" ||
      !KINDS.includes(kind) ||
      typeof value !== "string" ||
      typeof pageDefault !== "string"
    ) {
      return null;
    }
    out.push({ fieldId, i, kind: kind as ControlKind, value, pageDefault });
  }
  return out;
}

function invalidated(err: unknown): boolean {
  try {
    return (
      err instanceof Error &&
      err.message.includes("Extension context invalidated")
    );
  } catch {
    return false;
  }
}

/**
 * Starts the content script on `env.doc` unless it already runs in this scope (the content
 * script's global object: a registered script and an `executeScript` after enable both land in the
 * same isolated world, and page code cannot reach that object). Returns null when it was already
 * started or the origin is not https.
 *
 * Flow: wait until the document is not prerendering; watch password type flips; scan, and if the
 * page fingerprint changed since the last report send a `scan-report`; apply a `fill` plan (every
 * item vetted with `canFill` before any write, then `fillControl`, each field id filled at most
 * once per document) and send a `fill-result`. Re-scan after DOM changes (also inside shadow roots
 * the scan entered) and after `scrollend` (window and, in the capture phase, any scroll container),
 * debounced. A bfcache restore reports again but keeps the filled ids. When the extension context
 * goes away everything stops, silently.
 */
export function startContentScript(
  scope: object,
  env: ContentEnv,
): ContentRun | null {
  const flags = scope as Record<string, unknown>;
  if (flags[STARTED] === true) return null;
  flags[STARTED] = true;
  if (!env.origin.startsWith("https://")) return null;
  return run(env);
}

function run(env: ContentEnv): ContentRun {
  const { win, doc, origin, isTopWindow } = env;
  const isPrerendering = env.isPrerendering ?? (() => prerendering(doc));
  const history = new PasswordHistory();
  const observer = new MutationObserver(() => schedule());
  const watched = new WeakSet<ShadowRoot>();
  const filled = new Set<string>();
  let stopped = false;
  let started = false;
  let lastFingerprint: string | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstPending: number | undefined;
  let scanning = false;
  let again = false;

  const listeners: [EventTarget, string, EventListener, boolean][] = [];
  const listen = (
    target: EventTarget,
    type: string,
    fn: EventListener,
    capture: boolean,
  ): void => {
    addListener.call(target, type, fn, { capture, passive: true });
    listeners.push([target, type, fn, capture]);
  };

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    observer.disconnect();
    history.disconnect();
    for (const [target, type, fn, capture] of listeners.splice(0)) {
      try {
        removeListener.call(target, type, fn, capture);
      } catch {
        // nothing more to undo
      }
    }
  }

  /** Every shadow root the scan enters is observed too: a document observer does not see inside. */
  function shadowRootOf(el: Element): ShadowRoot | null {
    let root: ShadowRoot | null;
    try {
      root = env.openOrClosedShadowRoot?.(el) ?? ownShadowRoot(el);
    } catch {
      return null;
    }
    if (root !== null && !watched.has(root)) {
      watched.add(root);
      try {
        observer.observe(root, OBSERVE);
      } catch {
        // not observable: re-scans for it come from document changes and scrolls only
      }
    }
    return root;
  }

  /** Sends `msg`; `undefined` when it failed (and the run stopped if the extension is gone). */
  async function send(msg: ContentRequest): Promise<unknown> {
    if (!aliveNow()) {
      stop();
      return undefined;
    }
    try {
      return await env.send(msg);
    } catch (err) {
      if (invalidated(err) || !aliveNow()) stop();
      return undefined;
    }
  }

  function aliveNow(): boolean {
    try {
      return env.alive();
    } catch {
      return false;
    }
  }

  function apply(
    items: FillItem[],
    controls: ScannedControl[],
  ): { filled: number; skipped: number; unsupported: number } {
    const counts = { filled: 0, skipped: 0, unsupported: 0 };
    withFillingGuard(() => {
      // Vet every item against the page as it was before any write: a page handler that runs
      // during one fill must not make another field look empty.
      const ready: { fieldId: string; item: ControlItem }[] = [];
      const named = new Set<string>();
      for (const { fieldId, i, kind, value, pageDefault } of items) {
        // Filled earlier in this document, or named twice in this plan: never written again.
        if (filled.has(fieldId) || named.has(fieldId)) continue;
        named.add(fieldId);
        const control = controls[i];
        if (control === undefined || control.kind !== kind) {
          counts.skipped++;
          continue;
        }
        const item = { el: control.el, kind, value, pageDefault };
        if (canFill(item, history, origin, isTopWindow)) {
          ready.push({ fieldId, item });
        } else {
          counts.skipped++;
        }
      }
      for (const { fieldId, item } of ready) {
        switch (fillControl(item, history, origin, isTopWindow)) {
          case "filled":
            filled.add(fieldId);
            counts.filled++;
            break;
          case "unsupported":
          case "rejected-by-page":
            // Not retried: a custom widget or a refusing page will refuse again.
            filled.add(fieldId);
            counts.unsupported++;
            break;
          default:
            counts.skipped++;
        }
      }
    });
    return counts;
  }

  async function cycle(): Promise<void> {
    const result = scanDocument(doc, history, shadowRootOf, isTopWindow);
    const fingerprint = JSON.stringify(pageFingerprint(result));
    if (fingerprint === lastFingerprint) return;
    lastFingerprint = fingerprint;
    if (result.controls.length === 0) return;
    const plan = await send({
      type: "scan-report",
      controls: result.controls.map(({ i, kind, sig }) => ({ i, kind, sig })),
      truncated: result.truncated,
    });
    if (stopped) return;
    const items = fillItems(plan);
    if (items === null) return;
    const counts = apply(items, result.controls);
    if (counts.filled + counts.skipped + counts.unsupported === 0) return;
    await send({ type: "fill-result", ...counts });
  }

  /** One scan at a time; a request during a scan runs one more scan right after it. */
  async function scan(): Promise<void> {
    if (stopped) return;
    if (scanning) {
      again = true;
      return;
    }
    scanning = true;
    try {
      do {
        again = false;
        try {
          await cycle();
        } catch {
          // A page getter threw somewhere the field modules do not guard: try again next change.
        }
      } while (again && !stopped);
    } finally {
      scanning = false;
    }
  }

  function schedule(): void {
    if (stopped || !started) return;
    const t = now();
    firstPending ??= t;
    clearTimeout(timer);
    const wait = Math.min(
      RESCAN_DEBOUNCE_MS,
      Math.max(0, firstPending + RESCAN_MAX_WAIT_MS - t),
    );
    timer = setTimeout(() => {
      timer = undefined;
      firstPending = undefined;
      void scan();
    }, wait);
  }

  function begin(): void {
    if (stopped || started) return;
    started = true;
    try {
      history.observe(doc);
      observer.observe(doc, OBSERVE);
    } catch {
      // Without the password type-flip history the sensitive-field rules are weaker: fail closed.
      stop();
      return;
    }
    listen(win, "scrollend", () => schedule(), true);
    listen(
      win,
      "pageshow",
      (e) => {
        // A bfcache restore is the same document: report again, keep the filled ids. The getter
        // throws for a plain `Event` named "pageshow", which page code can dispatch.
        let restored: boolean;
        try {
          restored = persisted(e);
        } catch {
          return;
        }
        if (!restored) return;
        lastFingerprint = null;
        schedule();
      },
      false,
    );
    void scan();
  }

  if (isPrerendering()) {
    const onActivate = (): void => {
      if (isPrerendering()) return;
      begin();
    };
    listen(doc, "prerenderingchange", onActivate, false);
  } else {
    begin();
  }
  return { stop };
}
