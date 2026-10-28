// The extension APIs the content script needs, captured once at start and checked (ADR 0026).
//
// Window named access reaches the isolated world: on a document's first load in a tab, page markup
// replaces `browser` (`<form id="browser"><input name="runtime" id="x">`, which WXT's `browser`
// would then pick) and even `chrome` (`<form id="chrome">`, `<iframe name="chrome">`). The content
// script reads only `chrome`, once, and starts only if it is the real runtime: a plain object (not
// page markup, not a frame's window) with a callable `sendMessage` and a non-empty string `id`.
// Anything else fails closed: Refill does nothing on that page, and nothing found that way is ever
// called. A page can always disable Refill on itself; it cannot make Refill send or fill anything.

export interface ChromeApi {
  send(msg: unknown): Promise<unknown>;
  /** False once the extension context is gone (`runtime.id` becomes undefined). */
  alive(): boolean;
  openOrClosedShadowRoot: ((el: Element) => ShadowRoot | null) | undefined;
  /**
   * Calls `cb` for each worker nudge: exactly `{ type: "refill-nudge" }`, from this extension
   * (`sender.id`) and not from a tab (`sender.tab` absent). Never replies. A no-op when
   * `runtime.onMessage.addListener` is not the real API.
   */
  onNudge(cb: () => void): void;
}

/** Exactly `{ type: "refill-nudge" }`: a plain object with that one key. */
function isNudge(msg: unknown): boolean {
  try {
    if (typeof msg !== "object" || msg === null) return false;
    if (Object.getPrototypeOf(msg) !== Object.prototype) return false;
    const keys = Object.keys(msg);
    return (
      keys.length === 1 &&
      keys[0] === "type" &&
      (msg as Record<string, unknown>)["type"] === "refill-nudge"
    );
  } catch {
    return false;
  }
}

/** The worker or an extension page of this extension: its id, no tab. */
function fromExtension(sender: unknown, id: string): boolean {
  try {
    if (typeof sender !== "object" || sender === null) return false;
    const s = sender as Record<string, unknown>;
    return s["id"] === id && s["tab"] === undefined;
  } catch {
    return false;
  }
}

/** A non-null object that is not page markup (an element, or a frame's window). */
function apiObject(x: unknown): x is Record<string, unknown> {
  try {
    if (typeof x !== "object" || x === null) return false;
    if (x instanceof Node) return false;
    // A WindowProxy (named frame) refers to itself as `window`.
    return (x as { window?: unknown }).window !== x;
  } catch {
    return false; // a cross-origin frame's window throws on property access
  }
}

function apiFunction(x: unknown): x is (...args: unknown[]) => unknown {
  return typeof x === "function" && !(x instanceof Node);
}

const idOf = (runtime: Record<string, unknown>): unknown => {
  try {
    return runtime["id"];
  } catch {
    return undefined;
  }
};

/** `globalThis.chrome` checked and captured, or null when it is not the real extension API. */
export function captureChrome(chrome: unknown): ChromeApi | null {
  if (!apiObject(chrome)) return null;
  let runtime: unknown;
  let dom: unknown;
  try {
    runtime = chrome["runtime"];
    dom = chrome["dom"];
  } catch {
    return null;
  }
  if (!apiObject(runtime)) return null;
  let sendMessage: unknown;
  let onMessage: unknown;
  try {
    sendMessage = runtime["sendMessage"];
    onMessage = runtime["onMessage"];
  } catch {
    return null;
  }
  const id = idOf(runtime);
  if (!apiFunction(sendMessage) || typeof id !== "string" || id === "") {
    return null;
  }

  // Optional: without it the content script still reads the recording state at start and restore.
  let addListener: ((...args: unknown[]) => unknown) | undefined;
  if (apiObject(onMessage)) {
    try {
      const add = onMessage["addListener"];
      if (apiFunction(add)) addListener = add;
    } catch {
      addListener = undefined;
    }
  }

  let openOrClosedShadowRoot: ChromeApi["openOrClosedShadowRoot"];
  if (apiObject(dom)) {
    const read = dom["openOrClosedShadowRoot"];
    if (apiFunction(read)) {
      openOrClosedShadowRoot = (el) => {
        try {
          const root = Reflect.apply(read, dom, [el]);
          return root instanceof ShadowRoot ? root : null;
        } catch {
          return null;
        }
      };
    }
  }

  return {
    send: (msg) => Promise.resolve(Reflect.apply(sendMessage, runtime, [msg])),
    alive: () => {
      const now = idOf(runtime);
      return typeof now === "string" && now !== "";
    },
    openOrClosedShadowRoot,
    onNudge: (cb) => {
      if (addListener === undefined) return;
      const listener = (msg: unknown, sender: unknown): undefined => {
        // Never `true` and never `sendResponse`: a nudge gets no reply.
        if (isNudge(msg) && fromExtension(sender, id)) {
          try {
            cb();
          } catch {
            // nothing to report
          }
        }
        return undefined;
      };
      try {
        Reflect.apply(addListener, onMessage, [listener]);
      } catch {
        // no nudges
      }
    },
  };
}
