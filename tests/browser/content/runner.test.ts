import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import type { PillState } from "../../../src/lib/content/pill";
import {
  RESCAN_DEBOUNCE_MS,
  RESCAN_MAX_WAIT_MS,
  startContentScript,
  type ContentEnv,
  type ContentRun,
} from "../../../src/lib/content/runner";
import type {
  ContentRequest,
  FillItem,
  FillPlan,
} from "../../../src/lib/messaging/content-protocol";

/** Every state the runner asked its notice to show, in order (a pass-through spy on the pill). */
const shown = vi.hoisted(() => [] as unknown[]);
vi.mock(import("../../../src/lib/content/pill"), async (importOriginal) => {
  const mod = await importOriginal();
  return {
    ...mod,
    createPill: (...args: Parameters<typeof mod.createPill>) => {
      const p = mod.createPill(...args);
      return {
        ...p,
        show: (state: PillState) => {
          shown.push(structuredClone(state));
          p.show(state);
        },
      };
    },
  };
});

// Vitest browser mode runs tests inside an iframe, so the top-frame rule is stubbed (as in the
// scanner tests). The real check is the entrypoint's `window !== window.top` plus the e2e suite.
const top = () => true;
const ORIGIN = "https://bills.example";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Long enough for one debounced re-scan and its messages. */
const settle = () => sleep(RESCAN_DEBOUNCE_MS + 150);

const runs: ContentRun[] = [];

afterEach(() => {
  for (const r of runs.splice(0)) r.stop();
  document.body.replaceChildren();
  shown.splice(0);
  // An `updated` notice outlives its run until its own timer (it sits on <html>, not <body>).
  for (const n of document.querySelectorAll("[popover]")) n.remove();
});

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html; // test-only fixture markup
  document.body.append(root);
  return root;
}

type Planner = (
  req: Extract<ContentRequest, { type: "scan-report" }>,
) => FillPlan | unknown;

interface Harness {
  sent: ContentRequest[];
  /** Every kind `onNotice` heard (null: hidden). */
  notices: (PillState["kind"] | null)[];
  reports: () => Extract<ContentRequest, { type: "scan-report" }>[];
  results: () => Extract<ContentRequest, { type: "fill-result" }>[];
  env: ContentEnv;
}

function harness(
  plan: Planner = () => ({ state: "none" }),
  over: Partial<ContentEnv> = {},
): Harness {
  const sent: ContentRequest[] = [];
  const notices: (PillState["kind"] | null)[] = [];
  const env: ContentEnv = {
    win: window,
    doc: document,
    origin: ORIGIN,
    send: vi.fn(async (msg: ContentRequest) => {
      sent.push(structuredClone(msg));
      return msg.type === "scan-report" ? plan(msg) : { ok: true };
    }),
    alive: () => true,
    isTopWindow: top,
    onNotice: (kind) => {
      notices.push(kind);
    },
    ...over,
  };
  return {
    sent,
    notices,
    env,
    reports: () =>
      sent.filter(
        (m): m is Extract<ContentRequest, { type: "scan-report" }> =>
          m.type === "scan-report",
      ),
    results: () =>
      sent.filter(
        (m): m is Extract<ContentRequest, { type: "fill-result" }> =>
          m.type === "fill-result",
      ),
  };
}

function start(h: Harness, scope: object = {}): ContentRun | null {
  const run = startContentScript(scope, h.env);
  if (run !== null) runs.push(run);
  return run;
}

/** A plan filling each control whose `name` is a key of `values` (field id = name). */
function byName(values: Record<string, string>): Planner {
  return (req) => {
    const items: FillItem[] = [];
    for (const c of req.controls) {
      const name = c.sig.name;
      if (name === null || !Object.hasOwn(values, name)) continue;
      items.push({
        fieldId: name,
        i: c.i,
        kind: c.kind,
        value: values[name]!,
        pageDefault: "",
      });
    }
    return {
      state: "fill",
      items,
      ask: [],
      recording: false,
    } satisfies FillPlan;
  };
}

const input = (name: string) =>
  document.querySelector<HTMLInputElement>(`[name="${name}"]`)!;

describe("scan, report, fill", () => {
  it("reports signatures only, fills the plan and reports the counts", async () => {
    mount(
      `<form><label>Name <input name="name"></label>` +
        `<label>Email <input name="email" type="email" value="typed@me"></label>` +
        `<label>Plan <select name="plan"><option value=""></option><option value="a">A</option></select></label></form>`,
    );
    const h = harness(
      byName({ name: "Ada", email: "ada@example.test", plan: "zzz" }),
    );
    start(h);
    await vi.waitFor(() => expect(h.results()).toHaveLength(1));

    const [report] = h.reports();
    expect(report!.controls.map((c) => c.sig.name)).toEqual([
      "name",
      "email",
      "plan",
    ]);
    expect(Object.keys(report!.controls[0]!).sort()).toEqual([
      "i",
      "kind",
      "sig",
    ]);
    // The page's own value never leaves the page.
    expect(JSON.stringify(h.sent)).not.toContain("typed@me");
    expect(input("name").value).toBe("Ada");
    expect(input("email").value).toBe("typed@me"); // not empty, not the page default
    expect(h.results()[0]).toEqual({
      type: "fill-result",
      filled: 1,
      skipped: 1,
      unsupported: 1, // no option "zzz"
    });
  });

  it("sends nothing on a non-https origin", async () => {
    mount(`<input name="name">`);
    const h = harness(byName({ name: "Ada" }), {
      origin: "http://bills.example",
    });
    start(h);
    await settle();
    expect(h.sent).toEqual([]);
    expect(input("name").value).toBe("");
  });

  it("reports nothing for a page without eligible controls (it only asks the recording state)", async () => {
    mount(`<p>No form here</p><input type="hidden" name="t">`);
    const h = harness();
    start(h);
    await settle();
    // A wizard's last page has no fields, and the pill's Finish must still show there.
    expect(h.sent).toEqual([{ type: "record-status" }]);
  });

  it("does nothing with a locked, none, gesture or malformed answer", async () => {
    for (const answer of [
      { state: "locked" },
      { state: "none" },
      { state: "gesture", fieldIds: ["f1"] },
      { ok: false, error: "rejected" },
      { state: "fill", items: [{ fieldId: "name", i: 0 }] },
      { state: "fill", items: "nope" },
      // `ask` missing, repeated, out of range or not an integer
      { state: "fill", items: [] },
      { state: "fill", items: [], ask: [0, 0] },
      { state: "fill", items: [], ask: [300] },
      { state: "fill", items: [], ask: [0.5] },
      // `recording` missing or not a boolean
      { state: "fill", items: [], ask: [] },
      { state: "fill", items: [], ask: [], recording: "yes" },
      { state: "gesture", fieldIds: ["bad id"] },
      { state: "gesture", fieldIds: "f1" },
      undefined,
    ]) {
      mount(`<input name="name">`);
      const h = harness(() => answer);
      const run = start(h);
      await vi.waitFor(() => expect(h.reports()).toHaveLength(1));
      await sleep(20);
      expect(input("name").value).toBe("");
      expect(h.results()).toEqual([]);
      run!.stop();
      document.body.replaceChildren();
    }
  });

  it("skips an item whose index or kind does not match the scan", async () => {
    mount(`<input name="name">`);
    const h = harness(() => ({
      state: "fill",
      items: [
        { fieldId: "a", i: 7, kind: "text", value: "x", pageDefault: "" },
        {
          fieldId: "b",
          i: 0,
          kind: "checkbox",
          value: "true",
          pageDefault: "",
        },
      ],
      ask: [],
      recording: false,
    }));
    start(h);
    await vi.waitFor(() => expect(h.results()).toHaveLength(1));
    expect(h.results()[0]).toMatchObject({ filled: 0, skipped: 2 });
    expect(input("name").value).toBe("");
  });

  it("writes a field id at most once even if the plan names it twice", async () => {
    mount(`<input name="a"><input name="b">`);
    const h = harness(() => ({
      state: "fill",
      items: [
        { fieldId: "x", i: 0, kind: "text", value: "1", pageDefault: "" },
        { fieldId: "x", i: 1, kind: "text", value: "2", pageDefault: "" },
      ],
      ask: [],
      recording: false,
    }));
    start(h);
    await vi.waitFor(() => expect(h.results()).toHaveLength(1));
    expect(input("a").value).toBe("1");
    expect(input("b").value).toBe("");
    expect(h.results()[0]).toMatchObject({ filled: 1, skipped: 0 });
  });

  it("does not fill an element the page re-used for another field during the round trip", async () => {
    mount(
      `<form><label><span id="t">Amount</span> <input name="amount"></label>` +
        `<label>Payee <input name="payee"></label></form>`,
    );
    const h = harness((req) => {
      const plan = byName({ amount: "42.00", payee: "City Water" })(req);
      // The user clicked Next: the framework renames and relabels the same node in place.
      input("amount").name = "memo";
      document.getElementById("t")!.textContent = "Memo";
      return plan;
    });
    start(h);
    await vi.waitFor(() => expect(h.results()).toHaveLength(1));
    expect(input("memo").value).toBe("");
    expect(input("payee").value).toBe("City Water");
    expect(h.results()[0]).toMatchObject({ filled: 1, skipped: 1 });
    // The re-scan reports the node under its new meaning.
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2));
    expect(h.reports()[1]!.controls[0]!.sig).toMatchObject({
      name: "memo",
      labelText: "memo",
    });
  });

  it("does not fill an element the page swapped out during the round trip", async () => {
    mount(`<form><label>Amount <input name="amount"></label></form>`);
    const h = harness((req) => {
      const plan = byName({ amount: "42.00" })(req);
      const old = input("amount");
      old.replaceWith(old.cloneNode());
      return plan;
    });
    start(h);
    await vi.waitFor(() => expect(h.results()).toHaveLength(1));
    expect(h.results()[0]).toMatchObject({ filled: 0, skipped: 1 });
    expect(input("amount").value).toBe("");
  });

  it("vets every item before writing any: a page handler cannot empty a field into a fill", async () => {
    mount(`<input name="a"><input name="b" value="typed">`);
    // The page clears b when a changes. Before Refill wrote anything, b held the user's value.
    input("a").addEventListener("input", () => {
      input("b").value = "";
    });
    const h = harness(byName({ a: "A", b: "B" }));
    start(h);
    await vi.waitFor(() => expect(h.results()).toHaveLength(1));
    expect(input("a").value).toBe("A");
    expect(input("b").value).toBe("");
    expect(h.results()[0]).toMatchObject({ filled: 1, skipped: 1 });
  });
});

describe("re-scans", () => {
  it("re-scans after a debounced DOM change and reports only a changed fingerprint", async () => {
    const root = mount(`<input name="a">`);
    const h = harness();
    start(h);
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1));

    // A burst of changes that do not alter the controls: scanned, not reported.
    for (let n = 0; n < 5; n++) root.append(document.createElement("span"));
    await settle();
    expect(h.reports()).toHaveLength(1);

    // A new control, added in several mutations: one more report, after the debounce.
    const b = document.createElement("input");
    b.name = "b";
    root.append(b);
    root.append(document.createElement("span"));
    await sleep(RESCAN_DEBOUNCE_MS / 2);
    expect(h.reports()).toHaveLength(1);
    await settle();
    expect(h.reports()).toHaveLength(2);
    expect(h.reports()[1]!.controls.map((c) => c.sig.name)).toEqual(["a", "b"]);
  });

  it("re-scans within the max wait even while the page never stops mutating", async () => {
    const root = mount(`<input name="a">`);
    const h = harness();
    start(h);
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1));
    const b = document.createElement("input");
    b.name = "b";
    root.append(b);
    const ticker = setInterval(
      () => root.append(document.createElement("span")),
      RESCAN_DEBOUNCE_MS / 5,
    );
    try {
      await sleep(RESCAN_MAX_WAIT_MS + 200);
      expect(h.reports()).toHaveLength(2);
    } finally {
      clearInterval(ticker);
    }
  });

  it("re-scans a step change inside an open shadow root", async () => {
    const host = mount(`<div id="host"></div>`).querySelector("#host")!;
    const shadow = host.attachShadow({ mode: "open" });
    const a = document.createElement("input");
    a.name = "a";
    shadow.append(a);
    const h = harness();
    start(h);
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1));
    const b = document.createElement("input");
    b.name = "b";
    shadow.append(b);
    await settle();
    expect(h.reports()).toHaveLength(2);
  });

  it("re-scans on scrollend: a field scrolled into a carousel's visible slice is reported", async () => {
    const root = mount(
      `<div id="track" style="width:300px; overflow-x:auto; white-space:nowrap">` +
        `<div style="display:inline-block; width:300px"><input name="a"></div>` +
        `<div style="display:inline-block; width:300px"><input name="b"></div>` +
        `</div>`,
    );
    const h = harness();
    start(h);
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1));
    expect(h.reports()[0]!.controls.map((c) => c.sig.name)).toEqual(["a"]);

    const track = root.querySelector<HTMLElement>("#track")!;
    track.scrollLeft = 300; // no DOM mutation: only the scroll position changes
    track.dispatchEvent(new Event("scrollend")); // does not bubble: caught in the capture phase
    await settle();
    expect(h.reports()).toHaveLength(2);
    expect(h.reports()[1]!.controls.map((c) => c.sig.name)).toEqual(["b"]);
  });

  it("a bfcache restore while a report is in flight still reports again", async () => {
    mount(`<input name="a">`);
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    let first = true;
    const h = harness(() => ({ state: "none" }), { isTrusted: () => true });
    const inner = h.env.send;
    h.env.send = async (msg) => {
      const answer = inner(msg);
      if (first) {
        first = false;
        await held;
      }
      return answer;
    };
    start(h);
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1));
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    release();
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2));
  });

  it("ignores a pageshow the page dispatched itself", async () => {
    mount(`<input name="a">`);
    const h = harness();
    start(h);
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1));
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    await settle();
    expect(h.reports()).toHaveLength(1);
  });

  it("fills each field at most once per document", async () => {
    const root = mount(`<input name="a">`);
    const h = harness(byName({ a: "A", b: "B" }));
    start(h);
    await vi.waitFor(() => expect(input("a").value).toBe("A"));

    // The user empties a; then the page changes and the plan names a again.
    input("a").value = "";
    const b = document.createElement("input");
    b.name = "b";
    root.append(b);
    await vi.waitFor(() => expect(input("b").value).toBe("B"));
    await sleep(20);
    expect(input("a").value).toBe("");
    // `filled` is the document's running total (the badge's count).
    expect(h.results()).toEqual([
      { type: "fill-result", filled: 1, skipped: 0, unsupported: 0 },
      { type: "fill-result", filled: 2, skipped: 0, unsupported: 0 },
    ]);
  });

  it("outside recording, a new element for a filled field id is not filled (Plan 2 rule, ADR 0026)", async () => {
    const root = mount(`<div id="step"><input name="a"></div>`);
    const step = root.querySelector("#step")!;
    const h = harness(byName({ a: "A" }));
    start(h);
    await vi.waitFor(() => expect(input("a").value).toBe("A"));
    // An SPA Back: step 1 re-rendered with a new, empty input for the same field.
    const fresh = document.createElement("input");
    fresh.name = "a";
    const other = document.createElement("input");
    other.name = "b";
    step.replaceChildren(fresh, other);
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2));
    await sleep(20);
    expect(input("a")).toBe(fresh);
    expect(fresh.value).toBe("");
  });

  it("a bfcache restore reports again but does not fill again", async () => {
    mount(`<input name="a">`);
    // A real bfcache restore cannot be produced here: the test trusts its synthetic events.
    const h = harness(byName({ a: "A" }), { isTrusted: () => true });
    start(h);
    await vi.waitFor(() => expect(input("a").value).toBe("A"));
    input("a").value = "";

    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2));
    await sleep(20);
    expect(input("a").value).toBe("");

    // A non-persisted pageshow is the first load, already handled; a plain Event is ignored.
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: false }),
    );
    window.dispatchEvent(new Event("pageshow"));
    await settle();
    expect(h.reports()).toHaveLength(2);
  });
});

describe("lifecycle", () => {
  it("waits for a prerendered document to be activated", async () => {
    mount(`<input name="a">`);
    let prerendering = true;
    const h = harness(byName({ a: "A" }), {
      isPrerendering: () => prerendering,
    });
    start(h);
    await settle();
    expect(h.sent).toEqual([]);
    expect(input("a").value).toBe("");

    prerendering = false;
    document.dispatchEvent(new Event("prerenderingchange"));
    await vi.waitFor(() => expect(input("a").value).toBe("A"));
    expect(h.reports()).toHaveLength(1);
  });

  it("starts once per scope: a second injection runs no second scanner", async () => {
    const root = mount(`<input name="a">`);
    const h = harness();
    const scope = {};
    expect(start(h, scope)).not.toBeNull();
    expect(start(h, scope)).toBeNull();
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1));
    const b = document.createElement("input");
    b.name = "b";
    root.append(b);
    await settle();
    await sleep(50);
    expect(h.reports()).toHaveLength(2); // one per scan cycle
  });

  it("stops everything silently when the extension context is invalidated", async () => {
    const root = mount(`<input name="a">`);
    let calls = 0;
    const h = harness();
    h.env.send = vi.fn(async () => {
      calls++;
      throw new Error("Extension context invalidated.");
    });
    const errors = vi.spyOn(console, "error");
    const run = start(h);
    await vi.waitFor(() => expect(calls).toBe(1));

    const b = document.createElement("input");
    b.name = "b";
    root.append(b);
    window.dispatchEvent(new Event("scrollend"));
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    await settle();
    expect(calls).toBe(1);
    expect(errors).not.toHaveBeenCalled();
    run!.stop(); // idempotent
    errors.mockRestore();
  });

  it("stops without sending when the runtime is gone", async () => {
    const root = mount(`<input name="a">`);
    let alive = true;
    const h = harness(() => ({ state: "none" }), { alive: () => alive });
    start(h);
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1));
    alive = false;
    const b = document.createElement("input");
    b.name = "b";
    root.append(b);
    await settle();
    alive = true;
    const c = document.createElement("input");
    c.name = "c";
    root.append(c);
    await settle();
    expect(h.reports()).toHaveLength(1);
  });

  it("keeps running after an ordinary send failure", async () => {
    const root = mount(`<input name="a">`);
    let calls = 0;
    const h = harness();
    h.env.send = vi.fn(async (msg: ContentRequest) => {
      if (msg.type !== "scan-report") return { state: "off" };
      calls++;
      if (calls === 1) throw new Error("Could not establish connection.");
      return { state: "none" };
    });
    start(h);
    await vi.waitFor(() => expect(calls).toBe(1));
    // The next trigger reports the unchanged page again: the failed report was not remembered.
    root.append(document.createElement("span"));
    await vi.waitFor(() => expect(calls).toBe(2));
    // Delivered now: the same page is not reported a third time.
    root.append(document.createElement("span"));
    await settle();
    expect(calls).toBe(2);
  });

  it("stop() ends re-scans", async () => {
    const root = mount(`<input name="a">`);
    const h = harness();
    const run = start(h)!;
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1));
    run.stop();
    const b = document.createElement("input");
    b.name = "b";
    root.append(b);
    window.dispatchEvent(new Event("scrollend"));
    await settle();
    expect(h.reports()).toHaveLength(1);
  });
});

describe("recording", () => {
  /** A worker whose `record-status` answers `status.value`; nudges are delivered by `nudge()`. */
  function recordingHarness(initial: { state: string; count?: number }) {
    const status = { value: initial as unknown };
    const nudges: (() => void)[] = [];
    const h = harness(byName({ a: "A" }), {
      onNudge: (cb) => {
        nudges.push(cb);
      },
      isTrusted: () => true, // the bfcache case dispatches its own pageshow
    });
    const send = h.env.send;
    h.env.send = vi.fn(async (msg: ContentRequest) => {
      if (msg.type === "record-status") {
        h.sent.push(structuredClone(msg));
        return status.value;
      }
      return send(msg);
    });
    const statuses = () => h.sent.filter((m) => m.type === "record-status");
    return {
      h,
      status,
      statuses,
      nudge: () => {
        for (const cb of nudges) cb();
      },
    };
  }

  it("asks the recording state after the first scan", async () => {
    mount(`<input name="a">`);
    const { h } = recordingHarness({ state: "off" });
    start(h);
    await vi.waitFor(() =>
      expect(h.sent.map((m) => m.type)).toEqual([
        "scan-report",
        "fill-result",
        "record-status",
      ]),
    );
  });

  it("reports the unchanged page again when recording starts (P12): first sync", async () => {
    mount(`<input name="a">`);
    const { h } = recordingHarness({ state: "on", count: 0 });
    start(h);
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2));
    const [first, second] = h.reports();
    expect(second!.controls).toEqual(first!.controls);
    // The status came first, then the page was filed again.
    const types = h.sent.map((m) => m.type);
    expect(types.indexOf("record-status")).toBeLessThan(
      types.lastIndexOf("scan-report"),
    );
    // Filled once only: the field id is not written again.
    expect(h.results()).toHaveLength(1);
  });

  it("reports the unchanged page again when a nudge starts the recording (P12)", async () => {
    mount(`<input name="a">`);
    const r = recordingHarness({ state: "off" });
    start(r.h);
    await vi.waitFor(() => expect(r.statuses()).toHaveLength(1));
    await settle();
    expect(r.h.reports()).toHaveLength(1);

    r.status.value = { state: "on", count: 0 };
    r.nudge();
    // Filed again after the status said `on` (the nudge's own report may come first).
    await vi.waitFor(() => {
      const types = r.h.sent.map((m) => m.type);
      expect(types.lastIndexOf("scan-report")).toBeGreaterThan(
        types.lastIndexOf("record-status"),
      );
    });
    await settle();

    // Already recording: a nudge updates the state and reports the page once more (as every nudge
    // does), nothing else.
    const before = r.h.reports().length;
    r.nudge();
    await vi.waitFor(() => expect(r.statuses()).toHaveLength(3));
    await settle();
    expect(r.h.reports()).toHaveLength(before + 1);
  });

  it("re-reads the recording state on a bfcache restore and starts it", async () => {
    mount(`<input name="a">`);
    const r = recordingHarness({ state: "off" });
    start(r.h);
    await vi.waitFor(() => expect(r.statuses()).toHaveLength(1));
    r.status.value = { state: "on", count: 0 };
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    await vi.waitFor(() => expect(r.statuses()).toHaveLength(2));
    await settle();
    // A restore reports the page anyway (ADR 0026); recording starts and the page is on file
    // before any capture.
    const types = r.h.sent.map((m) => m.type);
    expect(types.lastIndexOf("scan-report")).toBeGreaterThan(
      types.lastIndexOf("record-status"),
    );
    expect(document.querySelector("[popover]")?.matches(":popover-open")).toBe(
      true,
    );
  });

  it("rescan() resolves after the report it triggered was delivered", async () => {
    const root = mount(`<input name="a">`);
    let release: () => void = () => undefined;
    const h = harness(() => ({ state: "none" }));
    const send = h.env.send;
    let hold = false;
    h.env.send = vi.fn(async (msg: ContentRequest) => {
      const answer = await send(msg); // logged in `sent` now
      if (msg.type === "scan-report" && hold) {
        await new Promise<void>((r) => (release = r));
      }
      return answer;
    });
    const run = start(h)!;
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1));
    await sleep(10);
    const b = document.createElement("input");
    b.name = "b";
    root.append(b);
    hold = true;
    let done = false;
    const p = run.rescan().then((r) => {
      done = true;
      return r;
    });
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2));
    await sleep(20);
    expect(done).toBe(false);
    release();
    const result = await p;
    expect(result!.controls.map((c) => c.sig.name)).toEqual(["a", "b"]);
  });

  it("ignores a nudge after stop() and removes the pill", async () => {
    mount(`<input name="a">`);
    const r = recordingHarness({ state: "on", count: 2 });
    const run = start(r.h)!;
    await vi.waitFor(() =>
      expect(document.querySelector("[popover]")).not.toBeNull(),
    );
    run.stop();
    expect(document.querySelector("[popover]")).toBeNull();
    r.nudge();
    await sleep(20);
    expect(r.statuses()).toHaveLength(1);
  });
});

describe("return visit", () => {
  const last = (h: Harness) => h.notices.at(-1) ?? null;
  const shownOf = (kind: PillState["kind"]) =>
    (shown as PillState[]).filter((s) => s.kind === kind);

  /** The user's (trusted) click on the notice's button, at the bar's right end (the root is closed). */
  async function clickNoticeButton(): Promise<void> {
    const host = document.querySelector<HTMLElement>(":popover-open")!;
    const box = host.getBoundingClientRect();
    await userEvent.click(host, {
      position: { x: box.width - 24, y: box.height / 2 },
    });
  }

  it("a fill shows `filled` with the count and reports the document's total", async () => {
    mount(`<input name="a"><input name="b">`);
    const h = harness(byName({ a: "A", b: "B" }));
    start(h);
    await vi.waitFor(() => expect(h.results()).toHaveLength(1));
    expect(last(h)).toBe("filled");
    expect(shown).toEqual([{ kind: "filled", count: 2, ask: 0 }]);
    expect(h.results()[0]).toMatchObject({ filled: 2 });
  });

  it("the next SPA step's fill counts both steps", async () => {
    const root = mount(`<div id="step"><input name="a"><input name="b"></div>`);
    const h = harness(byName({ a: "A", b: "B", c: "C", d: "D" }));
    start(h);
    await vi.waitFor(() => expect(h.results()).toHaveLength(1));
    const c = document.createElement("input");
    c.name = "c";
    const d = document.createElement("input");
    d.name = "d";
    root.querySelector("#step")!.replaceChildren(c, d);
    await vi.waitFor(() => expect(h.results()).toHaveLength(2));
    expect(shown.at(-1)).toEqual({ kind: "filled", count: 4, ask: 0 });
    expect(h.results()[1]).toMatchObject({ filled: 4 });
  });

  it("Undo restores what Refill wrote, keeps the user's edit, and the ids stay filled", async () => {
    // Narrow inputs: all of them stay in the test frame's viewport (eligibility, ADR 0020).
    const root = mount(`<input name="a" size="4"><input name="b" size="4">`);
    const h = harness(byName({ a: "A", b: "B", c: "C", d: "D" }));
    start(h);
    await vi.waitFor(() => expect(h.results()).toHaveLength(1));
    root.insertAdjacentHTML(
      "beforeend",
      `<input name="c" size="4"><input name="d" size="4">`,
    );
    await vi.waitFor(() => expect(h.results()).toHaveLength(2));
    expect(shown.at(-1)).toEqual({ kind: "filled", count: 4, ask: 0 });

    input("b").value = "mine"; // the user's own edit after the fill
    await clickNoticeButton();
    await vi.waitFor(() => expect(last(h)).toBe("undone"));
    expect(["a", "b", "c", "d"].map((n) => input(n).value)).toEqual([
      "",
      "mine",
      "",
      "",
    ]);
    await vi.waitFor(() => expect(h.results()).toHaveLength(3));
    expect(h.results()[2]).toEqual({
      type: "fill-result",
      filled: 0,
      skipped: 0,
      unsupported: 0,
    });

    // The page changes and the plan names the same fields again: nothing is written.
    root.insertAdjacentHTML("beforeend", `<input name="e" size="4">`);
    await vi.waitFor(() => expect(h.reports()).toHaveLength(3));
    await sleep(20);
    expect(["a", "c", "d"].map((n) => input(n).value)).toEqual(["", "", ""]);
    expect(h.results()).toHaveLength(3);
    expect(last(h)).toBe("undone");
  });

  it("a gesture plan shows `ready` with the ids not yet filled, once per count", async () => {
    const root = mount(`<input name="a" size="4">`);
    let planner: Planner = () => ({
      state: "gesture",
      fieldIds: ["a", "b", "c"],
    });
    const h = harness((req) => planner(req));
    start(h);
    await vi.waitFor(() => expect(last(h)).toBe("ready"));
    expect(shownOf("ready")).toEqual([{ kind: "ready", count: 3 }]);

    // The same ids again: nothing new.
    root.insertAdjacentHTML("beforeend", `<input name="x1" size="4">`);
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2));
    await sleep(20);
    expect(shownOf("ready")).toHaveLength(1);

    // A fill of a and b (Fill now), then a page with a fourth field.
    planner = byName({ a: "A", b: "B" });
    root.insertAdjacentHTML("beforeend", `<input name="b" size="4">`);
    await vi.waitFor(() => expect(h.results()).toHaveLength(1));
    expect(h.results()[0]).toMatchObject({ filled: 2 });
    planner = () => ({ state: "gesture", fieldIds: ["a", "b", "c", "d"] });
    root.insertAdjacentHTML("beforeend", `<input name="x2" size="4">`);
    await vi.waitFor(() => expect(shownOf("ready")).toHaveLength(2));
    expect(shownOf("ready")[1]).toEqual({ kind: "ready", count: 2 });
    expect(last(h)).toBe("ready");
  });

  it("a step whose pending fields differ is announced even with the same count (Review Focus 2)", async () => {
    const root = mount(`<input name="a" size="4">`);
    let planner: Planner = () => ({ state: "gesture", fieldIds: ["a", "b"] });
    const h = harness((req) => planner(req));
    start(h);
    await vi.waitFor(() => expect(last(h)).toBe("ready"));
    expect(shownOf("ready")).toEqual([{ kind: "ready", count: 2 }]);

    // Fill now fills a and b; the next step has two new pending fields.
    planner = byName({ a: "A", b: "B" });
    root.insertAdjacentHTML("beforeend", `<input name="b" size="4">`);
    await vi.waitFor(() => expect(h.results()).toHaveLength(1));
    expect(h.results()[0]).toMatchObject({ filled: 2 });
    planner = () => ({ state: "gesture", fieldIds: ["a", "b", "c", "d"] });
    root.insertAdjacentHTML("beforeend", `<input name="x1" size="4">`);
    await vi.waitFor(() => expect(shownOf("ready")).toHaveLength(2));
    expect(shownOf("ready")[1]).toEqual({ kind: "ready", count: 2 });
    expect(last(h)).toBe("ready");
  });

  it("an SPA step with other unfilled ids and the same count is announced; the same ids are not", async () => {
    const root = mount(`<input name="a" size="4">`);
    let planner: Planner = () => ({ state: "gesture", fieldIds: ["a", "b"] });
    const h = harness((req) => planner(req));
    start(h);
    await vi.waitFor(() => expect(last(h)).toBe("ready"));

    // The next step: a and b (never filled) are gone, c and d wait.
    planner = () => ({ state: "gesture", fieldIds: ["c", "d"] });
    root.insertAdjacentHTML("beforeend", `<input name="x1" size="4">`);
    await vi.waitFor(() => expect(shownOf("ready")).toHaveLength(2));
    expect(shownOf("ready")[1]).toEqual({ kind: "ready", count: 2 });

    // The same ids again, in another order: not shown again.
    planner = () => ({ state: "gesture", fieldIds: ["d", "c", "c"] });
    root.insertAdjacentHTML("beforeend", `<input name="x2" size="4">`);
    await vi.waitFor(() => expect(h.reports()).toHaveLength(3));
    await sleep(20);
    expect(shownOf("ready")).toHaveLength(2);
  });

  it("a re-report after lock and unlock that fills nothing new still reports the running total", async () => {
    const root = mount(`<input name="a" size="4"><input name="b" size="4">`);
    const nudges: (() => void)[] = [];
    const h = harness(byName({ a: "A", b: "B" }), {
      onNudge: (cb) => {
        nudges.push(cb);
      },
    });
    start(h);
    await vi.waitFor(() => expect(h.results()).toHaveLength(1));
    expect(h.results()[0]).toMatchObject({ filled: 2 });

    // An ordinary page change that fills nothing new sends nothing (the badge still shows 2).
    root.insertAdjacentHTML("beforeend", `<input name="x" size="4">`);
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2));
    await sleep(20);
    expect(h.results()).toHaveLength(1);

    // The unlock pass clears the badge and nudges; the plan names a and b again.
    for (const cb of nudges) cb();
    await vi.waitFor(() => expect(h.results()).toHaveLength(2));
    expect(h.results()[1]).toEqual({
      type: "fill-result",
      filled: 2,
      skipped: 0,
      unsupported: 0,
    });

    // After Undo there is nothing to count: a re-report sends no fill-result.
    await clickNoticeButton();
    await vi.waitFor(() => expect(h.results()).toHaveLength(3));
    expect(h.results()[2]).toMatchObject({ filled: 0 });
    const reports = h.reports().length;
    for (const cb of nudges) cb();
    await vi.waitFor(() => expect(h.reports()).toHaveLength(reports + 1));
    await sleep(20);
    expect(h.results()).toHaveLength(3);
  });

  it("a lock during a recording keeps `Recording stopped`: no `locked` notice over it", async () => {
    const root = mount(`<input name="a" size="4">`);
    const nudges: (() => void)[] = [];
    let planner: Planner = byName({ a: "A" });
    const status = { value: { state: "on", count: 1 } as unknown };
    const h = harness((req) => planner(req), {
      onNudge: (cb) => {
        nudges.push(cb);
      },
    });
    const inner = h.env.send;
    h.env.send = vi.fn(async (msg: ContentRequest) => {
      if (msg.type !== "record-status") return inner(msg);
      h.sent.push(structuredClone(msg));
      return status.value;
    });
    start(h);
    await vi.waitFor(() => expect(last(h)).toBe("on"));

    // The vault locks: the session stops and the worker nudges the tab.
    status.value = { state: "stopped", reason: "locked" };
    planner = () => ({ state: "locked" });
    for (const cb of nudges) cb();
    await vi.waitFor(() => expect(last(h)).toBe("stopped"));
    await settle();
    // A later report of this document answers locked too.
    root.insertAdjacentHTML("beforeend", `<input name="b" size="4">`);
    await vi.waitFor(() => expect(h.reports().length).toBeGreaterThan(2));
    await settle();
    expect(shownOf("locked")).toEqual([]);
    expect(last(h)).toBe("stopped");
  });

  it("a recording that starts drops the return visit's Undo records and outlines", async () => {
    const root = mount(
      `<input name="a" size="4"><input name="b" size="4"><input name="q" size="4">`,
    );
    const nudges: (() => void)[] = [];
    const status = { value: { state: "off" } as unknown };
    const h = harness(
      (req) => ({
        ...(byName({ a: "A", b: "B", c: "C" })(req) as object),
        ask: req.controls.filter((c) => c.sig.name === "q").map((c) => c.i),
        recording: false,
      }),
      {
        onNudge: (cb) => {
          nudges.push(cb);
        },
      },
    );
    const inner = h.env.send;
    h.env.send = vi.fn(async (msg: ContentRequest) => {
      if (msg.type !== "record-status") return inner(msg);
      h.sent.push(structuredClone(msg));
      return status.value;
    });
    const outline = (n: string) => input(n).style.getPropertyValue("outline");
    start(h);
    await vi.waitFor(() => expect(last(h)).toBe("filled"));
    expect(shown.at(-1)).toEqual({ kind: "filled", count: 2, ask: 1 });
    expect(outline("q")).not.toBe("");

    // Record again starts in this document.
    status.value = { state: "on", count: 2 };
    for (const cb of nudges) cb();
    await vi.waitFor(() => expect(last(h)).toBe("on"));
    expect(outline("q")).toBe("");

    // It ends; a later fill in the document counts and undoes only its own write.
    status.value = { state: "off" };
    for (const cb of nudges) cb();
    await vi.waitFor(() => expect(last(h)).toBeNull());
    root.insertAdjacentHTML("beforeend", `<input name="c" size="4">`);
    await vi.waitFor(() => expect(input("c").value).toBe("C"));
    await vi.waitFor(() => expect(last(h)).toBe("filled"));
    expect(shown.at(-1)).toMatchObject({ kind: "filled", count: 1 });
    expect(h.results().at(-1)).toMatchObject({ filled: 1 });
    await clickNoticeButton();
    await vi.waitFor(() => expect(last(h)).toBe("undone"));
    expect(["a", "b", "c"].map((n) => input(n).value)).toEqual(["A", "B", ""]);
  });

  it("`locked` shows once; Unlock asks the worker and falls back to the text when it cannot open", async () => {
    const root = mount(`<input name="a">`);
    const unlockReply: unknown = { ok: false };
    const h = harness(() => ({ state: "locked" }), { isTrusted: () => true });
    const inner = h.env.send;
    h.env.send = vi.fn(async (msg: ContentRequest) => {
      const answer = await inner(msg);
      return msg.type === "toast-unlock-click" ? unlockReply : answer;
    });
    start(h);
    await vi.waitFor(() => expect(last(h)).toBe("locked"));
    expect(shown).toEqual([{ kind: "locked", fallback: false }]);

    // The same document again (a page change, a bfcache restore): not shown twice.
    root.insertAdjacentHTML("beforeend", `<input name="b">`);
    window.dispatchEvent(
      new PageTransitionEvent("pageshow", { persisted: true }),
    );
    await vi.waitFor(() => expect(h.reports().length).toBeGreaterThan(1));
    await settle();
    expect(shownOf("locked")).toHaveLength(1);

    await clickNoticeButton();
    await vi.waitFor(() =>
      expect(shown.at(-1)).toEqual({ kind: "locked", fallback: true }),
    );
    expect(h.sent.filter((m) => m.type === "toast-unlock-click")).toEqual([
      { type: "toast-unlock-click" },
    ]);
    expect(last(h)).toBe("locked");
  });

  it("Unlock hides the notice when the worker opened the popup", async () => {
    mount(`<input name="a">`);
    const h = harness(() => ({ state: "locked" }));
    start(h);
    await vi.waitFor(() => expect(last(h)).toBe("locked"));
    await clickNoticeButton();
    await vi.waitFor(() => expect(last(h)).toBeNull());
    expect(h.sent.some((m) => m.type === "toast-unlock-click")).toBe(true);
  });

  it("a page click on the notice sends nothing", async () => {
    mount(`<input name="a">`);
    const h = harness(() => ({ state: "locked" }));
    start(h);
    await vi.waitFor(() => expect(last(h)).toBe("locked"));
    document
      .querySelector<HTMLElement>(":popover-open")!
      .dispatchEvent(
        new MouseEvent("click", { bubbles: true, composed: true }),
      );
    await sleep(20);
    expect(h.sent.some((m) => m.type === "toast-unlock-click")).toBe(false);
  });

  it("`ask` outlines an empty control and counts it; the user's input releases it", async () => {
    mount(`<input name="a"><input name="q"><input name="r" value="typed">`);
    const h = harness((req) => {
      const at = (n: string) => req.controls.find((c) => c.sig.name === n)!.i;
      return {
        state: "fill",
        items: [
          {
            fieldId: "a",
            i: at("a"),
            kind: "text",
            value: "A",
            pageDefault: "",
          },
        ],
        ask: [at("q"), at("r")],
        recording: false,
      } satisfies FillPlan;
    });
    start(h);
    await vi.waitFor(() => expect(last(h)).toBe("filled"));
    expect(shown.at(-1)).toEqual({ kind: "filled", count: 1, ask: 1 });
    const outline = (n: string) => input(n).style.getPropertyValue("outline");
    expect(outline("q")).not.toBe("");
    expect(outline("r")).toBe(""); // not empty: the user has it
    expect(outline("a")).toBe("");

    // A page's synthetic input does not release it; the user's does.
    input("q").dispatchEvent(new Event("input", { bubbles: true }));
    expect(outline("q")).not.toBe("");
    await userEvent.type(input("q"), "x");
    expect(outline("q")).toBe("");
  });

  it("stop() takes the outlines off", async () => {
    mount(`<input name="q">`);
    const h = harness(() => ({
      state: "fill",
      items: [],
      ask: [0],
      recording: false,
    }));
    const run = start(h)!;
    await vi.waitFor(() =>
      expect(input("q").style.getPropertyValue("outline")).not.toBe(""),
    );
    run.stop();
    expect(input("q").style.getPropertyValue("outline")).toBe("");
  });

  it("while recording: no `filled` notice and no outline", async () => {
    mount(`<input name="a"><input name="q">`);
    const status = { value: { state: "on", count: 0 } as unknown };
    const h = harness((req) => ({
      ...(byName({ a: "A" })(req) as object),
      ask: [req.controls.find((c) => c.sig.name === "q")!.i],
      recording: true, // the worker answers from the session
    }));
    const inner = h.env.send;
    h.env.send = vi.fn(async (msg: ContentRequest) =>
      msg.type === "record-status" ? status.value : inner(msg),
    );
    start(h);
    await vi.waitFor(() => expect(last(h)).toBe("on"));
    expect(input("a").value).toBe("A");
    expect(shownOf("filled")).toEqual([]);
    expect(input("q").style.getPropertyValue("outline")).toBe("");

    // The step re-renders with a field more (a new page fingerprint): `a` is a new element and is
    // filled again (ruling P20), still with no notice and no outline.
    const before = shown.length;
    document.body.replaceChildren();
    mount(
      `<input name="a" size="4"><input name="q" size="4"><input name="z" size="4">`,
    );
    await vi.waitFor(() => expect(input("a").value).toBe("A"));
    await sleep(20);
    expect(shown.slice(before)).toEqual([]);
    expect(input("q").style.getPropertyValue("outline")).toBe("");
    expect(last(h)).toBe("on");
  });

  it("a fresh document's session plan, before record-status answers, is no return visit", async () => {
    const root = mount(`<input name="a" size="4"><input name="q" size="4">`);
    let session = true;
    const h = harness((req) => ({
      ...(byName({ a: "A", b: "B" })(req) as object),
      ask: [req.controls.find((c) => c.sig.name === "q")!.i],
      recording: session,
    }));
    const inner = h.env.send;
    // `record-status` never answers: only the plan's own flag says this is the session.
    h.env.send = vi.fn((msg: ContentRequest) =>
      msg.type === "record-status"
        ? new Promise<unknown>(() => undefined)
        : inner(msg),
    );
    start(h);
    await vi.waitFor(() => expect(h.results()).toHaveLength(1));
    expect(input("a").value).toBe("A");
    expect(h.notices.filter((k) => k !== null)).toEqual([]);
    expect(input("q").style.getPropertyValue("outline")).toBe("");
    expect(h.results()[0]).toMatchObject({ filled: 1 }); // that plan's count, as while recording

    // A stored-profile plan later in the document: only its own fill is counted and undone.
    session = false;
    root.insertAdjacentHTML("beforeend", `<input name="b" size="4">`);
    await vi.waitFor(() => expect(last(h)).toBe("filled"));
    expect(shown.at(-1)).toEqual({ kind: "filled", count: 1, ask: 1 });
    expect(h.results()[1]).toMatchObject({ filled: 1 });
    await clickNoticeButton();
    await vi.waitFor(() => expect(last(h)).toBe("undone"));
    expect(input("a").value).toBe("A"); // the session's value: no Undo record
    expect(input("b").value).toBe("");
  });

  it("an `ask` control the user dealt with is not outlined again in this document", async () => {
    mount(`<input name="q" size="4"><input type="checkbox" name="c">`);
    const nudges: (() => void)[] = [];
    const h = harness(
      (req) => ({
        state: "fill",
        items: [],
        ask: req.controls.map((c) => c.i),
        recording: false,
      }),
      {
        onNudge: (cb) => {
          nudges.push(cb);
        },
      },
    );
    start(h);
    const outline = (n: string) => input(n).style.getPropertyValue("outline");
    await vi.waitFor(() => expect(outline("c")).not.toBe(""));
    expect(outline("q")).not.toBe("");

    await userEvent.click(input("c"));
    await userEvent.type(input("q"), "x");
    await userEvent.clear(input("q")); // emptied again: still the user's business
    expect(outline("c")).toBe("");
    expect(outline("q")).toBe("");

    // A nudge reports the page again and the plan names both once more.
    const reports = h.reports().length;
    for (const cb of nudges) cb();
    await vi.waitFor(() => expect(h.reports()).toHaveLength(reports + 1));
    await sleep(20);
    expect(outline("c")).toBe("");
    expect(outline("q")).toBe("");
  });

  it("a recording `off` does not hide a `filled` notice", async () => {
    mount(`<input name="a">`);
    const nudges: (() => void)[] = [];
    const h = harness(byName({ a: "A" }), {
      onNudge: (cb) => {
        nudges.push(cb);
      },
    });
    const inner = h.env.send;
    h.env.send = vi.fn(async (msg: ContentRequest) => {
      if (msg.type !== "record-status") return inner(msg);
      h.sent.push(structuredClone(msg));
      return { state: "off" };
    });
    start(h);
    await vi.waitFor(() => expect(last(h)).toBe("filled"));
    for (const cb of nudges) cb();
    await vi.waitFor(() =>
      expect(h.sent.filter((m) => m.type === "record-status")).toHaveLength(2),
    );
    await settle();
    expect(last(h)).toBe("filled");
  });

  it("a nudge reports an unchanged page again", async () => {
    mount(`<input name="a">`);
    const nudges: (() => void)[] = [];
    const h = harness(() => ({ state: "none" }), {
      onNudge: (cb) => {
        nudges.push(cb);
      },
    });
    start(h);
    await vi.waitFor(() => expect(h.reports()).toHaveLength(1));
    await settle();
    for (const cb of nudges) cb();
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2));
    expect(h.reports()[1]!.controls).toEqual(h.reports()[0]!.controls);
  });

  it("the extension gone after a fill leaves `updated` showing and sends nothing more", async () => {
    const root = mount(`<input name="a">`);
    const h = harness(byName({ a: "A" }));
    const inner = h.env.send;
    let gone = false;
    let after = 0;
    h.env.send = vi.fn(async (msg: ContentRequest) => {
      if (gone) {
        after++;
        throw new Error("Extension context invalidated.");
      }
      return inner(msg);
    });
    start(h);
    await vi.waitFor(() => expect(last(h)).toBe("filled"));
    await sleep(20);
    gone = true;
    root.insertAdjacentHTML("beforeend", `<input name="b">`);
    await vi.waitFor(() => expect(last(h)).toBe("updated"));
    expect(after).toBe(1);
    expect(document.querySelector(":popover-open")).not.toBeNull();
    root.insertAdjacentHTML("beforeend", `<input name="c">`);
    await settle();
    expect(after).toBe(1);
    expect(last(h)).toBe("updated");
  });

  it("the extension gone on a page Refill never touched shows nothing", async () => {
    mount(`<input name="a">`);
    const h = harness();
    h.env.send = vi.fn(async () => {
      throw new Error("Extension context invalidated.");
    });
    start(h);
    await vi.waitFor(() => expect(h.env.send).toHaveBeenCalled());
    await sleep(20);
    expect(h.notices.filter((k) => k !== null)).toEqual([]);
    expect(document.querySelector("[popover]")).toBeNull();
  });
});
