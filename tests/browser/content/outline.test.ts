import { afterEach, describe, expect, it } from "vitest";
import { createOutlines } from "../../../src/lib/content/outline";

afterEach(() => {
  document.body.replaceChildren();
});

function input(style = ""): HTMLInputElement {
  const el = document.createElement("input");
  if (style !== "") el.setAttribute("style", style);
  document.body.append(el);
  return el;
}

describe("ask outline", () => {
  it("outlines a control once, as important inline declarations", () => {
    const o = createOutlines();
    const el = input();
    expect(o.add(el)).toBe(true);
    expect(el.style.getPropertyValue("outline")).toBe(
      "rgb(10, 132, 255) solid 2px",
    );
    expect(el.style.getPropertyPriority("outline")).toBe("important");
    expect(el.style.getPropertyValue("outline-offset")).toBe("2px");
    expect(el.style.getPropertyPriority("outline-offset")).toBe("important");
    expect(getComputedStyle(el).outlineStyle).toBe("solid");
    expect(o.add(el)).toBe(false);
    expect(o.count()).toBe(1);
  });

  it("release puts back the page's own inline outline", () => {
    const o = createOutlines();
    const el = input("outline: 1px dotted red !important; color: blue");
    o.add(el);
    expect(el.style.getPropertyValue("outline-style")).toBe("solid");
    o.release(el);
    expect(el.style.getPropertyValue("outline")).toBe("red dotted 1px");
    expect(el.style.getPropertyPriority("outline")).toBe("important");
    expect(el.style.getPropertyValue("outline-offset")).toBe("");
    expect(el.style.getPropertyValue("color")).toBe("blue");
    expect(o.count()).toBe(0);
  });

  it("release without a page outline leaves no outline declarations", () => {
    const o = createOutlines();
    const el = input("outline-color: green");
    o.add(el);
    o.release(el);
    expect(el.style.getPropertyValue("outline-color")).toBe("green");
    expect(el.style.getPropertyValue("outline-style")).toBe("");
    expect(el.style.getPropertyValue("outline-width")).toBe("");
    expect(el.style.getPropertyValue("outline-offset")).toBe("");
    o.release(el); // not outlined any more: nothing happens
  });

  it("does not count a control the page removed", () => {
    const o = createOutlines();
    const a = input();
    const b = input();
    o.add(a);
    o.add(b);
    a.remove();
    expect(o.count()).toBe(1);
    expect(a.style.getPropertyValue("outline")).toBe("");
  });

  it("clear releases every outline", () => {
    const o = createOutlines();
    const a = input();
    const b = input();
    o.add(a);
    o.add(b);
    expect(o.count()).toBe(2);
    o.clear();
    expect(o.count()).toBe(0);
    expect(a.style.getPropertyValue("outline")).toBe("");
    expect(b.style.getPropertyValue("outline")).toBe("");
  });
});
