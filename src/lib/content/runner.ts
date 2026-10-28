// Content-script runtime (spec 5.2, 5.4 to 5.6): scan the page, send the signatures, apply the
// fill plan, re-scan when the page changes. DOM-only plus an injected `send`: no extension API is
// touched here, so it runs unchanged in browser-mode tests. The page is hostile: every DOM member
// used on page objects is captured from the prototypes at import time, nothing is logged, and a
// failure stops quietly. Decisions: ADR 0026.

import { getter, shadowRoot as ownShadowRoot } from "../fields/dom";
import type { ControlKind } from "../fields/eligibility";
import {
  MAX_CONTROLS,
  pageFingerprint,
  scanDocument,
  type ScanResult,
  type ScannedControl,
} from "../fields/scan";
import { PasswordHistory } from "../fields/sensitive";
import type { FormControl, Sig } from "../fields/signature";
import {
  canFill,
  fillControl,
  withFillingGuard,
  type FillItem as ControlItem,
} from "../fill/fill";
// Types only: the protocol module's runtime imports reach `wxt/browser`, whose `globalThis.browser`
// lookup page markup can answer (ADR 0026). Nothing of it may load in the content script.
import type { ContentRequest, FillItem } from "../messaging/content-protocol";
import { createRecording } from "./recording";
import { stillMeans } from "./still-means";

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
  /** Tests only: defaults to `event.isTrusted` (a synthetic `pageshow` must not force a report, a
   *  synthetic `input` must not be captured). */
  isTrusted?: (e: Event) => boolean;
  /** Registers a callback for the worker's data-free `refill-nudge` (recording state changed). */
  onNudge?: ((cb: () => void) => void) | undefined;
  /** Registers the answer to the worker's `refill-flush` (a popup Finish waits for the captures). */
  onFlush?: ((cb: () => Promise<void>) => void) | undefined;
}

export interface ContentRun {
  /** Scans now; resolves with the scan once its report (if the page changed) was delivered. */
  rescan(): Promise<ScanResult | null>;
  /** Disconnects every observer and listener and removes the pill; idempotent. */
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

/** What `send` returns when the message did not get through (it threw). */
const FAILED: unique symbol = Symbol("send failed");

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
  const isTrusted = env.isTrusted ?? ((e: Event) => e.isTrusted);
  const history = new PasswordHistory();
  const observer = new MutationObserver(() => schedule());
  const watched = new WeakSet<ShadowRoot>();
  const filled = new Set<string>();
  /**
   * Element -> the field id Refill filled into it and the signature it had then: a capture there
   * updates that field (ADR 0028), but only while the element still means that field. A framework
   * that re-uses the input for another step's field must not move the filled field there (ADR 0032).
   */
  const filledInto = new WeakMap<Element, { fieldId: string; sig: Sig }>();
  let latest: ScanResult | null = null;
  let stopped = false;
  let started = false;
  let lastFingerprint: string | null = null;
  /** Bumped by a bfcache restore, so a report in flight then does not re-remember its page. */
  let resets = 0;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let firstPending: number | undefined;
  let scanning: Promise<void> | null = null;
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

  const recording = createRecording({
    doc,
    send: (msg) => send(msg),
    latest: () => latest,
    rescan,
    filledField: (el) => {
      const link = filledInto.get(el);
      if (link === undefined) return null;
      return stillMeans(el as FormControl, link.sig) ? link.fieldId : null;
    },
    history,
    isTrusted,
    isTopWindow,
  });

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearTimeout(timer);
    observer.disconnect();
    recording.stop();
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
      if (recording.ownsHost(el)) return null; // the pill: no controls, and its updates are no change

      root = env.openOrClosedShadowRoot?.(el) ?? ownShadowRoot(el);
    } catch {
      return null;
    }
    if (root !== null && !watched.has(root)) {
      watched.add(root);
      recording.observeRoot(root);
      try {
        observer.observe(root, OBSERVE);
      } catch {
        // not observable: re-scans for it come from document changes and scrolls only
      }
    }
    return root;
  }

  /** Sends `msg`; `FAILED` when it threw (and the run stopped if the extension is gone). */
  async function send(msg: ContentRequest): Promise<unknown> {
    if (!aliveNow()) {
      stop();
      return FAILED;
    }
    try {
      return await env.send(msg);
    } catch (err) {
      if (invalidated(err) || !aliveNow()) stop();
      return FAILED;
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
      const ready: { fieldId: string; item: ControlItem; sig: Sig }[] = [];
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
        // While recording, what the user typed in this document stays as typed (Review Focus 1).
        if (recording.edited(control.el)) {
          counts.skipped++;
          continue;
        }
        const item = { el: control.el, kind, value, pageDefault };
        if (canFill(item, history, origin, isTopWindow)) {
          ready.push({ fieldId, item, sig: control.sig });
        } else {
          counts.skipped++;
        }
      }
      for (const { fieldId, item, sig } of ready) {
        // Re-checked right before each write: the page may have re-used the element for another
        // field during the round trip, or an earlier write's handlers may have changed it. Not
        // marked filled: the re-scan reports the element under its new meaning.
        if (!stillMeans(item.el, sig)) {
          counts.skipped++;
          continue;
        }
        switch (fillControl(item, history, origin, isTopWindow)) {
          case "filled":
            filled.add(fieldId);
            filledInto.set(item.el, { fieldId, sig });
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
    latest = result;
    // Page defaults are noted before this scan's plan writes anything.
    recording.noteScan(result);
    const fingerprint = JSON.stringify(pageFingerprint(result));
    if (fingerprint === lastFingerprint) return;
    if (result.controls.length === 0) {
      lastFingerprint = fingerprint;
      return;
    }
    const generation = resets;
    const plan = await send({
      type: "scan-report",
      controls: result.controls.map(({ i, kind, sig }) => ({ i, kind, sig })),
      truncated: result.truncated,
    });
    if (stopped) return;
    // Remembered only once delivered: after a failed send the next trigger reports again.
    if (plan === FAILED) return;
    if (generation === resets) lastFingerprint = fingerprint;
    const items = fillItems(plan);
    if (items === null) return;
    const counts = apply(items, result.controls);
    if (counts.filled + counts.skipped + counts.unsupported === 0) return;
    await send({ type: "fill-result", ...counts });
  }

  /**
   * One scan at a time; a request during a scan runs one more scan right after it. The promise
   * settles once every requested scan is done, including that extra one.
   */
  function scan(): Promise<void> {
    if (stopped) return Promise.resolve();
    if (scanning !== null) {
      again = true;
      return scanning;
    }
    scanning = (async () => {
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
        scanning = null;
      }
    })();
    return scanning;
  }

  /** Forget the delivered page, so the next scan reports it again (a report in flight included). */
  function forget(): void {
    lastFingerprint = null;
    resets++;
  }

  async function rescan(force = false): Promise<ScanResult | null> {
    if (stopped || !started) return null;
    if (force) forget();
    await scan();
    return latest;
  }

  function sync(): void {
    if (stopped) return;
    void recording.sync().catch(() => undefined);
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
          // Page code can construct a persisted PageTransitionEvent; only the browser's counts.
          if (!isTrusted(e)) return;
          restored = persisted(e);
        } catch {
          return;
        }
        if (!restored) return;
        forget();
        schedule();
        sync();
      },
      false,
    );
    try {
      env.onNudge?.(sync);
    } catch {
      // no nudges: the recording state is still read after each scan start and restore
    }
    try {
      env.onFlush?.(() => recording.flushed());
    } catch {
      // no flushes: a popup Finish waits at most its timeout
    }
    void scan().then(sync);
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
  return { rescan: () => rescan(), stop };
}
