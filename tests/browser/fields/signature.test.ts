import { afterEach, describe, expect, it } from "vitest";
import {
  buildSignature,
  idStable,
  labelText,
  nameIdDerived,
  type FormControl,
} from "../../../src/lib/fields/signature";

function mount(html: string): HTMLElement {
  const root = document.createElement("div");
  root.innerHTML = html; // test-only fixture markup
  document.body.append(root);
  return root;
}

function control(root: HTMLElement, selector: string): FormControl {
  const el = root.querySelector<FormControl>(selector);
  if (!el) throw new Error(`no ${selector}`);
  return el;
}

afterEach(() => {
  document.body.replaceChildren();
});

describe("labelText sources", () => {
  it("label[for=id]", () => {
    const r = mount(`<label for="a">Account Number</label><input id="a">`);
    expect(labelText(control(r, "input"))).toBe("account number");
  });

  it("wrapping label", () => {
    const r = mount(`<label>Full  Name <input></label>`);
    expect(labelText(control(r, "input"))).toBe("full name");
  });

  it("wrapping label excludes the nested control's own text", () => {
    const r = mount(
      `<label>Country <select><option>Narnia</option></select></label>`,
    );
    expect(labelText(control(r, "select"))).toBe("country");
  });

  it("aria-labelledby joins several elements in order", () => {
    const r = mount(
      `<span id="p2">Line</span><span id="p1">Billing</span><input aria-labelledby="p1 p2">`,
    );
    expect(labelText(control(r, "input"))).toBe("billing line");
  });

  it("aria-labelledby ignores missing ids", () => {
    const r = mount(
      `<span id="p1">Billing</span><input aria-labelledby="nope p1">`,
    );
    expect(labelText(control(r, "input"))).toBe("billing");
  });

  it("aria-label", () => {
    const r = mount(`<input aria-label="Phone Number">`);
    expect(labelText(control(r, "input"))).toBe("phone number");
  });

  it("placeholder", () => {
    const r = mount(`<input placeholder="you@example.com">`);
    expect(labelText(control(r, "input"))).toBe("you@example.com");
  });

  it("source order: label[for] beats wrapping, aria-labelledby, aria-label, placeholder", () => {
    const r = mount(
      `<span id="x">Labelledby</span>
       <label for="a">For label</label>
       <label>Wrapping <input id="a" aria-labelledby="x" aria-label="Aria" placeholder="Ph"></label>`,
    );
    expect(labelText(control(r, "input"))).toBe("for label");
  });

  it("falls through empty sources to the next one", () => {
    const r = mount(
      `<label for="a">  *: </label><input id="a" aria-label="Fallback">`,
    );
    expect(labelText(control(r, "input"))).toBe("fallback");
  });

  it("null when there is no label source", () => {
    const r = mount(`<input>`);
    expect(labelText(control(r, "input"))).toBeNull();
  });
});

describe("labelText normalization", () => {
  it("strips trailing * and : repeatedly, lowercases, collapses whitespace", () => {
    const r = mount(
      `<label for="a">  Email\n  Address *: * </label><input id="a">`,
    );
    expect(labelText(control(r, "input"))).toBe("email address");
  });

  it("keeps digits so Address 1 and Address 2 stay distinct", () => {
    const r = mount(
      `<label for="a">Address 1</label><input id="a"><label for="b">Address 2</label><input id="b">`,
    );
    const one = labelText(control(r, "#a"));
    const two = labelText(control(r, "#b"));
    expect(one).toBe("address 1");
    expect(two).toBe("address 2");
    expect(one).not.toBe(two);
  });

  it("keeps inner colons and asterisks", () => {
    const r = mount(`<input aria-label="Ratio 1:2 *">`);
    expect(labelText(control(r, "input"))).toBe("ratio 1:2");
  });

  it("truncates to 256 chars after normalization (leading whitespace does not count)", () => {
    const r = mount(`<input>`);
    const el = control(r, "input");
    el.setAttribute("aria-label", " ".repeat(100) + "X".repeat(300) + " *");
    expect(labelText(el)).toBe("x".repeat(256));
  });

  it("a label that is only * and : yields null", () => {
    const r = mount(`<label for="a">*:</label><input id="a">`);
    expect(labelText(control(r, "input"))).toBeNull();
  });
});

describe("idStable", () => {
  it.each([
    ["", null],
    [":r1:", null],
    [":r1a:", null],
    ["«r2»", null],
    ["mat-input-3", null],
    ["field_12", null],
    ["a8f3c9e21b7d44e0", null],
    ["input-123456", null],
    ["x1234", null],
    ["ctl00_Main_Acct", "ctl00_Main_Acct"],
    [":R2a6:", null],
    ["_r_1_", null],
    ["_R_1ab_", null],
    [":r1:-form-item", null],
    [":r1:-form-item-description", null],
    ["radix-:r1:", null],
    ["radix-_r_3_", null],
    ["headlessui-input-:r5:", null],
    ["ember123", null],
    ["j_idt45", null],
    ["react-select-2-input", null],
    ["user-a8f3-c9e2-1b7d-44e0", null],
    ["f81d4fae-7dec-11d0-a765-00a0c91e6bf6", null],
    ["f81d4fae7dec11d0a76500a0c91e6bf6", null],
    ["mat-mdc-input-0", null],
    ["mui-12345", null],
    ["email", "email"],
    [
      "ctl00_ContentPlaceHolder1_txtAmount",
      "ctl00_ContentPlaceHolder1_txtAmount",
    ],
    [
      "ctl00_ContentPlaceHolder1_GridView1_ctl02_txtQty",
      "ctl00_ContentPlaceHolder1_GridView1_ctl02_txtQty",
    ],
    ["user_address_attributes_0_line1", "user_address_attributes_0_line1"],
    ["loginForm:username", "loginForm:username"],
    ["ember-field", "ember-field"],
    ["radix", "radix"],
    ["a-b-c", "a-b-c"],
    ["account-number", "account-number"],
    ["billing_address_line1", "billing_address_line1"],
    ["billingAddressLine1", "billingAddressLine1"],
    ["address-line2", "address-line2"],
    ["firstName", "firstName"],
    ["phone2", "phone2"],
    ["zip123", "zip123"],
    ["country_code", "country_code"],
  ])("%j -> %j", (id, expected) => {
    expect(idStable(id)).toBe(expected);
  });

  it("sequential <prefix>-<n> / <prefix>_<n> ids are generated even when readable", () => {
    expect(idStable("shipping-address-line-2")).toBeNull();
    expect(idStable("emergency_contact_phone_1")).toBeNull();
  });

  it("ids longer than 256 chars are dropped", () => {
    expect(idStable("a".repeat(256))).toBe("a".repeat(256));
    expect(idStable("a".repeat(257))).toBeNull();
  });

  it("a mixed letter+digit run of >= 12 chars anywhere is generated", () => {
    expect(idStable("user-a8f3c9e21b7d-name")).toBeNull();
    expect(idStable("QmFzZTY0Zm9vYmFy9x")).toBeNull();
    expect(idStable("d41d8cd98f00b204e9800998ecf8427e")).toBeNull();
  });
});

describe("nameIdDerived", () => {
  it("ASP.NET $ to _ mapping", () => {
    expect(nameIdDerived("ctl00$Main$Acct", "ctl00_Main_Acct")).toBe(true);
  });
  it("case-insensitive equality", () => {
    expect(nameIdDerived("Email", "email")).toBe(true);
  });
  it("Rails/PHP bracket names map to underscore ids", () => {
    expect(
      nameIdDerived(
        "user[address_attributes][0][line1]",
        "user_address_attributes_0_line1",
      ),
    ).toBe(true);
    expect(
      nameIdDerived(
        "user[address_attributes][0][line1]",
        "user_address_attributes_0_line2",
      ),
    ).toBe(false);
  });
  it("different values are not derived", () => {
    expect(nameIdDerived("email", "contact-email")).toBe(false);
  });
  it("empty values are not derived", () => {
    expect(nameIdDerived("", "")).toBe(false);
  });
});

describe("buildSignature", () => {
  it("assembles all parts", () => {
    const r = mount(
      `<form action="/pay/step1?x=1"><label for="n">Account *</label>
       <input id="n" name="acct" type="TEL" autocomplete="Section-Blue  Tel-National"></form>`,
    );
    const el = control(r, "input");
    expect(buildSignature(el, 2, "/pay/step1")).toEqual({
      name: "acct",
      idStable: "n",
      autocomplete: "section-blue tel-national",
      type: "tel",
      labelText: "account",
      ordinal: 2,
      formAction: "/pay/step1",
      nameIdDerived: false,
    });
  });

  it("autocomplete on / off / empty / absent -> null", () => {
    const r = mount(
      `<input id="a" autocomplete="on"><input id="b" autocomplete="OFF"><input id="c" autocomplete=""><input id="d">`,
    );
    for (const id of ["a", "b", "c", "d"]) {
      expect(
        buildSignature(control(r, `#${id}`), 0, null).autocomplete,
      ).toBeNull();
    }
  });

  it("ASP.NET name/id pair is marked derived", () => {
    const r = mount(`<input name="ctl00$Main$Acct" id="ctl00_Main_Acct">`);
    const sig = buildSignature(control(r, "input"), 0, null);
    expect(sig.nameIdDerived).toBe(true);
    expect(sig.name).toBe("ctl00$Main$Acct");
  });

  it("generated id: idStable is null; derived is still reported from the raw values", () => {
    const r = mount(`<input name=":r1:" id=":r1:">`);
    const sig = buildSignature(control(r, "input"), 0, null);
    expect(sig.idStable).toBeNull();
    expect(sig.nameIdDerived).toBe(true);
  });

  it("missing name -> null; textarea and select get their type", () => {
    const r = mount(`<textarea></textarea><select></select><input>`);
    expect(buildSignature(control(r, "textarea"), 0, null)).toMatchObject({
      name: null,
      type: "textarea",
    });
    expect(buildSignature(control(r, "select"), 0, null).type).toBe(
      "select-one",
    );
    expect(buildSignature(control(r, "input"), 0, null).type).toBe("text");
  });

  it("passes ordinal and formAction through", () => {
    const r = mount(`<input>`);
    const sig = buildSignature(control(r, "input"), 7, "/a/b");
    expect(sig.ordinal).toBe(7);
    expect(sig.formAction).toBe("/a/b");
  });
});

describe("labelText association", () => {
  it("duplicate ids: only the control the browser associates gets the label", () => {
    const r = mount(
      `<label for="d">First</label><input id="d" class="one"><input id="d" class="two">`,
    );
    expect(labelText(control(r, ".one"))).toBe("first");
    expect(labelText(control(r, ".two"))).toBeNull();
  });

  it("a label[for] that points elsewhere does not label a control nested in it", () => {
    const r = mount(
      `<label for="other">Other thing<input id="x"></label><input id="other">`,
    );
    expect(labelText(control(r, "#x"))).toBeNull();
    expect(labelText(control(r, "#other"))).toBe("other thing");
  });

  it("non-labelable controls fall back to label[for] with an escaped id", () => {
    const r = mount(
      `<label for='a"]b'>Weird</label><input type="hidden" id='a"]b'>`,
    );
    const el = control(r, "input");
    expect(el.labels).toBeNull();
    expect(labelText(el)).toBe("weird");
  });

  it("works inside a shadow root", () => {
    const host = document.createElement("div");
    document.body.append(host);
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<span id="s">Shadow Label</span><input aria-labelledby="s">`;
    const el = shadow.querySelector("input");
    if (!el) throw new Error("no input");
    expect(labelText(el)).toBe("shadow label");
  });

  it("skips hidden subtrees, script and template inside a label", () => {
    const r = mount(
      `<label for="a">Name<span hidden>secret</span><script>x</script><template>t</template></label><input id="a">`,
    );
    expect(labelText(control(r, "input"))).toBe("name");
  });
});

describe("hostile DOM", () => {
  it("5000-deep nesting inside a label completes without throwing", () => {
    const r = mount(`<label for="a"></label><input id="a">`);
    let node: Element = control(r, "label");
    for (let i = 0; i < 5000; i++) {
      const child = document.createElement("div");
      node.append(child);
      node = child;
    }
    node.append("deep text");
    const t0 = performance.now();
    const sig = buildSignature(control(r, "input"), 0, null);
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(sig.labelText).toBeNull();
  });

  it("5000 aria-labelledby refs to a 100 KB element stay bounded", () => {
    const r = mount(`<input id="a">`);
    const big = document.createElement("div");
    big.id = "big";
    big.textContent = "word ".repeat(20_000);
    r.append(big);
    control(r, "input").setAttribute(
      "aria-labelledby",
      Array(5000).fill("big").join(" "),
    );
    const t0 = performance.now();
    const t = labelText(control(r, "input"));
    expect(performance.now() - t0).toBeLessThan(1000);
    expect(t?.length).toBeLessThanOrEqual(256);
    expect(t?.startsWith("word word")).toBe(true);
  });

  it("text beyond the raw character budget is ignored", () => {
    const r = mount(`<input id="a" aria-label="Fallback">`);
    const label = document.createElement("label");
    label.htmlFor = "a";
    label.append(" ".repeat(1100) + "Late text");
    r.prepend(label);
    expect(labelText(control(r, "input"))).toBe("fallback");
  });

  it("a huge wide label is bounded", () => {
    const r = mount(`<label for="a"></label><input id="a">`);
    const label = control(r, "label");
    for (let i = 0; i < 20_000; i++) label.append(document.createElement("b"));
    const t0 = performance.now();
    labelText(control(r, "input"));
    expect(performance.now() - t0).toBeLessThan(1000);
  });

  it("buildSignature returns labelText null if label collection throws", () => {
    const r = mount(`<input id="a" name="n" placeholder="Fallback">`);
    const el = control(r, "input");
    Object.defineProperty(el, "labels", {
      get() {
        throw new Error("hostile");
      },
    });
    const sig = buildSignature(el, 3, "/x");
    expect(sig.labelText).toBeNull();
    expect(sig).toMatchObject({
      name: "n",
      idStable: "a",
      ordinal: 3,
      formAction: "/x",
    });
  });
});

describe("string caps", () => {
  it("every Sig string is <= 256; derived is computed from the full values", () => {
    const long = "n".repeat(5000);
    const r = mount(`<input>`);
    const el = control(r, "input");
    el.setAttribute("name", long);
    el.id = long;
    el.setAttribute("autocomplete", `section-${"x".repeat(4000)}`);
    const sig = buildSignature(el, 0, "/p".repeat(3000));
    expect(sig.name).toBe("n".repeat(256));
    expect(sig.idStable).toBeNull();
    expect(sig.autocomplete?.length).toBe(256);
    expect(sig.formAction?.length).toBe(256);
    expect(sig.nameIdDerived).toBe(true);
    for (const v of Object.values(sig)) {
      if (typeof v === "string") expect(v.length).toBeLessThanOrEqual(256);
    }
  });
});
