// Content side of a recording (spec 6.2): ask the worker whether this tab records, capture the
// user's trusted edits on eligible, non-secret controls, and show the pill. DOM-only plus an
// injected `send`, like the runner. The page is hostile: every DOM member is captured from the
// prototypes at import time, only trusted events outside Refill's own fill count, the rules are
// re-checked at event time, and nothing is logged. Decisions: ADR 0032.

import { getter, nodeType } from "../fields/dom";
import {
  controlKind,
  isEligible,
  type ControlKind,
} from "../fields/eligibility";
import type { ScanResult, ScannedControl } from "../fields/scan";
import { isSensitive, type PasswordHistory } from "../fields/sensitive";
import {
  buildSignature,
  type FormControl,
  type Sig,
} from "../fields/signature";
import { isFilling } from "../fill/fill";
// Types only: the protocol module's runtime imports reach `wxt/browser` (ADR 0026).
import type {
  ContentRequest,
  RecordState,
} from "../messaging/content-protocol";
import { LIMITS } from "../profiles/types";
import { PageDefaults, readValue } from "../recorder/capture";
import { createPill, type Pill } from "./pill";
import { stillMeans } from "./still-means";

/** Quiet period after the last `input` on a control before its value is sent. */
export const CAPTURE_DEBOUNCE_MS = 400;
/** The worker rejects a capture whose value or page default is longer (ADR 0030). */
const MAX_VALUE = LIMITS.value;

export interface RecordingEnv {
  doc: Document;
  /** The runner's `send`: resolves to something that is not a `RecordState` when it failed. */
  send(msg: ContentRequest): Promise<unknown>;
  /** The runner's most recent scan. */
  latest(): ScanResult | null;
  /** Scans now and resolves once that scan's report (if any) was delivered. `force` reports even an
   *  unchanged page. */
  rescan(force?: boolean): Promise<ScanResult | null>;
  /** The field id Refill filled into `el` in this document, if any. */
  filledField(el: Element): string | null;
  history: PasswordHistory;
  /** Tests only: defaults to `event.isTrusted`. */
  isTrusted?: (e: Event) => boolean;
  /** Tests only (see `isEligible`). */
  isTopWindow?: ((win: Window) => boolean) | undefined;
}

export interface Recording {
  /** Asks the worker for this tab's state and starts, updates or stops capturing to match. */
  sync(): Promise<void>;
  /** A shadow root the runner watches: `change` does not leave a shadow tree, so it is listened to. */
  observeRoot(root: ShadowRoot): void;
  /** Called with every scan, before its fill plan is applied. */
  noteScan(r: ScanResult): void;
  /** True while this tab records (`on` or `full`): fills are once per element (ruling P20). */
  active(): boolean;
  /** True while recording when the user edited `el` in this document: Refill never fills it. */
  edited(el: Element): boolean;
  /** True for the pill's own host element, which the runner leaves out of its scans. */
  ownsHost(el: Element): boolean;
  /**
   * Sends every debounced edit now and resolves once every capture made so far has been answered,
   * or dropped (a popup Finish, ADR 0032). Resolves at once when not recording.
   */
  flushed(): Promise<void>;
  /** Detaches everything and removes the pill; idempotent. */
  stop(): void;
}

const addListener = EventTarget.prototype.addEventListener;
const removeListener = EventTarget.prototype.removeEventListener;
const composedPathFn = Event.prototype.composedPath;
const eventType = getter<string>(Event.prototype, "type");
const defaultView = getter<Window | null>(Document.prototype, "defaultView");

type Active = "on" | "full";

/** A strictly checked `RecordState` from a worker reply, or null for anything else. */
function recordState(raw: unknown): RecordState | null {
  if (typeof raw !== "object" || raw === null) return null;
  const r = raw as Record<string, unknown>;
  switch (r["state"]) {
    case "off":
      return { state: "off" };
    case "on":
    case "full": {
      const count = r["count"];
      if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
        return null;
      }
      return { state: r["state"], count };
    }
    case "stopped": {
      const reason = r["reason"];
      return reason === "locked" || reason === "expired"
        ? { state: "stopped", reason }
        : null;
    }
    default:
      return null;
  }
}

/** The deepest target of `e`: inside an open (or, for a root listener, its own closed) shadow tree. */
function targetOf(e: Event): Element | null {
  try {
    const first = (composedPathFn.call(e) as EventTarget[])[0];
    if (first === undefined || typeof first !== "object") return null;
    return nodeType(first as Node) === Node.ELEMENT_NODE
      ? (first as Element)
      : null;
  } catch {
    return null;
  }
}

function kindOf(el: Element): ControlKind | null {
  try {
    return controlKind(el);
  } catch {
    return null;
  }
}

interface Pending {
  el: FormControl;
  value: string;
  pageDefault: string;
  fieldId: string | null;
}

/** Something a capture may wait for: settled once its promise has. */
interface Gate {
  settled: boolean;
  done: Promise<void>;
}

const OPEN: Gate = { settled: true, done: Promise.resolve() };

function gate(p: Promise<unknown>): Gate {
  const g: Gate = { settled: false, done: Promise.resolve() };
  const settle = (): void => {
    g.settled = true;
  };
  // `settled` is set before anything awaiting `done` resumes.
  g.done = p.then(settle, settle);
  return g;
}

export function createRecording(env: RecordingEnv): Recording {
  const { doc, history, isTopWindow } = env;
  const isTrusted = env.isTrusted ?? ((e: Event) => e.isTrusted);
  const defaults = new PageDefaults();
  /** Element -> its signature when the user edited it (null: unknown, edited under any meaning). */
  const editedEls = new WeakMap<Element, Sig | null>();
  const roots = new Set<ShadowRoot>();
  const handled = new WeakSet<Event>();
  const timers = new Map<
    Element,
    { timer: ReturnType<typeof setTimeout>; p: Pending }
  >();
  let state: Active | null = null;
  let stopped = false;
  let finishing = false;
  /** The worker keeps answering `stopped` for 30 min (ADR 0029): the notice shows once per document. */
  let stoppedShown = false;
  let pill: Pill | null = null;
  /**
   * The start report (P12): no capture is sent before it is answered. Captures of different
   * controls do not wait for each other (ruling F4); see `enqueue`.
   */
  let filed: Gate = OPEN;
  /** Every capture not yet answered or dropped: what Finish and `flushed()` wait for. */
  const pending = new Set<Gate>();
  /** Per element, its newest capture: the next one waits for it to be answered. */
  const lastOf = new WeakMap<Element, Gate>();
  /** Per element, the number of the newest capture sent: an older one is never sent after it. */
  const sentSeq = new WeakMap<Element, number>();
  let seq = 0;

  const onEdit = (e: Event): void => {
    handle(e);
  };
  // The document may be gone once these handlers return: pending edits are sent in the handler.
  const onPageHide = (): void => {
    flush(true);
  };
  const onSubmit = (e: Event): void => {
    let trusted: boolean;
    try {
      trusted = isTrusted(e);
    } catch {
      return;
    }
    if (trusted) flush(true);
  };

  function win(): Window | null {
    try {
      return defaultView(doc);
    } catch {
      return null;
    }
  }

  function attach(target: EventTarget): void {
    addListener.call(target, "input", onEdit, { capture: true, passive: true });
    addListener.call(target, "change", onEdit, {
      capture: true,
      passive: true,
    });
    // `submit` is not composed either: a form in a shadow tree is heard on its root.
    addListener.call(target, "submit", onSubmit, {
      capture: true,
      passive: true,
    });
  }
  function detachFrom(target: EventTarget): void {
    try {
      removeListener.call(target, "input", onEdit, true);
      removeListener.call(target, "change", onEdit, true);
      removeListener.call(target, "submit", onSubmit, true);
    } catch {
      // nothing more to undo
    }
  }

  function activate(): void {
    attach(doc);
    for (const root of roots) attach(root);
    const w = win();
    if (w !== null) addListener.call(w, "pagehide", onPageHide, true);
  }

  function deactivate(): void {
    if (state === null) return;
    state = null;
    detachFrom(doc);
    for (const root of roots) detachFrom(root);
    const w = win();
    if (w !== null) {
      try {
        removeListener.call(w, "pagehide", onPageHide, true);
      } catch {
        // nothing more to undo
      }
    }
    // The session is gone: edits not yet sent have nowhere to go.
    for (const { timer } of timers.values()) clearTimeout(timer);
    timers.clear();
  }

  function thePill(): Pill {
    pill ??= createPill(doc, finish);
    return pill;
  }

  /**
   * Applies a worker answer. Only `sync` may start capturing (`start`): a capture's answer can
   * update the count or end the recording, never begin one.
   */
  function apply(s: RecordState, start: boolean): boolean {
    if (stopped) return false;
    switch (s.state) {
      case "on":
      case "full": {
        const begins = state === null;
        if (begins && !start) return false;
        if (begins) activate();
        state = s.state;
        thePill().show({ kind: s.state, count: s.count });
        return begins;
      }
      case "off":
        deactivate();
        pill?.hide();
        return false;
      case "stopped":
        deactivate();
        if (stoppedShown) {
          pill?.hide();
        } else {
          stoppedShown = true;
          thePill().show({ kind: "stopped", reason: s.reason });
        }
        return false;
    }
  }

  async function sync(): Promise<void> {
    if (stopped) return;
    const s = recordState(await env.send({ type: "record-status" }));
    if (s === null || stopped) return; // a failed send keeps the current state
    // Starting: file the current page with the worker before any capture, even when the runner
    // already reported this page (Plan 3 ruling P12). The listeners are live from `apply` on, so the
    // gate closes in the same task: no capture can overtake that report.
    if (!apply(s, true)) return;
    const report = env.rescan(true);
    filed = gate(report);
    await report;
  }

  function handle(e: Event): void {
    if (stopped || state === null || handled.has(e)) return;
    const el = targetOf(e);
    if (el === null) return;
    const kind = kindOf(el);
    if (kind === null) return; // a closed shadow host, or no control: its own root listener has it
    handled.add(e);
    let trusted: boolean;
    try {
      trusted = isTrusted(e);
    } catch {
      return;
    }
    if (!trusted || isFilling()) return;
    const control = el as FormControl;
    let sig: Sig | null;
    try {
      sig = buildSignature(control, 0, null);
    } catch {
      sig = null;
    }
    editedEls.set(el, sig);
    const type = eventType(e);
    const pending = timers.get(el);
    if (pending !== undefined) {
      clearTimeout(pending.timer);
      timers.delete(el);
    }
    // The rules again, now: the scan's verdict may be stale (a type flip, a field hidden since).
    if (sig === null || !allowed(control, sig)) return;
    const read = readValue(control, kind);
    if (read === null) return; // an unchecked radio: its checked sibling carries the choice
    const pageDefault = defaults.get(control, kind);
    if (pageDefault.length > MAX_VALUE) return; // the worker would reject the whole capture
    // Too long to save: send it as a revert, so the worker drops the field instead of keeping a
    // shorter value captured earlier.
    const value = read.length > MAX_VALUE ? pageDefault : read;
    const p: Pending = {
      el: control,
      value,
      pageDefault,
      fieldId: env.filledField(el),
    };
    if (type === "change") {
      enqueue(p);
      return;
    }
    const timer = setTimeout(() => {
      timers.delete(el);
      enqueue(p);
    }, CAPTURE_DEBOUNCE_MS);
    timers.set(el, { timer, p });
  }

  function allowed(el: FormControl, sig: Sig): boolean {
    try {
      if (!isEligible(el, doc, isTopWindow)) return false;
      return !isSensitive(el, sig, history);
    } catch {
      return false;
    }
  }

  /**
   * Sends every debounced edit now (Finish, and with `unloading` a page hide or a submit). While
   * unloading, an edit is sent in this call even when an earlier capture of its control is still
   * unanswered: later would be too late.
   */
  function flush(unloading = false): void {
    const all = [...timers.values()];
    timers.clear();
    for (const { timer, p } of all) {
      clearTimeout(timer);
      enqueue(p, unloading);
    }
  }

  /**
   * Starts a capture: sent at once (in this call) unless the start report is unanswered, the
   * control is not in the latest scan, or (unless `unloading`) an earlier capture of the same
   * control is unanswered. Captures of other controls never wait for each other's replies.
   */
  function enqueue(p: Pending, unloading = false): void {
    if (p.value.length > MAX_VALUE || p.pageDefault.length > MAX_VALUE) return;
    const prev = unloading ? undefined : lastOf.get(p.el);
    const g = gate(deliver(p, ++seq, prev));
    pending.add(g);
    lastOf.set(p.el, g);
    void g.done.then(() => pending.delete(g));
  }

  /** Resolves once the start report and every capture made so far are answered or dropped. */
  function settled(): Promise<void> {
    const all = [filed, ...pending].map((g) => g.done);
    return Promise.all(all).then(() => undefined);
  }

  function find(r: ScanResult | null, el: Element): ScannedControl | null {
    if (r === null) return null;
    for (const c of r.controls) {
      if (c.el === el) return stillMeans(c.el, c.sig) ? c : null;
    }
    return null;
  }

  /**
   * Synchronous up to `env.send` when nothing is to be waited for (an async function runs its body
   * until the first `await`): a page hide or submit gets its edits out before the handler returns.
   */
  async function deliver(
    p: Pending,
    mine: number,
    prev: Gate | undefined,
  ): Promise<void> {
    let rescanned = false;
    for (;;) {
      if (stopped || state === null) return;
      if (!filed.settled) {
        await filed.done;
        continue;
      }
      // One capture of a control at a time: the worker applies it before the next is sent.
      if (prev !== undefined && !prev.settled) {
        await prev.done;
        continue;
      }
      // The worker files a capture under the page it last saw: a control the last scan did not
      // report (added since, or re-used in place for another field) waits for a scan that does.
      if (find(env.latest(), p.el) !== null || rescanned) break;
      rescanned = true;
      await env.rescan();
    }
    const control = find(env.latest(), p.el);
    if (control === null) return;
    // A newer edit of this control went out first (a page hide while this one waited): it stands.
    if ((sentSeq.get(p.el) ?? 0) > mine) return;
    sentSeq.set(p.el, mine);
    const reply = await env.send({
      type: "record-capture",
      kind: control.kind,
      sig: control.sig,
      value: p.value,
      pageDefault: p.pageDefault,
      fieldId: p.fieldId,
    });
    const s = recordState(reply);
    if (s !== null) apply(s, false);
  }

  function finish(): void {
    if (stopped || finishing) return;
    finishing = true;
    flush();
    settled()
      .then(async () => {
        const reply = await env.send({ type: "record-finish" });
        if (
          typeof reply === "object" &&
          reply !== null &&
          (reply as Record<string, unknown>)["ok"] === true
        ) {
          // The worker opened the review page; the session is no longer this tab's.
          apply({ state: "off" }, false);
        } else {
          await sync();
        }
      })
      .catch(() => undefined)
      .finally(() => {
        finishing = false;
      });
  }

  return {
    sync,
    observeRoot(root) {
      if (stopped || roots.has(root)) return;
      roots.add(root);
      if (state !== null) attach(root);
    },
    noteScan(r) {
      defaults.note(r.controls);
    },
    active: () => state !== null,
    edited: (el) => {
      if (state === null || !editedEls.has(el)) return false;
      const sig = editedEls.get(el) ?? null;
      // Re-used by the page for another field: the user has not edited that one (ruling P13).
      return sig === null || stillMeans(el as FormControl, sig);
    },
    ownsHost: (el) => pill !== null && pill.host === el,
    flushed() {
      if (stopped || state === null) return Promise.resolve();
      flush();
      return settled();
    },
    stop() {
      if (stopped) return;
      deactivate();
      stopped = true;
      pill?.remove();
    },
  };
}
