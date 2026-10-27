import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_CONTROLS,
  MAX_NODE_VISITS,
  pageFingerprint,
  scanDocument,
} from "../../../src/lib/fields/scan";
import { PasswordHistory } from "../../../src/lib/fields/sensitive";
import { sigKey } from "../../../src/lib/match/match";

// Vitest browser mode runs tests inside an iframe, so the top-frame rule is stubbed here and
// exercised for real by the last test.
const top = () => true;
const histories: PasswordHistory[] = [];
function history(): PasswordHistory {
  const h = new PasswordHistory();
  h.observe(document);
  histories.push(h);
  return h;
}
const scan = (
  h: PasswordHistory = history(),
  getRoot?: (el: Element) => ShadowRoot | null,
) => scanDocument(document, h, getRoot, top);

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html; // test-only fixture markup
  document.body.append(root);
  return root;
}

const names = (r: { controls: { el: Element }[] }) =>
  r.controls.map((c) => c.el.getAttribute("name"));

afterEach(() => {
  for (const h of histories.splice(0)) h.disconnect();
  document.body.replaceChildren();
});

describe("scanDocument ordering and ordinals", () => {
  it("returns eligible controls in document order with running indexes", () => {
    mount(
      `<input name="a"><select name="b"><option>x</option></select>` +
        `<textarea name="c"></textarea><input type="checkbox" name="d">`,
    );
    const r = scan();
    expect(names(r)).toEqual(["a", "b", "c", "d"]);
    expect(r.controls.map((c) => c.i)).toEqual([0, 1, 2, 3]);
    expect(r.controls.map((c) => c.kind)).toEqual([
      "text",
      "select",
      "text",
      "checkbox",
    ]);
    expect(r.truncated).toBe(false);
  });

  it("ordinal counts kept controls per form, and per document when formless", () => {
    mount(
      `<input name="loose0">` +
        `<form id="f1"><input name="f1a"><input name="f1b"></form>` +
        `<input name="loose1">` +
        `<form id="f2"><input name="f2a"></form>`,
    );
    const r = scan();
    expect(names(r)).toEqual(["loose0", "f1a", "f1b", "loose1", "f2a"]);
    expect(r.controls.map((c) => c.sig.ordinal)).toEqual([0, 0, 1, 1, 0]);
  });

  it("uses the form owner, so a form= attribute joins a control to a distant form", () => {
    mount(
      `<form id="f1" action="/one"><input name="in1"></form>` +
        `<input name="far" form="f1">`,
    );
    const r = scan();
    const far = r.controls.find((c) => c.el.getAttribute("name") === "far");
    expect(far?.sig.ordinal).toBe(1);
    expect(far?.sig.formAction).toBe("/one");
  });

  it("skipped controls do not take an ordinal", () => {
    mount(
      `<form><input name="a"><input name="otp_code">` +
        `<input name="hid" style="display:none"><input name="b"></form>`,
    );
    const r = scan();
    expect(names(r)).toEqual(["a", "b"]);
    expect(r.controls.map((c) => c.sig.ordinal)).toEqual([0, 1]);
  });

  it("radio groups contribute one entry per radio", () => {
    mount(
      `<form><input type="radio" name="g" value="1"><input type="radio" name="g" value="2">` +
        `<input type="radio" name="g" value="3"></form>`,
    );
    const r = scan();
    expect(r.controls).toHaveLength(3);
    expect(r.controls.map((c) => c.kind)).toEqual(["radio", "radio", "radio"]);
    expect(r.controls.map((c) => c.sig.ordinal)).toEqual([0, 1, 2]);
  });
});

describe("scanDocument exclusions", () => {
  it("drops ineligible and sensitive controls", () => {
    mount(
      `<input name="ok">` +
        `<input type="password" name="pw">` +
        `<input type="hidden" name="hid">` +
        `<input type="submit" name="sub">` +
        `<input name="dis" disabled>` +
        `<input name="ro" readonly>` +
        `<input name="gone" style="display:none">` +
        `<input name="otp_code">` +
        `<input name="x" autocomplete="cc-number">`,
    );
    expect(names(scan())).toEqual(["ok"]);
  });

  it("a password turned into text before the scan stays excluded", async () => {
    const r = mount(`<input id="p" name="p" type="password"><input name="q">`);
    const h = history();
    (r.querySelector("#p") as HTMLInputElement).type = "text";
    await Promise.resolve();
    expect(names(scan(h))).toEqual(["q"]);
  });
});

describe("scanDocument shadow roots", () => {
  function host(mode: "open" | "closed", html: string) {
    const el = document.createElement("div");
    document.body.append(el);
    const root = el.attachShadow({ mode });
    root.innerHTML = html; // test-only fixture markup
    return { el, root };
  }

  it("includes open shadow roots in document order, before the host's later siblings", () => {
    mount(`<input name="before">`);
    host("open", `<input name="inside">`);
    mount(`<input name="after">`);
    expect(names(scan())).toEqual(["before", "inside", "after"]);
  });

  it("descends into nested open shadow roots", () => {
    const outer = host("open", `<input name="o1">`);
    const inner = document.createElement("div");
    outer.root.append(inner);
    inner.attachShadow({ mode: "open" }).innerHTML = `<input name="deep">`; // test-only
    outer.root.append(Object.assign(document.createElement("input"), {}));
    outer.root.lastElementChild?.setAttribute("name", "o2");
    expect(names(scan())).toEqual(["o1", "deep", "o2"]);
  });

  it("ignores a closed shadow root without the callback and enters it with one", () => {
    const { el, root } = host("closed", `<input name="secret">`);
    expect(names(scan())).toEqual([]);
    const getRoot = (e: Element) => (e === el ? root : null);
    expect(names(scan(history(), getRoot))).toEqual(["secret"]);
  });

  it("ordinals for formless shadow controls continue the document count", () => {
    mount(`<input name="a">`);
    host("open", `<input name="b">`);
    expect(scan().controls.map((c) => c.sig.ordinal)).toEqual([0, 1]);
  });

  it("observes entered shadow roots without dropping the document observer", async () => {
    const h = history();
    const { root } = host("open", `<input id="s" name="s" type="password">`);
    const light = mount(`<input id="l" name="l" type="password">`);
    expect(names(scan(h))).toEqual([]);
    (root.querySelector("#s") as HTMLInputElement).type = "text";
    (light.querySelector("#l") as HTMLInputElement).type = "text";
    await Promise.resolve();
    expect(names(scan(h))).toEqual([]);
  });

  it("a throwing shadow-root callback skips that host only", () => {
    host("open", `<input name="inside">`);
    mount(`<input name="light">`);
    const getRoot = () => {
      throw new Error("boom");
    };
    expect(names(scan(history(), getRoot))).toContain("light");
  });
});

describe("scanDocument formAction", () => {
  const actions = () => scan().controls.map((c) => c.sig.formAction);

  it("is null for formless controls", () => {
    mount(`<input name="a">`);
    expect(actions()).toEqual([null]);
  });

  it("is the resolved pathname of an explicit action", () => {
    mount(
      `<form action="/login?x=1#h"><input name="a"></form>` +
        `<form action="https://other.example/pay/go"><input name="b"></form>` +
        `<form action="rel/path"><input name="c"></form>`,
    );
    const here = new URL("rel/path", document.baseURI).pathname;
    expect(actions()).toEqual(["/login", "/pay/go", here]);
  });

  it("an empty action attribute resolves to the document", () => {
    mount(`<form action=""><input name="a"></form>`);
    expect(actions()).toEqual([location.pathname]);
  });

  it("a form without an action attribute uses the current document pathname", () => {
    mount(`<form><input name="a"></form>`);
    expect(actions()).toEqual([location.pathname]);
  });

  it("caps a long action at 256 characters", () => {
    mount(`<form action="/${"a".repeat(400)}"><input name="a"></form>`);
    expect(actions()[0]).toHaveLength(256);
  });

  it("an unparsable action yields null instead of throwing", () => {
    mount(`<form action="http://[bad"><input name="a"></form>`);
    expect(actions()).toEqual([null]);
  });

  it("a control named action cannot replace the form's action", () => {
    mount(`<form action="/real"><input name="action"><input name="b"></form>`);
    expect(actions()).toEqual(["/real", "/real"]);
  });
});

describe("scanDocument limits", () => {
  it("stops at 300 kept controls and flags truncation", () => {
    mount(`<form>${'<input name="n">'.repeat(2000)}</form>`);
    const r = scan();
    expect(MAX_CONTROLS).toBe(300);
    expect(r.controls).toHaveLength(300);
    expect(r.controls.at(-1)?.i).toBe(299);
    expect(r.truncated).toBe(true);
  });

  it("exactly 300 controls is not truncated", () => {
    mount(`<form>${'<input name="n">'.repeat(300)}</form>`);
    const r = scan();
    expect(r.controls).toHaveLength(300);
    expect(r.truncated).toBe(false);
  });

  it("builds no signature (and runs no eligibility check) for controls past the cap", () => {
    const root = mount(`<form>${'<input name="n">'.repeat(305)}</form>`);
    let reads = 0;
    const extra = [...root.querySelectorAll("input")].slice(300);
    for (const el of extra) {
      Object.defineProperty(el, "id", {
        get() {
          reads++;
          return "";
        },
      });
    }
    const r = scan();
    expect(r.controls).toHaveLength(300);
    expect(reads).toBe(0);
  });

  it("skipped controls do not count towards the cap", () => {
    mount(
      `<form>${'<input type="password">'.repeat(400)}${'<input name="n">'.repeat(10)}</form>`,
    );
    const r = scan();
    expect(r.controls).toHaveLength(10);
    expect(r.truncated).toBe(false);
  });

  it("2 000 inputs scan in under 50 ms (median of 5)", () => {
    mount(
      `<form>${'<input name="n" autocomplete="email">'.repeat(2000)}</form>`,
    );
    const times: number[] = [];
    for (let i = 0; i < 5; i++) {
      const h = history();
      const t0 = performance.now();
      const r = scan(h);
      times.push(performance.now() - t0);
      expect(r.controls).toHaveLength(300);
      expect(r.truncated).toBe(true);
    }
    times.sort((a, b) => a - b);
    const median = times[2] ?? Infinity;
    expect(median).toBeLessThan(50);
  });

  it("gives up after a bounded number of node visits and flags truncation", () => {
    const filler = document.createElement("div");
    filler.append(
      ...Array.from({ length: MAX_NODE_VISITS + 10 }, () =>
        document.createElement("span"),
      ),
    );
    document.body.append(filler);
    mount(`<input name="late">`);
    const r = scan();
    expect(r.truncated).toBe(true);
    expect(r.controls).toHaveLength(0);
  });

  it("a deep chain does not recurse", () => {
    let node: HTMLElement = document.createElement("div");
    document.body.append(node);
    for (let i = 0; i < 20000; i++) {
      const child = document.createElement("div");
      node.append(child);
      node = child;
    }
    node.append(
      Object.assign(document.createElement("input"), { name: "bottom" }),
    );
    // The deep input is likely ineligible (ancestor-walk cap); the point is: no stack overflow, no throw.
    expect(() => scan()).not.toThrow();
  });
});

describe("scanDocument hostile pages", () => {
  it("named form controls cannot shadow the DOM properties the walk reads", () => {
    mount(
      `<form action="/f"><input name="firstChild"><input name="nextSibling">` +
        `<input name="shadowRoot"><input name="localName"><input name="nodeType"></form>` +
        `<input name="after">`,
    );
    expect(names(scan())).toEqual([
      "firstChild",
      "nextSibling",
      "shadowRoot",
      "localName",
      "nodeType",
      "after",
    ]);
  });

  it("a control whose properties throw is skipped, the rest are kept", () => {
    const root = mount(`<input name="a"><input name="bad"><input name="c">`);
    const bad = root.querySelector('[name="bad"]') as HTMLInputElement;
    Object.defineProperty(bad, "type", {
      get() {
        throw new Error("hostile");
      },
    });
    expect(names(scan())).toEqual(["a", "c"]);
  });

  it("returns an empty result for a document without a root element", () => {
    const doc = document.implementation.createHTMLDocument("");
    doc.documentElement.remove();
    const r = scanDocument(doc, new PasswordHistory(), undefined, top);
    expect(r).toEqual({ controls: [], truncated: false });
  });
});

describe("scanDocument top-window default", () => {
  it("scans nothing inside a subframe (the test runner's own iframe)", () => {
    mount(`<input name="a">`);
    expect(scanDocument(document, history()).controls).toHaveLength(0);
  });
});

describe("pageFingerprint", () => {
  it("is the sigKey of each control, in order", () => {
    mount(
      `<input name="a" autocomplete="email"><select name="b"><option>x</option></select>`,
    );
    const r = scan();
    expect(pageFingerprint(r)).toEqual(
      r.controls.map((c) => sigKey(c.sig, c.kind)),
    );
    expect(pageFingerprint(r)).toHaveLength(2);
  });
});
