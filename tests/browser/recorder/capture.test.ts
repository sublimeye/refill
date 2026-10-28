import { afterEach, describe, expect, it } from "vitest";
import { PageDefaults, readValue } from "../../../src/lib/recorder/capture";
import type { ScannedControl } from "../../../src/lib/fields/scan";
import type { ControlKind } from "../../../src/lib/fields/eligibility";
import {
  buildSignature,
  type FormControl,
} from "../../../src/lib/fields/signature";

afterEach(() => {
  document.body.replaceChildren();
});

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html; // test-only fixture markup
  document.body.append(root);
  return root;
}

const q = <T extends Element>(sel: string) => document.querySelector<T>(sel)!;

/** A scanned control with the element's real signature, as the scanner would give it. */
function scanned(el: FormControl, kind: ControlKind = "text"): ScannedControl {
  return { i: 0, el, kind, sig: buildSignature(el, 0, null) };
}

const scan = (el: FormControl) => scanned(el);

describe("readValue", () => {
  it("reads text, textarea, select, checkbox and radio", () => {
    mount(
      `<input name="t" value="Ada"><textarea name="a">Line</textarea>` +
        `<select name="s"><option value="x">X</option><option value="y" selected>Y</option></select>` +
        `<input type="checkbox" name="c" checked><input type="checkbox" name="d">` +
        `<input type="radio" name="r" value="1" checked><input type="radio" name="r" value="2">`,
    );
    expect(readValue(q('[name="t"]'), "text")).toBe("Ada");
    expect(readValue(q('[name="a"]'), "text")).toBe("Line");
    expect(readValue(q('[name="s"]'), "select")).toBe("y");
    expect(readValue(q('[name="c"]'), "checkbox")).toBe("true");
    expect(readValue(q('[name="d"]'), "checkbox")).toBe("false");
    expect(readValue(q('[value="1"]'), "radio")).toBe("true");
    expect(readValue(q('[value="2"]'), "radio")).toBeNull();
  });

  it("reads through the prototype, not a page-defined own property", () => {
    mount(`<form><input name="t" value="real"></form>`);
    const el = q<HTMLInputElement>('[name="t"]');
    Object.defineProperty(el, "value", { get: () => "forged" });
    Object.defineProperty(el, "checked", { get: () => true });
    expect(readValue(el, "text")).toBe("real");
  });

  it("is null for an element that does not fit the kind", () => {
    mount(`<input name="t">`);
    expect(readValue(q('[name="t"]'), "select")).toBeNull();
  });
});

describe("PageDefaults", () => {
  it("keeps the first value a scan saw, whatever happens later", () => {
    mount(
      `<input name="t" value="page"><input type="checkbox" name="c">` +
        `<select name="s"><option value="a">A</option><option value="b">B</option></select>`,
    );
    const t = q<HTMLInputElement>('[name="t"]');
    const c = q<HTMLInputElement>('[name="c"]');
    const s = q<HTMLSelectElement>('[name="s"]');
    const d = new PageDefaults();
    d.note([scanned(t, "text"), scanned(c, "checkbox"), scanned(s, "select")]);
    t.value = "typed";
    c.checked = true;
    s.value = "b";
    d.note([scanned(t, "text"), scanned(c, "checkbox"), scanned(s, "select")]);
    expect(d.get(t, "text")).toBe("page");
    expect(d.get(c, "checkbox")).toBe("false");
    expect(d.get(s, "select")).toBe("a");
  });

  it("notes again when the element was re-used for another field (P13)", () => {
    mount(
      `<label><span id="l">City</span> <input name="city" value="Paris"></label>`,
    );
    const el = q<HTMLInputElement>('[name="city"]');
    const d = new PageDefaults();
    d.note([scan(el)]);
    el.value = "Lyon"; // the user's edit: no new default
    d.note([scan(el)]);
    expect(d.get(el, "text")).toBe("Paris");
    // Re-used for step 2: renamed, relabelled, and the page renders its own value.
    el.name = "zip";
    q("#l").textContent = "Zip";
    el.value = "75000";
    d.note([scan(el)]);
    expect(d.get(el, "text")).toBe("75000");
  });

  it("an edit under a new meaning before any scan keeps the markup default for that meaning", () => {
    mount(
      `<label><span id="l">City</span> <input name="city" value="Paris"></label>`,
    );
    const el = q<HTMLInputElement>('[name="city"]');
    const d = new PageDefaults();
    d.note([scan(el)]);
    el.name = "zip";
    q("#l").textContent = "Zip";
    el.defaultValue = "";
    el.value = "75001"; // typed before the next scan
    expect(d.get(el, "text")).toBe("");
    // A scan after the edit does not take the typed value for the page's own.
    d.note([scan(el)]);
    expect(d.get(el, "text")).toBe("");
  });

  it("notes the live value, not the markup, when the page set it before the first scan", () => {
    mount(`<input name="t" value="markup">`);
    const t = q<HTMLInputElement>('[name="t"]');
    t.value = "script";
    const d = new PageDefaults();
    d.note([scanned(t, "text")]);
    expect(d.get(t, "text")).toBe("script");
  });

  it("falls back to the markup default for an element no scan has seen", () => {
    mount(
      `<input name="t" value="dv"><textarea name="a">ta</textarea>` +
        `<input type="checkbox" name="c" checked><input type="radio" name="r">` +
        `<select name="s"><option value="a">A</option><option value="b" selected>B</option></select>` +
        `<select name="n"><option value="first">F</option><option value="z">Z</option></select>` +
        `<select name="e"></select>`,
    );
    const d = new PageDefaults();
    const t = q<HTMLInputElement>('[name="t"]');
    t.value = "typed";
    const c = q<HTMLInputElement>('[name="c"]');
    c.checked = false;
    const s = q<HTMLSelectElement>('[name="s"]');
    s.value = "a";
    const n = q<HTMLSelectElement>('[name="n"]');
    n.value = "z";
    expect(d.get(t, "text")).toBe("dv");
    expect(d.get(q('[name="a"]'), "text")).toBe("ta");
    expect(d.get(c, "checkbox")).toBe("true");
    expect(d.get(q('[name="r"]'), "radio")).toBe("false");
    expect(d.get(s, "select")).toBe("b");
    expect(d.get(n, "select")).toBe("first");
    expect(d.get(q('[name="e"]'), "select")).toBe("");
  });
});
