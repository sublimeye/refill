// Content-script runtime (spec 5.2, 5.4 to 5.6, 6.3): scan the page, send the signatures, apply the
// fill plan, re-scan when the page changes, and own the page's one notice (filled with Undo, ready,
// locked with Unlock, updated; the recording states through `recording.ts`). DOM-only plus an
// injected `send`: no extension API is touched here, so it runs unchanged in browser-mode tests.
// The page is hostile: every DOM member used on page objects is captured from the prototypes at
// import time, nothing is logged, and a failure stops quietly. Decisions: ADR 0026, ADR 0036.

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
  isFilling,
  snapshot,
  undo,
  withFillingGuard,
  type FillItem as ControlItem,
  type FillRecord,
} from "../fill/fill";
// Types only: the protocol module's runtime imports reach `wxt/browser`, whose `globalThis.browser`
// lookup page markup can answer (ADR 0026). Nothing of it may load in the content script.
import type { ContentRequest, FillItem } from "../messaging/content-protocol";
// DOM-free and free of `wxt/browser` (it imports only `sites/origin`): safe here.
import { ID_RE, LIMITS } from "../profiles/types";
import { readValue } from "../recorder/capture";
import { createOutlines } from "./outline";
import { createPill, type PillState } from "./pill";
import { createRecording, targetOf } from "./recording";
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
  /** Tests and e2e: hears the notice's kind on every show and null on every hide (pill `onChange`). */
  onNotice?: ((kind: PillState["kind"] | null) => void) | undefined;
}

export interface ContentRun {
  /** Scans now; resolves with the scan once its report (if the page changed) was delivered. */
  rescan(): Promise<ScanResult | null>;
  /** Disconnects every observer and listener, takes the outlines off and removes the notice;
   *  idempotent. */
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

/** A worker answer the runner acts on (`none` needs nothing). */
type Plan =
  | { state: "fill"; items: FillItem[]; ask: number[]; recording: boolean }
  | { state: "gesture"; fieldIds: string[] }
  | { state: "locked" };

/**
 * Strict check of the worker's answer to a scan-report: a fill, gesture or locked plan, or null for
 * `none`, a router error, or anything malformed.
 */
function parsePlan(plan: unknown): Plan | null {
  if (typeof plan !== "object" || plan === null) return null;
  const p = plan as Record<string, unknown>;
  switch (p["state"]) {
    case "fill": {
      const items = fillItems(p["items"]);
      const ask = askIndices(p["ask"]);
      const recording = p["recording"];
      return items === null || ask === null || typeof recording !== "boolean"
        ? null
        : { state: "fill", items, ask, recording };
    }
    case "gesture": {
      const fieldIds = ids(p["fieldIds"]);
      return fieldIds === null ? null : { state: "gesture", fieldIds };
    }
    case "locked":
      return { state: "locked" };
    default:
      return null;
  }
}

/** Unique control indices in 0..MAX_CONTROLS-1, at most MAX_CONTROLS of them. */
function askIndices(raw: unknown): number[] | null {
  if (!Array.isArray(raw) || raw.length > MAX_CONTROLS) return null;
  const seen = new Set<number>();
  for (const i of raw as unknown[]) {
    if (
      typeof i !== "number" ||
      !Number.isInteger(i) ||
      i < 0 ||
      i >= MAX_CONTROLS ||
      seen.has(i)
    ) {
      return null;
    }
    seen.add(i);
  }
  return [...seen];
}

/** Profile field ids (`ID_RE`), at most the profile's field limit. */
function ids(raw: unknown): string[] | null {
  if (!Array.isArray(raw) || raw.length > LIMITS.fields) return null;
  const out: string[] = [];
  for (const id of raw as unknown[]) {
    if (typeof id !== "string" || !ID_RE.test(id)) return null;
    out.push(id);
  }
  return out;
}

function fillItems(items: unknown): FillItem[] | null {
  if (!Array.isArray(items)) return null;
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

function ok(reply: unknown): boolean {
  return (
    typeof reply === "object" &&
    reply !== null &&
    (reply as Record<string, unknown>)["ok"] === true
  );
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
 * once per document, or while recording at most once per element, ruling P20) and send a
 * `fill-result`. Re-scan after DOM changes (also inside shadow roots
 * the scan entered) and after `scrollend` (window and, in the capture phase, any scroll container),
 * debounced. A bfcache restore reports again but keeps the filled ids. A worker nudge re-reads the
 * recording state and reports the page again. Outside recording, the page's one notice says what
 * happened (`filled` with Undo, `ready`, `locked` with Unlock) and `ask` fields are outlined
 * (ADR 0036). When the extension context goes away everything stops, silently, except that a
 * document Refill already touched is told to reload (`updated`).
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
  /** Field ids written (or refused by the page) in this document: Plan 2's once-only rule. */
  const filled = new Set<string>();
  /**
   * The same per element: while recording a field id is written at most once into each element, so
   * an SPA's Back, which renders the step again as new elements, shows the recorded values every
   * time (ruling P20). Outside recording `filled` alone decides (ADR 0026).
   */
  const filledEls = new WeakMap<Element, Set<string>>();
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
  /** What Refill filled outside recording and has not undone: what Undo puts back (ADR 0036). */
  const records: FillRecord[] = [];
  const outlines = createOutlines();
  /** Controls whose outline the user's own edit took off: never outlined again here (ruling R4). */
  const released = new WeakSet<Element>();
  /**
   * The pending field ids of the last `ready` shown in this document (sorted, one key): the same
   * ids are not shown again, while another step's ids are, even with the same count.
   */
  let readyShown: string | null = null;
  /** `locked` shows once per document (a bfcache restore is the same document). */
  let lockedShown = false;
  /** A notice was shown in this document: an orphaned script then says `updated`. */
  let spoke = false;

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

  // The page's one notice. Its actions run only on a trusted click (pill.ts).
  const pill = createPill(
    doc,
    {
      finish: () => {
        recording.finish();
      },
      undo: undoFill,
      unlock,
    },
    (kind) => {
      if (kind !== null) spoke = true;
      env.onNotice?.(kind);
    },
  );

  const recording = createRecording({
    doc,
    pill: () => pill,
    send: (msg) => send(msg),
    // A recording starts in this document: its fills are the session's, not a return visit's. What
    // Undo would put back and the outlines go (ADR 0036).
    started: () => {
      records.length = 0;
      outlines.clear();
    },
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

  /** Stops the run. `keepNotice`: the notice on screen stays until its own timer hides it. */
  function stop(keepNotice = false): void {
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
    outlines.clear();
    if (!keepNotice) pill.remove();
  }

  /**
   * The extension is gone (updated, reloaded or removed): stop. A document Refill filled, recorded
   * or spoke in is told to reload, since nothing here works any more; the notice times out by itself.
   */
  function gone(): void {
    if (stopped) return;
    const tell = filled.size > 0 || spoke || recording.active();
    if (tell) pill.show({ kind: "updated" });
    stop(tell);
  }

  /** Every shadow root the scan enters is observed too: a document observer does not see inside. */
  function shadowRootOf(el: Element): ShadowRoot | null {
    let root: ShadowRoot | null;
    try {
      if (el === pill.host) return null; // the notice: no controls, and its updates are no change

      root = env.openOrClosedShadowRoot?.(el) ?? ownShadowRoot(el);
    } catch {
      return null;
    }
    if (root !== null && !watched.has(root)) {
      watched.add(root);
      recording.observeRoot(root);
      // `change` does not leave a shadow tree, and a closed one retargets `input` to its host.
      listen(root, "input", onAskEdit, true);
      listen(root, "change", onAskEdit, true);
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
      gone();
      return FAILED;
    }
    try {
      return await env.send(msg);
    } catch (err) {
      if (invalidated(err) || !aliveNow()) gone();
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

  function markFilled(fieldId: string, el: Element): void {
    filled.add(fieldId);
    const ids = filledEls.get(el);
    if (ids === undefined) filledEls.set(el, new Set([fieldId]));
    else ids.add(fieldId);
  }

  /** Applies a fill plan's items; with `keep`, each write is recorded for Undo. */
  function apply(
    items: FillItem[],
    controls: ScannedControl[],
    keep: boolean,
  ): { filled: number; skipped: number; unsupported: number } {
    const counts = { filled: 0, skipped: 0, unsupported: 0 };
    withFillingGuard(() => {
      // Vet every item against the page as it was before any write: a page handler that runs
      // during one fill must not make another field look empty.
      const ready: { fieldId: string; item: ControlItem; sig: Sig }[] = [];
      const named = new Set<string>();
      const perElement = recording.active();
      for (const { fieldId, i, kind, value, pageDefault } of items) {
        const control = controls[i];
        // Filled earlier in this document (into this element, while recording), or named twice in
        // this plan: never written again.
        const done = perElement
          ? control !== undefined &&
            filledEls.get(control.el)?.has(fieldId) === true
          : filled.has(fieldId);
        if (done || named.has(fieldId)) continue;
        named.add(fieldId);
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
        // The state right before this write: what Undo puts back.
        const before = keep ? snapshot([item]).entries[0] : undefined;
        switch (fillControl(item, history, origin, isTopWindow)) {
          case "filled":
            markFilled(fieldId, item.el);
            filledInto.set(item.el, { fieldId, sig });
            if (before !== undefined) {
              records.push({ before, written: item.value });
            }
            counts.filled++;
            break;
          case "unsupported":
          case "rejected-by-page":
            // Not retried: a custom widget or a refusing page will refuse again.
            markFilled(fieldId, item.el);
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
    const parsed = parsePlan(plan);
    if (parsed === null) return;
    if (parsed.state === "gesture") {
      ready(parsed.fieldIds);
      return;
    }
    if (parsed.state === "locked") {
      locked();
      return;
    }
    // While recording, fills come from the session: no Undo, no outline, no notice (ruling R1).
    // The worker marks a session plan (ruling R3): a fresh document's first plan, or one racing the
    // nudge that starts a recording, arrives before `record-status` has answered.
    const quiet = recording.active() || parsed.recording;
    const had = records.length;
    const counts = apply(parsed.items, result.controls, !quiet);
    if (!quiet) {
      outlineAsks(parsed.ask, result.controls);
      if (records.length > had) {
        pill.show({
          kind: "filled",
          count: records.length,
          ask: outlines.count(),
        });
      }
    }
    // A plan that wrote nothing still reports the running total while the document has fills not
    // undone: the unlock pass cleared the badge, and this re-report is what sets it again.
    const touched = counts.filled + counts.skipped + counts.unsupported > 0;
    if (!touched && (quiet || records.length === 0)) return;
    // `filled` is the document's running total of fills not undone (the badge's count).
    await send({
      type: "fill-result",
      ...counts,
      filled: quiet ? counts.filled : Math.min(records.length, MAX_CONTROLS),
    });
  }

  /** Outlines each `ask` control that is still what was scanned and, for text or select, empty. */
  function outlineAsks(ask: number[], controls: ScannedControl[]): void {
    for (const i of ask) {
      const c = controls[i];
      if (c === undefined) continue;
      try {
        if (!stillMeans(c.el, c.sig)) continue;
      } catch {
        continue;
      }
      if (
        (c.kind === "text" || c.kind === "select") &&
        readValue(c.el, c.kind) !== ""
      ) {
        continue; // the user already has it
      }
      if (released.has(c.el)) continue; // the user has dealt with it
      outlines.add(c.el);
    }
  }

  /** The user's own edit of an outlined control takes its outline off. */
  function onAskEdit(e: Event): void {
    if (outlines.count() === 0) return;
    let trusted: boolean;
    try {
      trusted = isTrusted(e);
    } catch {
      return;
    }
    if (!trusted || isFilling()) return;
    const el = targetOf(e);
    if (el === null || !outlines.has(el)) return;
    outlines.release(el);
    released.add(el);
  }

  /** A gesture plan: the matched fields not filled yet in this document wait for Fill now. */
  function ready(fieldIds: string[]): void {
    if (recording.active()) return;
    const pending = [...new Set(fieldIds.filter((id) => !filled.has(id)))];
    if (pending.length === 0) return;
    const key = JSON.stringify(pending.sort());
    if (key === readyShown) return;
    readyShown = key;
    pill.show({ kind: "ready", count: pending.length });
  }

  function locked(): void {
    if (recording.active() || lockedShown) return;
    // "Recording stopped — vault locked" says it already, and stays until its own timer.
    if (pill.showing() === "stopped") return;
    lockedShown = true;
    pill.show({ kind: "locked", fallback: false });
  }

  /** The notice's Undo (a trusted click): puts back what Refill wrote that the user left alone. */
  function undoFill(): void {
    if (stopped || recording.active()) return;
    undo(records);
    records.length = 0;
    // The ids stay filled: a later plan does not write them again (ADR 0026).
    pill.show({ kind: "undone" });
    void send({ type: "fill-result", filled: 0, skipped: 0, unsupported: 0 });
  }

  /** The notice's Unlock (a trusted click): the worker opens the popup, or the text has to do. */
  function unlock(): void {
    if (stopped) return;
    void send({ type: "toast-unlock-click" }).then((reply) => {
      // The notice moved on meanwhile (a fill after the unlock, a recording): leave it.
      if (stopped || pill.showing() !== "locked") return;
      if (ok(reply)) pill.hide();
      else pill.show({ kind: "locked", fallback: true });
    });
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
    listen(doc, "input", onAskEdit, true);
    listen(doc, "change", onAskEdit, true);
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
      // The worker's state changed (a recording, an unlock): read the recording state, and report
      // the page again, unchanged or not, so an unlocked vault can answer it (spec 7).
      env.onNudge?.(() => {
        sync();
        void rescan(true);
      });
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
  return { rescan: () => rescan(), stop: () => stop() };
}
