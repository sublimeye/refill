import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import {
  RESCAN_DEBOUNCE_MS,
  startContentScript,
  type ContentEnv,
  type ContentRun,
} from "../../../src/lib/content/runner";
import { CAPTURE_DEBOUNCE_MS } from "../../../src/lib/content/recording";
import { withFillingGuard } from "../../../src/lib/fill/fill";
import type {
  ContentRequest,
  FillItem,
  RecordState,
} from "../../../src/lib/messaging/content-protocol";

const top = () => true;
const ORIGIN = "https://bills.example";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** Long enough for a debounced input capture and its message. */
const afterDebounce = () => sleep(CAPTURE_DEBOUNCE_MS + 100);

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

type Capture = Extract<ContentRequest, { type: "record-capture" }>;
type Report = Extract<ContentRequest, { type: "scan-report" }>;

interface Harness {
  sent: ContentRequest[];
  captures: () => Capture[];
  reports: () => Report[];
  env: ContentEnv;
  /** Changes what `record-status` answers. */
  status: { value: RecordState };
  /** Delivers a worker nudge. */
  nudge(): void;
}

/**
 * A fake worker: `record-status` answers `status.value`, a capture answers `on` with one more
 * field, a scan-report replays `plan` (field id = the control's name).
 */
function harness(
  plan: Record<string, string> = {},
  over: Partial<ContentEnv> = {},
): Harness {
  const sent: ContentRequest[] = [];
  const status: { value: RecordState } = { value: { state: "on", count: 0 } };
  let count = 0;
  const nudges: (() => void)[] = [];
  const env: ContentEnv = {
    onNudge: (cb) => {
      nudges.push(cb);
    },
    win: window,
    doc: document,
    origin: ORIGIN,
    send: vi.fn(async (msg: ContentRequest) => {
      sent.push(structuredClone(msg));
      switch (msg.type) {
        case "record-status":
          return status.value;
        case "record-capture":
          count++;
          return { state: "on", count };
        case "record-finish":
          return { ok: true };
        case "scan-report": {
          const items: FillItem[] = [];
          for (const c of msg.controls) {
            const name = c.sig.name;
            if (name === null || !Object.hasOwn(plan, name)) continue;
            items.push({
              fieldId: name,
              i: c.i,
              kind: c.kind,
              value: plan[name]!,
              pageDefault:
                c.kind === "checkbox" || c.kind === "radio" ? "false" : "",
            });
          }
          return { state: "fill", items };
        }
        default:
          return { ok: true };
      }
    }),
    alive: () => true,
    isTopWindow: top,
    // Synthetic events stand in for the user's; the trusted path itself has its own test.
    isTrusted: () => true,
    ...over,
  };
  return {
    sent,
    env,
    status,
    nudge: () => {
      for (const cb of nudges) cb();
    },
    captures: () =>
      sent.filter((m): m is Capture => m.type === "record-capture"),
    reports: () => sent.filter((m): m is Report => m.type === "scan-report"),
  };
}

function start(h: Harness): ContentRun {
  const run = startContentScript({}, h.env)!;
  runs.push(run);
  return run;
}

/** Waits for the start: first scan reported, status asked, and the P12 report sent. */
async function started(h: Harness): Promise<void> {
  await vi.waitFor(() => {
    expect(h.sent.some((m) => m.type === "record-status")).toBe(true);
    expect(h.reports().length).toBeGreaterThanOrEqual(2);
  });
  await sleep(10);
}

const input = (name: string, root: ParentNode = document) =>
  root.querySelector<HTMLInputElement>(`[name="${name}"]`)!;

/** What a user's edit looks like to the content script (the harness treats every event as trusted). */
function type(
  el: HTMLInputElement,
  value: string,
  ev: "input" | "change" = "change",
): void {
  el.value = value;
  el.dispatchEvent(new Event(ev, { bubbles: true, composed: ev === "input" }));
}

function toggle(el: HTMLInputElement): void {
  el.checked = !el.checked;
  el.dispatchEvent(new Event("change", { bubbles: true }));
}

describe("values", () => {
  it("captures a typed value with its page default", async () => {
    mount(`<form><label>City <input name="city" value="Paris"></label></form>`);
    const h = harness();
    start(h);
    await started(h);
    type(input("city"), "Lyon");
    await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
    const [c] = h.captures();
    expect(c).toMatchObject({
      type: "record-capture",
      kind: "text",
      value: "Lyon",
      pageDefault: "Paris",
      fieldId: null,
    });
    expect(c!.sig.name).toBe("city");
  });

  it("a revert sends the page default as the value", async () => {
    mount(`<input name="city" value="Paris">`);
    const h = harness();
    start(h);
    await started(h);
    type(input("city"), "Lyon");
    type(input("city"), "Paris");
    await vi.waitFor(() => expect(h.captures()).toHaveLength(2));
    expect(h.captures()[1]).toMatchObject({
      value: "Paris",
      pageDefault: "Paris",
    });
  });

  it("captures a checkbox as true / false", async () => {
    mount(`<label><input type="checkbox" name="agree"> Agree</label>`);
    const h = harness();
    start(h);
    await started(h);
    toggle(input("agree"));
    toggle(input("agree"));
    await vi.waitFor(() => expect(h.captures()).toHaveLength(2));
    expect(h.captures().map((c) => [c.kind, c.value, c.pageDefault])).toEqual([
      ["checkbox", "true", "false"],
      ["checkbox", "false", "false"],
    ]);
  });

  it("captures a card number", async () => {
    mount(
      `<label>Card number <input name="cardnumber" autocomplete="cc-number"></label>`,
    );
    const h = harness();
    start(h);
    await started(h);
    type(input("cardnumber"), "4111111111111111");
    await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
    expect(h.captures()[0]!.value).toBe("4111111111111111");
  });

  it("sends a value over 4096 characters as a revert, so no shorter prefix stays saved", async () => {
    mount(`<input name="note" value="page">`);
    const h = harness();
    start(h);
    await started(h);
    type(input("note"), "x".repeat(4096)); // at the limit: sent as typed
    type(input("note"), "x".repeat(4097)); // past it: the field goes back to the page default
    await vi.waitFor(() => expect(h.captures()).toHaveLength(2));
    expect(h.captures()[0]!.value).toHaveLength(4096);
    expect(h.captures()[1]).toMatchObject({
      value: "page",
      pageDefault: "page",
    });
    expect(h.captures()[1]!.sig).toEqual(h.captures()[0]!.sig);
  });

  it("sends nothing when the page default itself is over 4096 characters", async () => {
    const long = "p".repeat(4097);
    mount(`<input name="note" value="${long}"><input name="city">`);
    const h = harness();
    start(h);
    await started(h);
    type(input("note"), "short");
    type(input("city"), "Lyon");
    await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
    await sleep(20);
    expect(h.captures().map((c) => c.sig.name)).toEqual(["city"]);
  });

  it("captures the user's real typing (trusted events, default check)", async () => {
    mount(`<label>City <input name="city"></label>`);
    const h = harness();
    delete (h.env as { isTrusted?: unknown }).isTrusted;
    start(h);
    await started(h);
    await userEvent.type(input("city"), "Nice");
    await vi.waitFor(() => expect(h.captures()).toHaveLength(1), {
      timeout: 2000,
    });
    expect(h.captures()[0]!.value).toBe("Nice");
  });
});

describe("ignored", () => {
  it("ignores an untrusted event", async () => {
    mount(`<input name="city">`);
    const h = harness();
    delete (h.env as { isTrusted?: unknown }).isTrusted;
    start(h);
    await started(h);
    type(input("city"), "Lyon"); // synthetic: isTrusted false
    type(input("city"), "Lyon", "input");
    await afterDebounce();
    expect(h.captures()).toEqual([]);
  });

  it("ignores edits made inside withFillingGuard", async () => {
    mount(`<input name="city">`);
    const h = harness();
    start(h);
    await started(h);
    withFillingGuard(() => {
      type(input("city"), "Lyon");
      type(input("city"), "Lyon", "input");
    });
    await afterDebounce();
    expect(h.captures()).toEqual([]);
  });

  it("never sends secrets or fields that are never typed", async () => {
    const root = mount(
      `<input type="password" name="pw">` +
        `<input type="password" name="shown">` +
        `<input type="hidden" name="h">` +
        `<input name="masked" style="-webkit-text-security: disc">` +
        `<label>CVV <input name="cvv"></label>` +
        `<input name="otc" autocomplete="one-time-code">` +
        `<input name="ok">`,
    );
    const h = harness();
    start(h);
    await started(h);
    // Show-password toggle: the field is text now, but it was a password in this document.
    input("shown", root).type = "text";
    for (const name of ["pw", "shown", "masked", "cvv", "otc"]) {
      type(input(name, root), "secret-" + name);
      type(input(name, root), "secret-" + name, "input");
    }
    const hidden = input("h", root);
    hidden.value = "secret-h";
    hidden.dispatchEvent(new Event("change", { bubbles: true }));
    type(input("ok", root), "fine");
    await afterDebounce();
    expect(h.captures().map((c) => c.sig.name)).toEqual(["ok"]);
    expect(JSON.stringify(h.sent)).not.toContain("secret-");
  });

  it("re-checks the rules at event time, not from the scan", async () => {
    mount(`<input name="later"><input name="ok">`);
    const h = harness();
    start(h);
    await started(h);
    // Scanned as an ordinary field; becomes a one-time code field before the edit.
    input("later").setAttribute("autocomplete", "one-time-code");
    type(input("later"), "123456");
    type(input("ok"), "fine");
    await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
    await sleep(50);
    expect(h.captures().map((c) => c.sig.name)).toEqual(["ok"]);
  });

  it("re-checks at event time even when the signature did not change", async () => {
    mount(`<input name="flip"><input name="masked"><input name="ok">`);
    const h = harness();
    start(h);
    await started(h);
    // Scanned as ordinary fields. Since then: a password and back (same signature, but a password
    // once in this document), and masked text (not part of the signature at all).
    const flip = input("flip");
    flip.type = "password";
    flip.type = "text";
    input("masked").style.setProperty("-webkit-text-security", "disc");
    type(flip, "hunter2");
    type(input("masked"), "s3cret");
    type(input("ok"), "fine");
    await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
    await sleep(50);
    expect(h.captures().map((c) => c.sig.name)).toEqual(["ok"]);
  });
});

describe("in-recording fill", () => {
  it("fills an empty control whose field is in the plan", async () => {
    mount(`<input name="city"><input name="zip">`);
    const h = harness({ city: "Lyon" });
    start(h);
    await started(h);
    expect(input("city").value).toBe("Lyon");
    expect(input("zip").value).toBe("");
  });

  it("does not refill a control the user edited, even when cleared (Review Focus 1)", async () => {
    // The page pre-renders a value, so the first plan skips the field (not empty).
    const root = mount(
      `<input name="city" value="Paris"><div id="more"></div>`,
    );
    const h = harness({ city: "Lyon" });
    start(h);
    await started(h);
    expect(input("city").value).toBe("Paris");
    type(input("city"), "");
    await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
    // A new field appears: the re-scan reports, and the plan names city again.
    const before = h.reports().length;
    const extra = document.createElement("input");
    extra.name = "zip";
    root.querySelector("#more")!.append(extra);
    await vi.waitFor(() => expect(h.reports().length).toBe(before + 1), {
      timeout: RESCAN_DEBOUNCE_MS + 1500,
    });
    await sleep(20);
    expect(input("city").value).toBe("");
  });

  it("fills an untouched control on a re-scan (control for the test above)", async () => {
    const root = mount(
      `<input name="city" value="Paris"><div id="more"></div>`,
    );
    const h = harness({ city: "Lyon" });
    start(h);
    await started(h);
    input("city").value = ""; // the page clears it, not the user
    const before = h.reports().length;
    const extra = document.createElement("input");
    extra.name = "zip";
    root.querySelector("#more")!.append(extra);
    await vi.waitFor(() => expect(h.reports().length).toBe(before + 1), {
      timeout: RESCAN_DEBOUNCE_MS + 1500,
    });
    await vi.waitFor(() => expect(input("city").value).toBe("Lyon"));
  });

  it("a capture on a Refill-filled element carries its field id (Review Focus 5)", async () => {
    mount(`<input name="city"><input name="zip">`);
    const h = harness({ city: "Lyon" });
    start(h);
    await started(h);
    expect(input("city").value).toBe("Lyon");
    type(input("city"), "Nice");
    type(input("zip"), "75001");
    await vi.waitFor(() => expect(h.captures()).toHaveLength(2));
    expect(h.captures().map((c) => [c.sig.name, c.fieldId])).toEqual([
      ["city", "city"],
      ["zip", null],
    ]);
  });

  it("a capture on a filled element the page re-used for another field carries no field id", async () => {
    mount(`<label><span id="l">City</span> <input name="city"></label>`);
    const h = harness({ city: "Lyon" });
    start(h);
    await started(h);
    expect(input("city").value).toBe("Lyon");
    // An SPA wizard re-uses the input for the next step's field.
    const el = input("city");
    el.name = "iban";
    document.querySelector("#l")!.textContent = "IBAN";
    type(el, "FR76");
    await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
    expect(h.captures()[0]!.sig.name).toBe("iban");
    expect(h.captures()[0]!.fieldId).toBeNull();
  });

  it("an element the user edited and the page re-used for another field is filled for that field (P13)", async () => {
    const root = mount(
      `<label><span id="l">City</span> <input name="city"></label><div id="more"></div>`,
    );
    const h = harness({ iban: "FR76" });
    start(h);
    await started(h);
    type(input("city"), "Lyon");
    await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
    // Step 2 re-uses the input: renamed, relabelled and cleared by the framework.
    const el = input("city");
    el.name = "iban";
    document.querySelector("#l")!.textContent = "IBAN";
    el.value = "";
    root.querySelector("#more")!.append(document.createElement("span"));
    await vi.waitFor(() => expect(el.value).toBe("FR76"), {
      timeout: RESCAN_DEBOUNCE_MS + 1500,
    });
  });

  it("an element the page re-used gets the page default of its new meaning (P13)", async () => {
    mount(
      `<label><span id="l">City</span> <input name="city" value="Paris"></label>`,
    );
    const h = harness();
    start(h);
    await started(h);
    type(input("city"), "Lyon");
    await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
    expect(h.captures()[0]!.pageDefault).toBe("Paris");
    const el = input("city");
    el.name = "zip";
    document.querySelector("#l")!.textContent = "Zip";
    el.value = "75000"; // what the page renders for step 2
    const before = h.reports().length;
    await vi.waitFor(() => expect(h.reports().length).toBe(before + 1), {
      timeout: RESCAN_DEBOUNCE_MS + 1500,
    });
    type(el, "75001");
    await vi.waitFor(() => expect(h.captures()).toHaveLength(2));
    expect(h.captures()[1]).toMatchObject({
      value: "75001",
      pageDefault: "75000",
    });
    expect(h.captures()[1]!.sig.name).toBe("zip");
  });

  it("a filled value produces no capture", async () => {
    mount(
      `<input name="city"><label><input type="checkbox" name="agree"> A</label>`,
    );
    const h = harness({ city: "Lyon", agree: "true" });
    start(h);
    await started(h);
    expect(input("city").value).toBe("Lyon");
    expect(input("agree").checked).toBe(true);
    await afterDebounce();
    expect(h.captures()).toEqual([]);
  });
});

describe("shadow roots and ordering", () => {
  it("captures a change inside an open shadow root", async () => {
    const host = mount(`<div id="h"></div>`).querySelector("#h")!;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<label>City <input name="city"></label>`; // test-only markup
    const h = harness();
    start(h);
    await started(h);
    type(input("city", shadow), "Lyon");
    await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
    expect(h.captures()[0]).toMatchObject({ value: "Lyon" });
    expect(h.captures()[0]!.sig.name).toBe("city");
  });

  it("captures in a closed shadow root the runner can read", async () => {
    const host = mount(`<div id="h"></div>`).querySelector("#h")!;
    const shadow = host.attachShadow({ mode: "closed" });
    shadow.innerHTML = `<input name="city">`; // test-only markup
    const h = harness(
      {},
      {
        openOrClosedShadowRoot: (el) => (el === host ? shadow : el.shadowRoot),
      },
    );
    start(h);
    await started(h);
    type(input("city", shadow), "Lyon", "input");
    type(input("city", shadow), "Lyon");
    await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
    await afterDebounce();
    expect(h.captures()).toHaveLength(1);
    expect(h.captures()[0]!.sig.name).toBe("city");
  });

  it("a capture on a control added after the last scan follows its scan-report", async () => {
    const root = mount(`<input name="city">`);
    const h = harness();
    start(h);
    await started(h);
    const zip = document.createElement("input");
    zip.name = "zip";
    root.append(zip);
    type(zip, "75001"); // before the debounced re-scan
    await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
    const at = h.sent.findIndex((m) => m.type === "record-capture");
    const reportBefore = h.sent
      .slice(0, at)
      .filter((m): m is Report => m.type === "scan-report")
      .at(-1)!;
    expect(reportBefore.controls.map((c) => c.sig.name)).toEqual([
      "city",
      "zip",
    ]);
  });

  it("a capture on an element re-used for another field follows the new report", async () => {
    mount(`<label><span id="l">City</span> <input name="city"></label>`);
    const h = harness();
    start(h);
    await started(h);
    const el = input("city");
    el.name = "iban";
    document.querySelector("#l")!.textContent = "IBAN";
    type(el, "FR76");
    await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
    expect(h.captures()[0]!.sig.name).toBe("iban");
    const at = h.sent.findIndex((m) => m.type === "record-capture");
    const last = h.sent
      .slice(0, at)
      .filter((m): m is Report => m.type === "scan-report")
      .at(-1)!;
    expect(last.controls.map((c) => c.sig.name)).toEqual(["iban"]);
  });

  it("debounces input per element and a change sends at once, replacing the pending send", async () => {
    mount(`<input name="a"><input name="b">`);
    const h = harness();
    start(h);
    await started(h);
    type(input("a"), "1", "input");
    type(input("a"), "12", "input");
    type(input("b"), "x", "input");
    await sleep(CAPTURE_DEBOUNCE_MS / 2);
    expect(h.captures()).toEqual([]);
    type(input("a"), "123", "input");
    type(input("a"), "123", "change");
    await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
    expect(h.captures()[0]).toMatchObject({ value: "123" });
    await afterDebounce();
    // b once, after its quiet period; a's pending input was replaced by the change.
    expect(h.captures().map((c) => [c.sig.name, c.value])).toEqual([
      ["a", "123"],
      ["b", "x"],
    ]);
  });

  it("no capture overtakes the report that starts the recording (P12)", async () => {
    mount(`<input name="a">`);
    const h = harness();
    const send = h.env.send;
    let release: () => void = () => undefined;
    let reports = 0;
    h.env.send = vi.fn(async (msg: ContentRequest) => {
      const answer = await send(msg); // logged in `sent` now
      if (msg.type === "scan-report" && ++reports === 2) {
        await new Promise<void>((r) => (release = r)); // the P12 report, held
      }
      return answer;
    });
    start(h);
    await vi.waitFor(() => expect(h.reports()).toHaveLength(2));
    type(input("a"), "typed"); // listeners are live; the worker has not answered the report yet
    await sleep(50);
    expect(h.captures()).toEqual([]);
    release();
    await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
    expect(h.captures()[0]!.value).toBe("typed");
  });

  it("pagehide flushes pending edits", async () => {
    mount(`<input name="a">`);
    const h = harness();
    start(h);
    await started(h);
    type(input("a"), "typed", "input");
    window.dispatchEvent(new PageTransitionEvent("pagehide"));
    await vi.waitFor(() => expect(h.captures()).toHaveLength(1), {
      timeout: CAPTURE_DEBOUNCE_MS / 2,
    });
  });
});

describe("state", () => {
  it("Finish on the pill sends pending edits first, then finishes and hides the pill", async () => {
    mount(`<input name="a">`);
    const h = harness();
    start(h);
    await started(h);
    type(input("a"), "typed", "input"); // still in its quiet period
    const host = document.querySelector<HTMLElement>("[popover]")!;
    const box = host.getBoundingClientRect();
    // The user's click on Finish, the button at the pill's right end (the root is closed).
    await userEvent.click(host, {
      position: { x: box.width - 24, y: box.height / 2 },
    });
    await vi.waitFor(() =>
      expect(h.sent.some((m) => m.type === "record-finish")).toBe(true),
    );
    const types = h.sent.map((m) => m.type);
    expect(types.indexOf("record-capture")).toBeGreaterThan(-1);
    expect(types.indexOf("record-capture")).toBeLessThan(
      types.indexOf("record-finish"),
    );
    await vi.waitFor(() => expect(host.isConnected).toBe(false));
    // Off now: further edits are not captured.
    type(input("a"), "after");
    await afterDebounce();
    expect(h.captures()).toHaveLength(1);
  });

  it("captures nothing and shows no pill while off", async () => {
    mount(`<input name="a">`);
    const h = harness();
    h.status.value = { state: "off" };
    start(h);
    await vi.waitFor(() =>
      expect(h.sent.some((m) => m.type === "record-status")).toBe(true),
    );
    await sleep(20);
    type(input("a"), "x");
    await afterDebounce();
    expect(h.captures()).toEqual([]);
    expect(document.querySelector("[popover]")).toBeNull();
  });

  it("shows the pill while on, stops capturing on `stopped` and shows that notice once", async () => {
    mount(`<input name="a"><input name="b">`);
    const h = harness();
    start(h);
    await started(h);
    const host = document.querySelector<HTMLElement>("[popover]")!;
    expect(host.matches(":popover-open")).toBe(true);
    type(input("a"), "x");
    await vi.waitFor(() => expect(h.captures()).toHaveLength(1));
    // The vault locks; the worker nudges the tab.
    h.status.value = { state: "stopped", reason: "locked" };
    h.nudge();
    await vi.waitFor(() =>
      expect(h.sent.filter((m) => m.type === "record-status")).toHaveLength(2),
    );
    await sleep(10);
    type(input("b"), "y");
    await afterDebounce();
    expect(h.captures()).toHaveLength(1);
    expect(host.matches(":popover-open")).toBe(true); // the stopped notice
    // The worker answers `stopped` for a while: the notice is not shown again in this document.
    h.nudge();
    await vi.waitFor(() =>
      expect(h.sent.filter((m) => m.type === "record-status")).toHaveLength(3),
    );
    await sleep(10);
    expect(host.isConnected).toBe(false);
  });
});
