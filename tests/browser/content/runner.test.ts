import { afterEach, describe, expect, it, vi } from "vitest";
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
  reports: () => Extract<ContentRequest, { type: "scan-report" }>[];
  results: () => Extract<ContentRequest, { type: "fill-result" }>[];
  env: ContentEnv;
}

function harness(
  plan: Planner = () => ({ state: "none" }),
  over: Partial<ContentEnv> = {},
): Harness {
  const sent: ContentRequest[] = [];
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
    ...over,
  };
  return {
    sent,
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
    return { state: "fill", items } satisfies FillPlan;
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

  it("sends nothing for a page without eligible controls", async () => {
    mount(`<p>No form here</p><input type="hidden" name="t">`);
    const h = harness();
    start(h);
    await settle();
    expect(h.sent).toEqual([]);
  });

  it("does nothing with a locked, none, gesture or malformed answer", async () => {
    for (const answer of [
      { state: "locked" },
      { state: "none" },
      { state: "gesture", count: 1 },
      { ok: false, error: "rejected" },
      { state: "fill", items: [{ fieldId: "name", i: 0 }] },
      { state: "fill", items: "nope" },
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
    }));
    start(h);
    await vi.waitFor(() => expect(h.results()).toHaveLength(1));
    expect(input("a").value).toBe("1");
    expect(input("b").value).toBe("");
    expect(h.results()[0]).toMatchObject({ filled: 1, skipped: 0 });
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
    expect(h.results()).toEqual([
      { type: "fill-result", filled: 1, skipped: 0, unsupported: 0 },
      { type: "fill-result", filled: 1, skipped: 0, unsupported: 0 },
    ]);
  });

  it("a bfcache restore reports again but does not fill again", async () => {
    mount(`<input name="a">`);
    const h = harness(byName({ a: "A" }));
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
    h.env.send = vi.fn(async () => {
      calls++;
      if (calls === 1) throw new Error("Could not establish connection.");
      return { state: "none" };
    });
    start(h);
    await vi.waitFor(() => expect(calls).toBe(1));
    const b = document.createElement("input");
    b.name = "b";
    root.append(b);
    await vi.waitFor(() => expect(calls).toBe(2));
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
