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
  const sendMessage = runtime["sendMessage"];
  const id = idOf(runtime);
  if (!apiFunction(sendMessage) || typeof id !== "string" || id === "") {
    return null;
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
  };
}
