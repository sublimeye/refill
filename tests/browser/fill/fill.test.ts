import { createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { createApp, h, nextTick, ref, vModelText, withDirectives } from "vue";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ControlKind } from "../../../src/lib/fields/eligibility";
import { PasswordHistory } from "../../../src/lib/fields/sensitive";
import type { FormControl } from "../../../src/lib/fields/signature";
import {
  canFill,
  fillControl,
  isFilling,
  MAX_FORMACTION_ELEMENTS,
  restore,
  snapshot,
  withFillingGuard,
  type FillItem,
} from "../../../src/lib/fill/fill";

// Vitest browser mode runs tests inside an iframe, so the top-frame rule is stubbed.
const top = () => true;
const origin = location.origin;
const histories: PasswordHistory[] = [];
const cleanups: (() => void)[] = [];

function history(): PasswordHistory {
  const hist = new PasswordHistory();
  hist.observe(document);
  histories.push(hist);
  return hist;
}

afterEach(() => {
  for (const c of cleanups.splice(0)) c();
  for (const hist of histories.splice(0)) hist.disconnect();
  document.body.replaceChildren();
});

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html; // test-only fixture markup
  document.body.append(root);
  return root;
}

const q = <T extends Element = FormControl>(selector: string): T => {
  const el = document.querySelector<T>(selector);
  if (el === null) throw new Error(`missing ${selector}`);
  return el;
};

function item(
  el: FormControl,
  value: string,
  pageDefault = "",
  kind?: ControlKind,
): FillItem {
  const k =
    kind ??
    (el.localName === "select"
      ? "select"
      : el.localName === "textarea"
        ? "text"
        : (el as HTMLInputElement).type === "checkbox"
          ? "checkbox"
          : (el as HTMLInputElement).type === "radio"
            ? "radio"
            : "text");
  return { el, kind: k, value, pageDefault };
}

const can = (i: FillItem, o = origin) => canFill(i, history(), o, top);
const fill = (i: FillItem, o = origin) => fillControl(i, history(), o, top);

describe("text fill", () => {
  it("fills a plain input, fires input/change/blur and focuses first", () => {
    mount(`<input name="a">`);
    const el = q<HTMLInputElement>("[name=a]");
    const log: string[] = [];
    for (const t of ["focus", "input", "change", "blur"]) {
      el.addEventListener(t, (e) => {
        log.push(`${e.type}:${e.bubbles}`);
      });
    }
    expect(fill(item(el, "hello"))).toBe("filled");
    expect(el.value).toBe("hello");
    expect(log).toEqual([
      "focus:false",
      "input:true",
      "change:true",
      "blur:false",
    ]);
  });

  it("fills a textarea", () => {
    mount(`<textarea name="a"></textarea>`);
    const el = q<HTMLTextAreaElement>("[name=a]");
    expect(fill(item(el, "two\nlines"))).toBe("filled");
    expect(el.value).toBe("two\nlines");
  });

  it("updates a React 19 controlled input (state, not just the DOM)", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    function Form() {
      const [v, setV] = useState("");
      return createElement(
        "div",
        null,
        createElement("input", {
          name: "r",
          value: v,
          onChange: (e: { target: { value: string } }) => {
            setV(e.target.value);
          },
        }),
        createElement("output", { id: "mirror" }, `state:${v}`),
      );
    }
    const root = createRoot(host);
    root.render(createElement(Form));
    cleanups.push(() => {
      root.unmount();
    });
    await vi.waitFor(() => {
      expect(document.querySelector("[name=r]")).not.toBeNull();
    });
    const el = q<HTMLInputElement>("[name=r]");
    expect(fill(item(el, "from vault"))).toBe("filled");
    await vi.waitFor(() => {
      expect(q<HTMLElement>("#mirror").textContent).toBe("state:from vault");
    });
    expect(el.value).toBe("from vault");
  });

  it("updates a Vue 3 v-model input", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    const model = ref("");
    const bound = createApp({
      render: () =>
        h("div", [
          withDirectives(
            h("input", {
              name: "v",
              "onUpdate:modelValue": (val: string) => {
                model.value = val;
              },
            }),
            [[vModelText, model.value]],
          ),
          h("output", { id: "mirror" }, `state:${model.value}`),
        ]),
    });
    bound.mount(host);
    cleanups.push(() => {
      bound.unmount();
    });
    const el = q<HTMLInputElement>("[name=v]");
    expect(fill(item(el, "vue value"))).toBe("filled");
    await nextTick();
    expect(model.value).toBe("vue value");
    expect(q<HTMLElement>("#mirror").textContent).toBe("state:vue value");
  });

  it("falls back to insertText for a mask that only accepts trusted typing", () => {
    mount(`<input name="phone">`);
    const el = q<HTMLInputElement>("[name=phone]");
    let accepted = "";
    const seen: boolean[] = [];
    el.addEventListener("input", (e) => {
      seen.push(e.isTrusted);
      // programmatic writes are reverted, typing is accepted
      if (e.isTrusted) accepted = el.value;
      else el.value = accepted;
    });
    expect(fill(item(el, "(555) 123-4567"))).toBe("filled");
    expect(el.value).toBe("(555) 123-4567");
    expect(seen).toContain(false);
    expect(seen).toContain(true);
  });

  it("holds the guard during the insertText fallback events", () => {
    mount(`<input name="phone">`);
    const el = q<HTMLInputElement>("[name=phone]");
    const trustedFilling: boolean[] = [];
    let accepted = "";
    el.addEventListener("input", (e) => {
      if (e.isTrusted) {
        trustedFilling.push(isFilling());
        accepted = el.value;
      } else el.value = accepted;
    });
    expect(fill(item(el, "42"))).toBe("filled");
    expect(trustedFilling).toEqual([true]);
  });

  it("reports rejected-by-page when the page refuses even typing, and releases the guard", () => {
    mount(`<input name="a">`);
    const el = q<HTMLInputElement>("[name=a]");
    el.addEventListener("input", () => {
      el.value = "";
    });
    expect(fill(item(el, "nope"))).toBe("rejected-by-page");
    expect(isFilling()).toBe(false);
  });

  it("restore puts the pre-fill value back", () => {
    mount(`<input name="a" value="x">`);
    const el = q<HTMLInputElement>("[name=a]");
    const s = snapshot([item(el, "y", "x")]);
    el.value = "typed later";
    restore(s);
    expect(el.value).toBe("x");
  });
});

describe("select", () => {
  it("sets an existing option and fires input and change", () => {
    mount(
      `<select name="s"><option value="">-</option><option value="b">B</option></select>`,
    );
    const el = q<HTMLSelectElement>("[name=s]");
    const types: string[] = [];
    for (const t of ["input", "change"]) {
      el.addEventListener(t, (e) => types.push(e.type));
    }
    expect(fill(item(el, "b"))).toBe("filled");
    expect(el.value).toBe("b");
    expect(types).toEqual(["input", "change"]);
  });

  it("is unsupported when the option is missing and leaves the select alone", () => {
    mount(
      `<select name="s"><option value="">-</option><option value="b">B</option></select>`,
    );
    const el = q<HTMLSelectElement>("[name=s]");
    expect(fill(item(el, "zzz"))).toBe("unsupported");
    expect(el.value).toBe("");
  });
});

describe("checkbox and radio", () => {
  it("clicks an unchecked checkbox, not one already in the target state", () => {
    mount(
      `<input type="checkbox" name="c"><input type="checkbox" name="d" checked>`,
    );
    const c = q<HTMLInputElement>("[name=c]");
    const d = q<HTMLInputElement>("[name=d]");
    let clicks = 0;
    for (const el of [c, d]) {
      el.addEventListener("click", () => clicks++);
    }
    expect(fill(item(c, "true", "false"))).toBe("filled");
    expect(c.checked).toBe(true);
    expect(clicks).toBe(1);
    expect(fill(item(d, "true", "true"))).toBe("filled");
    expect(d.checked).toBe(true);
    expect(clicks).toBe(1);
  });

  it("unchecks a checkbox whose target is false", () => {
    mount(`<input type="checkbox" name="d" checked>`);
    const d = q<HTMLInputElement>("[name=d]");
    expect(fill(item(d, "false", "true"))).toBe("filled");
    expect(d.checked).toBe(false);
  });

  it("checks a radio and unchecks its group mate", () => {
    mount(
      `<input type="radio" name="r" value="a" checked><input type="radio" name="r" value="b">`,
    );
    const [a, b] = Array.from(
      document.querySelectorAll<HTMLInputElement>("[name=r]"),
    );
    expect(fill(item(b as HTMLInputElement, "true", "false"))).toBe("filled");
    expect(b?.checked).toBe(true);
    expect(a?.checked).toBe(false);
  });

  it("clicks the native input itself for the opacity-0 label-proxy pattern", () => {
    mount(
      `<input type="checkbox" id="agree" name="agree" style="position:absolute;opacity:0;width:20px;height:20px">` +
        `<label for="agree" style="display:inline-block;padding:8px">I agree</label>`,
    );
    const el = q<HTMLInputElement>("#agree");
    // A page-defined own click must not be used: the prototype click is.
    el.click = () => {
      throw new Error("page click used");
    };
    const i = item(el, "true", "false");
    expect(can(i)).toBe(true);
    expect(fill(i)).toBe("filled");
    expect(el.checked).toBe(true);
  });

  it("reports rejected-by-page when the page cancels the click", () => {
    mount(`<input type="checkbox" name="c">`);
    const c = q<HTMLInputElement>("[name=c]");
    c.addEventListener("click", (e) => {
      e.preventDefault();
    });
    expect(fill(item(c, "true", "false"))).toBe("rejected-by-page");
    expect(c.checked).toBe(false);
  });
});

describe("fill rules (canFill)", () => {
  it("skips a field the user typed into", () => {
    mount(`<input name="a">`);
    const el = q<HTMLInputElement>("[name=a]");
    el.value = "typed";
    const i = item(el, "vault", "");
    expect(can(i)).toBe(false);
    expect(fill(i)).toBe("skipped-not-empty");
    expect(el.value).toBe("typed");
  });

  it("allows a field that still holds the recorded page default", () => {
    mount(`<input name="a" value="100">`);
    const el = q<HTMLInputElement>("[name=a]");
    const i = item(el, "250", "100");
    expect(can(i)).toBe(true);
    expect(fill(i)).toBe("filled");
    expect(el.value).toBe("250");
    // ...but not once the page re-rendered a different value after a postback
    el.value = "999";
    expect(can(item(el, "250", "100"))).toBe(false);
  });

  it("compares String(checked) for toggles", () => {
    mount(`<input type="checkbox" name="c" checked>`);
    const c = q<HTMLInputElement>("[name=c]");
    expect(can(item(c, "false", "true"))).toBe(true);
    expect(can(item(c, "false", "false"))).toBe(false);
  });

  it("refuses ineligible, sensitive and mismatched-kind controls", () => {
    mount(
      `<input name="hid" disabled><input name="pw" type="text" autocomplete="one-time-code">` +
        `<input name="ok">`,
    );
    expect(can(item(q("[name=hid]"), "x"))).toBe(false);
    expect(fill(item(q("[name=hid]"), "x"))).toBe("skipped-ineligible");
    expect(can(item(q("[name=pw]"), "x"))).toBe(false);
    expect(can(item(q("[name=ok]"), "x", "", "select"))).toBe(false);
    expect(can(item(q("[name=ok]"), "x"))).toBe(true);
  });

  it("allows card number and SSN fields, still refuses the card security code", () => {
    mount(
      `<input name="card_number" autocomplete="cc-number">` +
        `<label>Social Security Number <input name="s"></label>` +
        `<input name="cvv" autocomplete="cc-csc"><input name="x_card_code">`,
    );
    const i = item(q("[name=card_number]"), "4111 1111 1111 1111");
    expect(can(i)).toBe(true);
    expect(fill(i)).toBe("filled");
    expect(q<HTMLInputElement>("[name=card_number]").value).toBe(
      "4111 1111 1111 1111",
    );
    expect(can(item(q("[name=s]"), "123-45-6789"))).toBe(true);
    expect(can(item(q("[name=cvv]"), "123"))).toBe(false);
    expect(fill(item(q("[name=x_card_code]"), "123"))).toBe(
      "skipped-ineligible",
    );
  });

  it("refuses an input that was once a password", () => {
    mount(`<input name="p" type="password">`);
    const hist = history();
    const el = q<HTMLInputElement>("[name=p]");
    el.type = "text";
    expect(canFill(item(el, "x"), hist, origin, top)).toBe(false);
  });

  it.each([
    ["no action attribute", "", true],
    ["relative action", `action="/submit"`, true],
    ["empty action", `action=""`, true],
    ["absolute same-origin action", `action="${origin}/post"`, true],
    ["cross-origin action", `action="https://evil.example/post"`, false],
    [
      "protocol-relative cross-origin action",
      `action="//evil.example/post"`,
      false,
    ],
    [
      "same host other port",
      `action="${location.protocol}//${location.hostname}:1/p"`,
      false,
    ],
    ["javascript: action", `action="javascript:void(0)"`, false],
  ])("form %s", (_name, attr, expected) => {
    mount(`<form ${attr}><input name="a"></form>`);
    expect(can(item(q("[name=a]"), "x"))).toBe(expected);
  });

  it("uses the form= owner, not the DOM parent, for the action", () => {
    mount(
      `<form id="f" action="https://evil.example/p"></form><div><input name="a" form="f"></div>`,
    );
    expect(can(item(q("[name=a]"), "x"))).toBe(false);
  });
});

describe("fill rules (canFill): submitter formaction", () => {
  const EVIL = `formaction="https://evil.example/x"`;

  it.each([
    ["button without type", `<button ${EVIL}>Pay</button>`, false],
    ["button type=submit", `<button type="submit" ${EVIL}>Pay</button>`, false],
    [
      "button with an invalid type",
      `<button type="nope" ${EVIL}>Pay</button>`,
      false,
    ],
    ["input type=submit", `<input type="submit" ${EVIL}>`, false],
    ["input type=image", `<input type="image" alt="Pay" ${EVIL}>`, false],
    [
      "protocol-relative",
      `<button formaction="//evil.example/x">Pay</button>`,
      false,
    ],
    [
      "javascript: formaction",
      `<button formaction="javascript:void(0)">Pay</button>`,
      false,
    ],
    [
      "same-origin absolute",
      `<button formaction="${origin}/pay">Pay</button>`,
      true,
    ],
    ["relative", `<button formaction="/pay">Pay</button>`, true],
    ["empty", `<button formaction="">Pay</button>`, true],
    [
      "button type=button (not a submitter)",
      `<button type="button" ${EVIL}>x</button>`,
      true,
    ],
    [
      "button type=reset (not a submitter)",
      `<button type="reset" ${EVIL}>x</button>`,
      true,
    ],
    [
      "input type=button (not a submitter)",
      `<input type="button" ${EVIL}>`,
      true,
    ],
  ])("in-form %s", (_name, submitter, expected) => {
    mount(`<form action="/ok"><input name="a">${submitter}</form>`);
    expect(can(item(q("[name=a]"), "x"))).toBe(expected);
    if (!expected)
      expect(fill(item(q("[name=a]"), "x"))).toBe("skipped-ineligible");
  });

  it("refuses a cross-origin submitter outside the form, attached with form=", () => {
    mount(
      `<form id="f" action="/ok"><input name="a"></form>` +
        `<div><button form="f" ${EVIL}>Pay</button></div>`,
    );
    expect(can(item(q("[name=a]"), "x"))).toBe(false);
  });

  it("refuses an outside input type=image attached with form=", () => {
    mount(
      `<form id="f"><input name="a"></form><input type="image" alt="Pay" form="f" ${EVIL}>`,
    );
    expect(can(item(q("[name=a]"), "x"))).toBe(false);
  });

  it("refuses for a control that is itself attached with form=", () => {
    mount(
      `<form id="f"><button ${EVIL}>Pay</button></form><input name="a" form="f">`,
    );
    expect(can(item(q("[name=a]"), "x"))).toBe(false);
  });

  it("ignores a cross-origin submitter that belongs to another form", () => {
    mount(
      `<form id="f" action="/ok"><input name="a"></form>` +
        `<form id="g"><button ${EVIL}>Pay</button></form>` +
        `<button form="g" ${EVIL}>Pay</button>`,
    );
    expect(can(item(q("[name=a]"), "x"))).toBe(true);
  });

  it("ignores a cross-origin formaction for a control without a form", () => {
    mount(`<input name="a"><button ${EVIL}>Pay</button>`);
    expect(can(item(q("[name=a]"), "x"))).toBe(true);
  });

  it("resolves formaction against the document base", () => {
    const base = document.createElement("base");
    base.href = "https://evil.example/";
    document.head.append(base);
    cleanups.push(() => {
      base.remove();
    });
    mount(
      `<form action="${origin}/ok"><input name="a"><button formaction="/pay">Pay</button></form>`,
    );
    expect(can(item(q("[name=a]"), "x"))).toBe(false);
  });

  it("refuses once a cross-origin formaction appears between scan and fill", () => {
    mount(`<form action="/ok"><input name="a"><button>Pay</button></form>`);
    const i = item(q("[name=a]"), "x");
    expect(can(i)).toBe(true);
    q("button").setAttribute("formaction", "https://evil.example/x");
    expect(fill(i)).toBe("skipped-ineligible");
    expect(q<HTMLInputElement>("[name=a]").value).toBe("");
  });

  it("checks submitters inside the control's shadow root", () => {
    const host = mount(`<div id="h"></div>`).firstElementChild as HTMLElement;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<form action="/ok"><input name="a"><button ${EVIL}>Pay</button></form>`; // test-only fixture markup
    const el = shadow.querySelector<HTMLInputElement>("[name=a]");
    if (el === null) throw new Error("missing input");
    expect(can(item(el, "x"))).toBe(false);
  });

  it("fails closed past MAX_FORMACTION_ELEMENTS elements with formaction", () => {
    mount(
      `<form action="/ok"><input name="a"></form>` +
        `<div>${'<button type="button" formaction="/x">x</button>'.repeat(MAX_FORMACTION_ELEMENTS)}</div>`,
    );
    expect(can(item(q("[name=a]"), "x"))).toBe(true);
    mount(`<button type="button" formaction="/x">x</button>`);
    expect(can(item(q("[name=a]"), "x"))).toBe(false);
  });

  it("is not bypassed by form controls named like the members it reads", () => {
    const names = [
      "formAction",
      "formaction",
      "querySelectorAll",
      "getRootNode",
      "elements",
      "action",
      "form",
      "type",
      "length",
      "item",
    ];
    const clobbers = names
      .map((n) => `<input name="${n}" type="text">`)
      .join("");
    mount(
      `<form id="f" action="/ok">${clobbers}<input name="a"></form>` +
        `<button form="f" ${EVIL}>Pay</button>`,
    );
    expect(can(item(q("[name=a]"), "x"))).toBe(false);
    q("button").removeAttribute("formaction");
    expect(can(item(q("[name=a]"), "x"))).toBe(true);
  });

  it("is not bypassed by named elements that shadow document members", () => {
    // History first: PasswordHistory.observe reads `document.querySelectorAll` directly, and the
    // runner fails closed if that throws (runner.ts `begin`).
    const hist = history();
    mount(
      `<img name="querySelectorAll" alt=""><form name="getRootNode"></form>` +
        `<form action="/ok"><input name="a"><button ${EVIL}>Pay</button></form>`,
    );
    expect(document.querySelectorAll).not.toBe(
      Document.prototype.querySelectorAll,
    );
    const i = item(q("[name=a]"), "x");
    expect(canFill(i, hist, origin, top)).toBe(false);
    q("button").setAttribute("formaction", "/pay");
    expect(canFill(i, hist, origin, top)).toBe(true);
  });
});

describe("custom widgets", () => {
  it("react-select-like combobox (input inside role=combobox with a listbox) is unsupported", () => {
    mount(
      `<div role="combobox" aria-haspopup="listbox" aria-expanded="false" aria-controls="lb">` +
        `<div><input name="rs" type="text"></div></div>` +
        `<div id="lb" role="listbox"></div>`,
    );
    const el = q<HTMLInputElement>("[name=rs]");
    expect(fill(item(el, "Option"))).toBe("unsupported");
    expect(el.value).toBe("");
  });

  it("an input that is itself role=combobox is unsupported", () => {
    mount(`<input name="rs" role="combobox" aria-autocomplete="list">`);
    const el = q<HTMLInputElement>("[name=rs]");
    expect(fill(item(el, "Option"))).toBe("unsupported");
    expect(el.value).toBe("");
  });

  it("a native select with role=combobox is still filled", () => {
    mount(
      `<select name="s" role="combobox"><option value="">-</option><option value="b">B</option></select>`,
    );
    const el = q<HTMLSelectElement>("[name=s]");
    expect(fill(item(el, "b"))).toBe("filled");
  });

  it("a role=combobox ancestor without a listbox does not block a plain input", () => {
    mount(`<div role="combobox"><input name="a"></div>`);
    expect(fill(item(q("[name=a]"), "x"))).toBe("filled");
  });

  it("the ancestor check is bounded: a combobox 17 levels up does not count", () => {
    let html = `<input name="a">`;
    for (let i = 0; i < 17; i++) html = `<div>${html}</div>`;
    mount(`<div role="combobox" aria-haspopup="listbox">${html}</div>`);
    expect(fill(item(q("[name=a]"), "x"))).toBe("filled");
  });
});

describe("filling guard", () => {
  it("is true inside input, change, focus and blur handlers during a fill, false after", () => {
    mount(
      `<input name="a"><input type="checkbox" name="c"><select name="s"><option value="">-</option><option value="b">b</option></select>`,
    );
    const seen: string[] = [];
    for (const el of document.querySelectorAll("input, select")) {
      for (const t of ["input", "change", "focus", "blur", "click"]) {
        el.addEventListener(t, (e) => {
          if (isFilling())
            seen.push(`${(e.target as Element).localName}:${e.type}`);
        });
      }
    }
    expect(isFilling()).toBe(false);
    fill(item(q("[name=a]"), "x"));
    fill(item(q("[name=c]"), "true", "false"));
    fill(item(q("[name=s]"), "b"));
    expect(seen).toEqual(
      expect.arrayContaining([
        "input:focus",
        "input:input",
        "input:change",
        "input:blur",
        "input:click",
        "select:input",
        "select:change",
      ]),
    );
    expect(isFilling()).toBe(false);
  });

  it("is re-entrant and resets when the callback throws", () => {
    const states: boolean[] = [];
    withFillingGuard(() => {
      withFillingGuard(() => {
        states.push(isFilling());
      });
      states.push(isFilling()); // inner exit must not end the outer guard
    });
    states.push(isFilling());
    expect(states).toEqual([true, true, false]);
    expect(() =>
      withFillingGuard(() => {
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(isFilling()).toBe(false);
  });

  it("returns the callback's value", () => {
    expect(withFillingGuard(() => 7)).toBe(7);
  });

  it("is held while restoring", () => {
    mount(`<input name="a" value="orig">`);
    const el = q<HTMLInputElement>("[name=a]");
    const s = snapshot([item(el, "new", "orig")]);
    fill(item(el, "new", "orig"));
    let during = false;
    el.addEventListener("input", () => {
      during ||= isFilling();
    });
    restore(s);
    expect(during).toBe(true);
    expect(el.value).toBe("orig");
  });
});

describe("snapshot and restore", () => {
  it("round-trips text, textarea, select, checkbox and radio", () => {
    mount(
      `<input name="t" value="orig"><textarea name="ta">old</textarea>` +
        `<select name="s"><option value="a" selected>A</option><option value="b">B</option></select>` +
        `<input type="checkbox" name="c" checked>` +
        `<input type="radio" name="r" value="x" checked><input type="radio" name="r" value="y">`,
    );
    const radios = Array.from(
      document.querySelectorAll<HTMLInputElement>("[name=r]"),
    );
    const items = [
      item(q("[name=t]"), "new", "orig"),
      item(q("[name=ta]"), "newer", "old"),
      item(q("[name=s]"), "b", "a"),
      item(q("[name=c]"), "false", "true"),
      item(radios[0] as HTMLInputElement, "false", "true"),
      item(radios[1] as HTMLInputElement, "true", "false"),
    ];
    const s = snapshot(items);
    expect(items.map((i) => fill(i))).toEqual([
      "filled",
      "filled",
      "filled",
      "filled",
      "unsupported", // a checked radio cannot be unchecked by clicking
      "filled",
    ]);
    expect(q<HTMLInputElement>("[name=t]").value).toBe("new");
    restore(s);
    expect(q<HTMLInputElement>("[name=t]").value).toBe("orig");
    expect(q<HTMLTextAreaElement>("[name=ta]").value).toBe("old");
    expect(q<HTMLSelectElement>("[name=s]").value).toBe("a");
    expect(q<HTMLInputElement>("[name=c]").checked).toBe(true);
    expect(radios.map((r) => r.checked)).toEqual([true, false]);
  });

  it("restores through a mask with insertText", () => {
    mount(`<input name="phone" value="(111) 111-1111">`);
    const el = q<HTMLInputElement>("[name=phone]");
    let accepted = el.value;
    el.addEventListener("input", (e) => {
      if (e.isTrusted) accepted = el.value;
      else el.value = accepted;
    });
    const i = item(el, "(555) 123-4567", "(111) 111-1111");
    const s = snapshot([i]);
    expect(fill(i)).toBe("filled");
    restore(s);
    expect(el.value).toBe("(111) 111-1111");
  });

  it("puts a React controlled input's state back", async () => {
    const host = document.createElement("div");
    document.body.append(host);
    function Form() {
      const [v, setV] = useState("before");
      return createElement(
        "div",
        null,
        createElement("input", {
          name: "r",
          value: v,
          onChange: (e: { target: { value: string } }) => {
            setV(e.target.value);
          },
        }),
        createElement("output", { id: "mirror" }, `state:${v}`),
      );
    }
    const root = createRoot(host);
    root.render(createElement(Form));
    cleanups.push(() => {
      root.unmount();
    });
    await vi.waitFor(() => {
      expect(q<HTMLElement>("#mirror").textContent).toBe("state:before");
    });
    const i = item(q("[name=r]"), "after", "before");
    const s = snapshot([i]);
    fill(i);
    await vi.waitFor(() => {
      expect(q<HTMLElement>("#mirror").textContent).toBe("state:after");
    });
    restore(s);
    await vi.waitFor(() => {
      expect(q<HTMLElement>("#mirror").textContent).toBe("state:before");
    });
  });

  it("skips a control that left the document", () => {
    mount(`<input name="a" value="orig">`);
    const el = q<HTMLInputElement>("[name=a]");
    const s = snapshot([item(el, "new", "orig")]);
    el.remove();
    expect(() => {
      restore(s);
    }).not.toThrow();
    expect(el.value).toBe("orig");
  });
});

describe("DOM clobbering", () => {
  const NAMES = [
    "value",
    "checked",
    "click",
    "focus",
    "blur",
    "select",
    "dispatchEvent",
    "action",
    "form",
    "options",
    "baseURI",
    "ownerDocument",
    "isConnected",
    "getAttribute",
    "hasAttribute",
    "nodeType",
    "parentNode",
    "localName",
    "querySelector",
    "children",
    "formAction",
    "querySelectorAll",
    "getRootNode",
    "elements",
    "type",
  ];
  const clobbers = NAMES.map((n) => `<input name="${n}" type="text">`).join("");

  function formWith(action: string, body: string): string {
    return `<form ${action}>${clobbers}${body}</form>`;
  }

  it("fills every kind inside a form whose properties are all replaced", () => {
    mount(
      formWith(
        `action="/ok"`,
        `<input name="t" id="t"><select name="s" id="s"><option value="">-</option><option value="b">B</option></select>` +
          `<input type="checkbox" name="c" id="c">` +
          `<input type="radio" name="r" id="r" value="1">`,
      ),
    );
    expect(fill(item(q("#t"), "text"))).toBe("filled");
    expect(q<HTMLInputElement>("#t").value).toBe("text");
    expect(fill(item(q("#s"), "b"))).toBe("filled");
    expect(q<HTMLSelectElement>("#s").value).toBe("b");
    expect(fill(item(q("#c"), "true", "false"))).toBe("filled");
    expect(q<HTMLInputElement>("#c").checked).toBe(true);
    expect(fill(item(q("#r"), "true", "false"))).toBe("filled");
    expect(q<HTMLInputElement>("#r").checked).toBe(true);
  });

  it("fills the clobbering inputs themselves", () => {
    mount(formWith(`action="/ok"`, ""));
    for (const name of NAMES) {
      const el = q<HTMLInputElement>(`[name="${name}"]`);
      expect(fill(item(el, `v-${name}`)), name).toBe("filled");
      expect(el.value).toBe(`v-${name}`);
    }
  });

  it("gives the same canFill verdicts as a form without clobbering names", () => {
    const body = `<input name="t" id="t">`;
    const verdicts = (html: string) => {
      document.body.replaceChildren();
      mount(html);
      return [
        can(item(q("#t"), "x")),
        can(item(q("#t"), "x"), "https://evil.example"),
      ];
    };
    for (const action of [
      `action="/ok"`,
      `action="https://evil.example/p"`,
      ``,
    ]) {
      expect(verdicts(formWith(action, body)), action).toEqual(
        verdicts(`<form ${action}>${body}</form>`),
      );
    }
    expect(verdicts(formWith(`action="https://evil.example/p"`, body))).toEqual(
      [false, true],
    );
    expect(verdicts(formWith(`action="/ok"`, body))).toEqual([true, false]);
  });

  it("ignores own properties a page defined on the element (React's tracker does)", () => {
    mount(`<input name="a"><input type="checkbox" name="c">`);
    const el = q<HTMLInputElement>("[name=a]");
    const cb = q<HTMLInputElement>("[name=c]");
    const stored = { v: "" };
    Object.defineProperty(el, "value", {
      configurable: true,
      get: () => stored.v,
      set: (v: string) => {
        stored.v = `tracked:${v}`;
      },
    });
    for (const m of ["focus", "blur", "dispatchEvent", "select"] as const) {
      Object.defineProperty(el, m, {
        value: () => {
          throw new Error(m);
        },
      });
    }
    Object.defineProperty(cb, "checked", {
      get: () => false,
      configurable: true,
    });
    expect(fill(item(el, "x"))).toBe("filled");
    expect(
      Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.get?.call(el),
    ).toBe("x");
    expect(stored.v).toBe("");
  });
});

/** Page script that reverts programmatic writes and accepts typing (what a keystroke mask does). */
function revertUntrusted(el: HTMLInputElement): void {
  let accepted = el.value;
  el.addEventListener("input", (e) => {
    if (e.isTrusted) accepted = el.value;
    else el.value = accepted;
  });
}

describe("insertText fallback only writes into the vetted, focused control", () => {
  it("focus redirected to a field of a cross-origin form: the decoy stays empty", () => {
    mount(
      `<input name="a"><form action="https://evil.example/x"><input name="decoy"></form>`,
    );
    const a = q<HTMLInputElement>("[name=a]");
    const decoy = q<HTMLInputElement>("[name=decoy]");
    expect(can(item(decoy, "x"))).toBe(false); // premise
    revertUntrusted(a);
    a.addEventListener("focus", () => {
      decoy.focus();
      decoy.select();
    });
    expect(fill(item(a, "SECRET"))).toBe("rejected-by-page");
    expect(decoy.value).toBe("");
    expect(a.value).toBe("");
    expect(isFilling()).toBe(false);
  });

  it("focus redirected to a contenteditable: it stays empty", () => {
    mount(`<input name="a"><div id="ce" contenteditable="true"></div>`);
    const a = q<HTMLInputElement>("[name=a]");
    const ce = q<HTMLElement>("#ce");
    revertUntrusted(a);
    a.addEventListener("focus", () => {
      ce.focus();
    });
    expect(fill(item(a, "SECRET"))).toBe("rejected-by-page");
    expect(ce.textContent).toBe("");
    expect(a.value).toBe("");
  });

  it("validate-and-advance (blur disables the field and focuses the next): the next field stays empty", () => {
    mount(`<input name="a"><input name="next">`);
    const a = q<HTMLInputElement>("[name=a]");
    const next = q<HTMLInputElement>("[name=next]");
    revertUntrusted(a);
    a.addEventListener("blur", () => {
      a.disabled = true;
      next.focus();
    });
    expect(fill(item(a, "SECRET"))).toBe("rejected-by-page");
    expect(next.value).toBe("");
    expect(a.value).toBe("");
  });

  it("focus redirected to a sibling input in the same closed shadow root: the sibling stays empty", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "closed" });
    const a = document.createElement("input");
    a.name = "a";
    const sibling = document.createElement("input");
    sibling.name = "sibling";
    shadow.append(a, sibling);
    revertUntrusted(a);
    a.addEventListener("focus", () => {
      sibling.focus();
      sibling.select();
    });
    expect(fill(item(a, "SECRET"))).toBe("rejected-by-page");
    expect(sibling.value).toBe("");
    expect(a.value).toBe("");
  });

  it("still fills an input inside a shadow root through the fallback", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    const inner = document.createElement("input");
    inner.name = "s";
    shadow.append(inner);
    revertUntrusted(inner);
    expect(fill(item(inner, "(555) 123-4567"))).toBe("filled");
    expect(inner.value).toBe("(555) 123-4567");
  });

  it("still fills a nested shadow-root input through the fallback", () => {
    const outer = document.createElement("div");
    document.body.append(outer);
    const mid = document.createElement("div");
    outer.attachShadow({ mode: "open" }).append(mid);
    const inner = document.createElement("input");
    mid.attachShadow({ mode: "open" }).append(inner);
    revertUntrusted(inner);
    expect(fill(item(inner, "42"))).toBe("filled");
    expect(inner.value).toBe("42");
  });

  it("restore never deletes in another field when focus is redirected", () => {
    mount(`<input name="a"><input name="decoy" value="DECOY">`);
    const a = q<HTMLInputElement>("[name=a]");
    const decoy = q<HTMLInputElement>("[name=decoy]");
    const s = snapshot([item(a, "x")]);
    a.value = "later";
    revertUntrusted(a);
    a.addEventListener("focus", () => {
      decoy.focus();
      decoy.select();
    });
    restore(s);
    expect(decoy.value).toBe("DECOY");
    expect(a.value).toBe("later");
  });

  it("restore to empty goes through delete when the page reverts programmatic writes", () => {
    mount(`<input name="a">`);
    const a = q<HTMLInputElement>("[name=a]");
    const s = snapshot([item(a, "x")]);
    a.value = "filled earlier";
    revertUntrusted(a);
    restore(s);
    expect(a.value).toBe("");
  });
});

describe("rejected-by-page puts the pre-fill value back", () => {
  it("leaves no page-mangled copy of the secret", () => {
    mount(`<input name="a" value="100">`);
    const a = q<HTMLInputElement>("[name=a]");
    a.addEventListener("input", () => {
      if (a.value.includes("SECRET"))
        a.value = a.value.replace("SECRET", "S3CR3T");
    });
    expect(fill(item(a, "SECRET", "100"))).toBe("rejected-by-page");
    expect(a.value).toBe("100");
    expect(isFilling()).toBe(false);
  });
});

describe("putBack through the fill technique", () => {
  it("clears the secret even when a mask reverts programmatic writes and reformats typing", () => {
    mount(`<input name="a">`);
    const a = q<HTMLInputElement>("[name=a]");
    let accepted = "";
    a.addEventListener("input", (e) => {
      if (e.isTrusted) {
        accepted = a.value === "" ? "" : `${a.value}!`; // reformatted: never equals the vault value
        a.value = accepted;
      } else a.value = accepted;
    });
    expect(fill(item(a, "SECRET"))).toBe("rejected-by-page");
    expect(a.value).toBe("");
    expect(isFilling()).toBe(false);
  });
});

describe("fillControl re-checks the control rules right before writing", () => {
  it("skips a field that became sensitive after canFill", () => {
    mount(`<input name="a">`);
    const a = q<HTMLInputElement>("[name=a]");
    const i = item(a, "SECRET");
    const hist = history();
    expect(canFill(i, hist, origin, top)).toBe(true);
    a.setAttribute("autocomplete", "cc-csc");
    expect(fillControl(i, hist, origin, top)).toBe("skipped-ineligible");
    expect(a.value).toBe("");
  });

  it("skips a field whose form now posts cross-origin", () => {
    mount(`<form action="/ok"><input name="a"></form>`);
    const a = q<HTMLInputElement>("[name=a]");
    const i = item(a, "SECRET");
    const hist = history();
    expect(canFill(i, hist, origin, top)).toBe(true);
    q<HTMLElement>("form").setAttribute("action", "https://evil.example/p");
    expect(fillControl(i, hist, origin, top)).toBe("skipped-ineligible");
    expect(a.value).toBe("");
  });

  it("skips a field that was a password in between (show-password toggle)", () => {
    mount(`<input name="a">`);
    const hist = history();
    const a = q<HTMLInputElement>("[name=a]");
    const i = item(a, "x");
    expect(canFill(i, hist, origin, top)).toBe(true);
    a.type = "password";
    a.type = "text";
    expect(fillControl(i, hist, origin, top)).toBe("skipped-ineligible");
    expect(a.value).toBe("");
  });
});

describe("toggle values", () => {
  it("accepts exactly true and false; anything else is unsupported and not clicked", () => {
    mount(`<input type="checkbox" name="c" checked>`);
    const c = q<HTMLInputElement>("[name=c]");
    let clicks = 0;
    c.addEventListener("click", () => clicks++);
    for (const bad of ["on", "TRUE", "1", "", "yes"]) {
      expect(fill(item(c, bad, "true")), bad).toBe("unsupported");
    }
    expect(c.checked).toBe(true);
    expect(clicks).toBe(0);
  });

  it("radio false: already unchecked is satisfied, checked is unsupported; neither clicks", () => {
    mount(
      `<input type="radio" name="r" value="a" checked><input type="radio" name="r" value="b">`,
    );
    const [a, b] = Array.from(
      document.querySelectorAll<HTMLInputElement>("[name=r]"),
    ) as [HTMLInputElement, HTMLInputElement];
    let clicks = 0;
    for (const r of [a, b]) r.addEventListener("click", () => clicks++);
    expect(fill(item(b, "false", "false"))).toBe("filled");
    expect(fill(item(a, "false", "true"))).toBe("unsupported");
    expect(fill(item(b, "on", "false"))).toBe("unsupported");
    expect([a.checked, b.checked]).toEqual([true, false]);
    expect(clicks).toBe(0);
  });
});

describe("synthetic events are composed", () => {
  it("a listener on the shadow host sees input and change", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const inner = document.createElement("input");
    host.attachShadow({ mode: "open" }).append(inner);
    const seen: string[] = [];
    for (const t of ["input", "change"]) {
      host.addEventListener(t, (e) => {
        seen.push(`${e.type}:${e.composed}`);
      });
    }
    expect(fill(item(inner, "x"))).toBe("filled");
    expect(seen).toEqual(["input:true", "change:true"]);
  });
});
