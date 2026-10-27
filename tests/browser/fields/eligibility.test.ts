import { afterEach, describe, expect, it } from "vitest";
import {
  controlKind,
  isEligible as isEligibleIn,
} from "../../../src/lib/fields/eligibility";

// Vitest browser mode runs tests inside an iframe, so the top-frame rule is stubbed here and
// exercised for real by the nested-iframe test below.
const isEligible = (el: Element) =>
  isEligibleIn(el, el.ownerDocument, () => true);

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html; // test-only fixture markup
  document.body.append(root);
  return root;
}

function q<T extends Element = HTMLInputElement>(
  root: ParentNode,
  selector = "input",
): T {
  const el = root.querySelector<T>(selector);
  if (!el) throw new Error(`no ${selector}`);
  return el;
}

afterEach(() => {
  document.documentElement.style.overflowX = "";
  document.body.replaceChildren();
});

describe("controlKind", () => {
  it.each([
    ["text", "text"],
    ["email", "text"],
    ["tel", "text"],
    ["number", "text"],
    ["date", "text"],
    ["search", "text"],
    ["url", "text"],
    ["checkbox", "checkbox"],
    ["radio", "radio"],
  ])("input type=%s is %s", (type, kind) => {
    const r = mount(`<input type="${type}">`);
    expect(controlKind(q(r))).toBe(kind);
  });

  it.each(["password", "hidden", "file", "submit", "button", "range", "color"])(
    "input type=%s is null",
    (type) => {
      const r = mount(`<input type="${type}">`);
      expect(controlKind(q(r))).toBeNull();
    },
  );

  it("input without a type, textarea and select", () => {
    const r = mount(`<input><textarea></textarea><select></select><div></div>`);
    expect(controlKind(q(r))).toBe("text");
    expect(controlKind(q(r, "textarea"))).toBe("text");
    expect(controlKind(q(r, "select"))).toBe("select");
    expect(controlKind(q(r, "div"))).toBeNull();
  });
});

describe("isEligible", () => {
  it("a plain visible input", () => {
    const r = mount(`<input type="text" style="width:120px;height:24px">`);
    expect(isEligible(q(r))).toBe(true);
  });

  it("textarea, select, checkbox and radio", () => {
    const r = mount(
      `<textarea></textarea><select><option>a</option></select>` +
        `<input type="checkbox"><input type="radio">`,
    );
    expect(isEligible(q(r, "textarea"))).toBe(true);
    expect(isEligible(q(r, "select"))).toBe(true);
    expect(isEligible(q(r, "[type=checkbox]"))).toBe(true);
    expect(isEligible(q(r, "[type=radio]"))).toBe(true);
  });

  it("not a form control kind", () => {
    const r = mount(`<input type="password"><div>x</div>`);
    expect(isEligible(q(r))).toBe(false);
    expect(isEligible(q(r, "div"))).toBe(false);
  });

  it("an input below the fold is eligible", () => {
    const r = mount(`<div style="height:4000px"></div><input>`);
    const el = q(r);
    expect(el.getBoundingClientRect().top).toBeGreaterThan(window.innerHeight);
    expect(isEligible(el)).toBe(true);
  });

  it("an input scrolled partly out of the viewport is eligible", () => {
    const r = mount(
      `<div style="height:${window.innerHeight - 10}px"></div><input style="height:40px">`,
    );
    expect(isEligible(q(r))).toBe(true);
  });

  it("disabled and readonly", () => {
    const r = mount(
      `<input disabled><input readonly><textarea readonly></textarea>`,
    );
    const [a, b] = Array.from(r.querySelectorAll("input"));
    expect(isEligible(a as HTMLInputElement)).toBe(false);
    expect(isEligible(b as HTMLInputElement)).toBe(false);
    expect(isEligible(q(r, "textarea"))).toBe(false);
  });

  it("disabled through a fieldset", () => {
    const r = mount(`<fieldset disabled><input></fieldset>`);
    expect(isEligible(q(r))).toBe(false);
  });

  it("display:none, also through an ancestor", () => {
    const r = mount(
      `<input style="display:none"><div style="display:none"><input id="b"></div>`,
    );
    expect(isEligible(q(r))).toBe(false);
    expect(isEligible(q(r, "#b"))).toBe(false);
  });

  it("visibility:hidden", () => {
    const r = mount(`<input style="visibility:hidden">`);
    expect(isEligible(q(r))).toBe(false);
  });

  it("opacity:0, also on an ancestor", () => {
    const r = mount(
      `<input style="opacity:0"><div style="opacity:0"><input id="b"></div>`,
    );
    expect(isEligible(q(r))).toBe(false);
    expect(isEligible(q(r, "#b"))).toBe(false);
  });

  it("content-visibility:hidden ancestor", () => {
    const r = mount(
      `<div style="content-visibility:hidden;height:50px"><input></div>`,
    );
    expect(isEligible(q(r))).toBe(false);
  });

  it("parked off-canvas to the left and above", () => {
    const r = mount(
      `<input style="position:absolute;left:-9999px;top:0">` +
        `<input id="b" style="position:absolute;left:0;top:-9999px">`,
    );
    expect(isEligible(q(r))).toBe(false);
    expect(isEligible(q(r, "#b"))).toBe(false);
  });

  it("parked off-canvas to the right, with or without overflow-x hidden", () => {
    const html =
      `<input style="position:absolute;left:9999px;top:0">` +
      `<input id="b" style="position:absolute;left:0;top:0;transform:translateX(10000px)">`;
    const r = mount(html);
    expect(isEligible(q(r))).toBe(false);
    expect(isEligible(q(r, "#b"))).toBe(false);
    document.documentElement.style.overflowX = "hidden";
    document.body.style.overflowX = "hidden";
    expect(isEligible(q(r))).toBe(false);
    expect(isEligible(q(r, "#b"))).toBe(false);
    document.body.style.overflowX = "";
  });

  it("a box wider than the viewport that starts inside it is eligible", () => {
    const r = mount(`<input style="width:${window.innerWidth * 3}px">`);
    expect(isEligible(q(r))).toBe(true);
  });

  it("opacity just above and below the threshold", () => {
    const r = mount(
      `<input style="opacity:0.01"><input id="b" style="opacity:0.09">` +
        `<input id="c" style="opacity:0.5">`,
    );
    expect(isEligible(q(r))).toBe(false);
    expect(isEligible(q(r, "#b"))).toBe(false);
    expect(isEligible(q(r, "#c"))).toBe(true);
  });

  it("effective opacity is the product along the ancestors", () => {
    const r = mount(
      `<div style="opacity:0.3"><div style="opacity:0.3"><input></div></div>` +
        `<div style="opacity:0.5"><div style="opacity:0.5"><input id="b"></div></div>`,
    );
    expect(isEligible(q(r))).toBe(false); // 0.09
    expect(isEligible(q(r, "#b"))).toBe(true); // 0.25
  });

  it("filter: opacity(0) hides, other filters do not", () => {
    const r = mount(
      `<input style="filter:opacity(0)"><input id="b" style="filter:opacity(5%)">` +
        `<div style="filter:opacity(0)"><input id="c"></div>` +
        `<input id="d" style="filter:blur(1px)"><input id="e" style="filter:opacity(0.8)">`,
    );
    expect(isEligible(q(r))).toBe(false);
    expect(isEligible(q(r, "#b"))).toBe(false);
    expect(isEligible(q(r, "#c"))).toBe(false);
    expect(isEligible(q(r, "#d"))).toBe(true);
    expect(isEligible(q(r, "#e"))).toBe(true);
  });

  it("transparent text on a transparent background is hidden; either alone is fine", () => {
    const r = mount(
      `<input style="color:transparent;background:transparent;border:0">` +
        `<input id="b" style="color:rgba(0,0,0,0);background-color:rgba(255,255,255,0);border:0">` +
        `<input id="c" style="color:transparent;background:#fff">` +
        `<input id="d" style="color:#000;background:transparent">` +
        `<input id="e" style="color:rgb(255,0,0);background:rgb(0,0,0)">` +
        `<input id="f" style="color:transparent;background:transparent linear-gradient(red,blue)">` +
        `<input id="g" type="checkbox" style="color:transparent;background:transparent">` +
        `<textarea id="h" style="color:transparent;background:transparent"></textarea>`,
    );
    expect(isEligible(q(r))).toBe(false);
    expect(isEligible(q(r, "#b"))).toBe(false);
    expect(isEligible(q(r, "#c"))).toBe(true);
    expect(isEligible(q(r, "#d"))).toBe(true);
    expect(isEligible(q(r, "#e"))).toBe(true);
    expect(isEligible(q(r, "#f"))).toBe(true); // a background image shows the field
    expect(isEligible(q(r, "#g"))).toBe(true); // native checkbox paints regardless of color
    expect(isEligible(q(r, "#h"))).toBe(false);
  });

  it("aria-hidden is case- and whitespace-insensitive", () => {
    const r = mount(
      `<div aria-hidden="TRUE"><input></div><div aria-hidden=" true "><input id="b"></div>`,
    );
    expect(isEligible(q(r))).toBe(false);
    expect(isEligible(q(r, "#b"))).toBe(false);
  });

  it("smaller than 4x4", () => {
    const r = mount(
      `<input style="width:1px;height:1px;padding:0;border:0">` +
        `<input id="b" style="width:3px;height:30px;padding:0;border:0">` +
        `<input id="c" style="width:30px;height:3px;padding:0;border:0">` +
        `<input id="d" style="width:4px;height:4px;padding:0;border:0">`,
    );
    expect(isEligible(q(r))).toBe(false);
    expect(isEligible(q(r, "#b"))).toBe(false);
    expect(isEligible(q(r, "#c"))).toBe(false);
    expect(isEligible(q(r, "#d"))).toBe(true);
  });

  it("inert ancestor", () => {
    const r = mount(`<div inert><section><input></section></div>`);
    expect(isEligible(q(r))).toBe(false);
  });

  it("inert ancestor below the fold (no hit test applies)", () => {
    const r = mount(
      `<div style="height:4000px"></div><div inert><input></div>`,
    );
    expect(isEligible(q(r))).toBe(false);
  });

  it("aria-hidden=true ancestor, but not aria-hidden=false", () => {
    const r = mount(
      `<div aria-hidden="true"><input></div><div aria-hidden="false"><input id="b"></div>`,
    );
    expect(isEligible(q(r))).toBe(false);
    expect(isEligible(q(r, "#b"))).toBe(true);
  });

  it("covered by an overlay", () => {
    const r = mount(
      `<input id="a" style="position:absolute;left:20px;top:20px;width:100px;height:30px">` +
        `<div style="position:absolute;left:0;top:0;width:300px;height:300px"></div>`,
    );
    expect(isEligible(q(r, "#a"))).toBe(false);
  });

  it("covered only at its center", () => {
    const r = mount(
      `<input style="position:absolute;left:20px;top:20px;width:100px;height:30px">` +
        `<div style="position:absolute;left:60px;top:25px;width:20px;height:20px"></div>`,
    );
    expect(isEligible(q(r))).toBe(false);
  });

  it("an overlay with pointer-events:none does not cover", () => {
    const r = mount(
      `<input style="position:absolute;left:20px;top:20px;width:100px;height:30px">` +
        `<div style="position:absolute;left:0;top:0;width:300px;height:300px;pointer-events:none"></div>`,
    );
    expect(isEligible(q(r))).toBe(true);
  });

  it("an overlay below the fold does not matter (not in the viewport)", () => {
    const r = mount(
      `<div style="height:4000px"></div><input id="a" style="position:absolute;top:4100px;left:0">` +
        `<div style="position:absolute;top:4000px;left:0;width:500px;height:500px"></div>`,
    );
    expect(isEligible(q(r, "#a"))).toBe(true);
  });

  it("an input inside a label is hit through its own box", () => {
    const r = mount(`<label>Name <input></label>`);
    expect(isEligible(q(r))).toBe(true);
  });

  it("a select whose hit target is its descendant", () => {
    const r = mount(
      `<select style="width:100px;height:30px"><option>a</option></select>`,
    );
    expect(isEligible(q(r, "select"))).toBe(true);
  });

  it("detached control", () => {
    const el = document.createElement("input");
    expect(isEligible(el)).toBe(false);
  });

  it("not in the top frame", async () => {
    const frame = document.createElement("iframe");
    frame.srcdoc = `<input style="width:100px;height:24px">`;
    document.body.append(frame);
    await new Promise((resolve) => frame.addEventListener("load", resolve));
    const doc = frame.contentDocument as Document;
    const inner = q(doc);
    expect(inner.getBoundingClientRect().width).toBeGreaterThan(0);
    expect(isEligible(inner)).toBe(true); // everything else passes
    expect(isEligibleIn(inner)).toBe(false); // default rule: the frame is not the top window
  });

  it("deeply nested but within the ancestor budget", () => {
    const outer = document.createElement("div");
    let node = outer;
    for (let i = 0; i < 300; i++) {
      const child = document.createElement("div");
      node.append(child);
      node = child;
    }
    node.append(document.createElement("input"));
    document.body.append(outer);
    expect(isEligible(q(outer))).toBe(true);
  });

  it("an ancestor chain beyond the budget is ineligible (fail closed)", () => {
    const outer = document.createElement("div");
    let node = outer;
    for (let i = 0; i < 700; i++) {
      const child = document.createElement("div");
      node.append(child);
      node = child;
    }
    node.append(document.createElement("input"));
    document.body.append(outer);
    expect(isEligible(q(outer))).toBe(false);
  });

  it("never throws when the page breaks the DOM API", () => {
    const r = mount(`<input>`);
    const el = q(r);
    Object.defineProperty(el, "getBoundingClientRect", {
      value() {
        throw new Error("hostile");
      },
    });
    expect(isEligible(el)).toBe(false);
  });

  describe("shadow DOM", () => {
    function shadowInput(innerHtml: string): HTMLInputElement {
      const host = document.createElement("div");
      document.body.append(host);
      const shadow = host.attachShadow({ mode: "open" });
      shadow.innerHTML = innerHtml; // test-only fixture markup
      return q(shadow);
    }

    it("an input in an open shadow root is eligible", () => {
      expect(
        isEligible(shadowInput(`<input style="width:100px;height:24px">`)),
      ).toBe(true);
    });

    it("covered by a sibling inside the same shadow root", () => {
      const el = shadowInput(
        `<input style="position:absolute;left:20px;top:20px;width:100px;height:30px">` +
          `<div style="position:absolute;left:0;top:0;width:300px;height:300px"></div>`,
      );
      expect(isEligible(el)).toBe(false);
    });

    it("an aria-hidden host hides the input inside", () => {
      const el = shadowInput(`<input>`);
      (el.getRootNode() as ShadowRoot).host.setAttribute("aria-hidden", "true");
      expect(isEligible(el)).toBe(false);
    });
  });
});

describe("isEligible in a doctype-less (quirks mode) frame", () => {
  async function quirksFrame(body: string): Promise<Document> {
    const frame = document.createElement("iframe");
    frame.style.cssText = "width:400px;height:300px;border:0";
    // A srcdoc document is always standards mode; a same-origin blob document without a doctype is not.
    const url = URL.createObjectURL(
      new Blob([`<body style="margin:0">${body}</body>`], {
        type: "text/html",
      }),
    );
    frame.src = url;
    document.body.append(frame);
    await new Promise((resolve) => frame.addEventListener("load", resolve));
    URL.revokeObjectURL(url);
    const doc = frame.contentDocument as Document;
    expect(doc.compatMode).toBe("BackCompat");
    return doc;
  }
  const eligible = (doc: Document, selector: string) =>
    isEligibleIn(q(doc, selector), doc, () => true);

  it("a field below the fold is eligible", async () => {
    const doc = await quirksFrame(
      `<div style="height:3000px"></div><input id="a" style="height:24px">`,
    );
    expect(eligible(doc, "#a")).toBe(true);
  });

  it("a field partly below the fold is eligible", async () => {
    const doc = await quirksFrame(
      `<div style="height:290px"></div><input id="a" style="height:40px">`,
    );
    expect(eligible(doc, "#a")).toBe(true);
  });

  it("an in-viewport field covered by an overlay is not", async () => {
    const doc = await quirksFrame(
      `<input id="a" style="position:absolute;left:20px;top:20px;width:100px;height:30px">` +
        `<div style="position:absolute;left:0;top:0;width:300px;height:200px"></div>` +
        `<div style="height:3000px"></div>`,
    );
    expect(eligible(doc, "#a")).toBe(false);
  });

  it("an in-viewport uncovered field is eligible; parked right is not", async () => {
    const doc = await quirksFrame(
      `<input id="a" style="width:100px"><input id="b" style="position:absolute;left:9999px;top:0">` +
        `<div style="height:3000px"></div>`,
    );
    expect(eligible(doc, "#a")).toBe(true);
    expect(eligible(doc, "#b")).toBe(false);
  });
});
