import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import {
  createPill,
  STOPPED_PILL_MS,
  type Pill,
} from "../../../src/lib/content/pill";

const pills: Pill[] = [];
const sheets: HTMLElement[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const p of pills.splice(0)) p.remove();
  for (const s of sheets.splice(0)) s.remove();
  document.body.replaceChildren();
});

function make(onFinish = vi.fn(), doc: Document = document): Pill {
  const p = createPill(doc, onFinish);
  pills.push(p);
  return p;
}

function pageCss(text: string): void {
  const style = document.createElement("style");
  style.textContent = text; // test-only page stylesheet
  document.head.append(style);
  sheets.push(style);
}

const button = (p: Pill) => p.root.querySelector("button")!;
const text = (p: Pill) => p.root.textContent;

describe("pill", () => {
  it("is a manual popover in the top layer, with a closed root and no input", () => {
    const p = make();
    p.show({ kind: "on", count: 3 });
    expect(p.host.isConnected).toBe(true);
    expect(p.host.getAttribute("popover")).toBe("manual");
    expect(p.host.matches(":popover-open")).toBe(true);
    // Closed: the page cannot reach the root through the host.
    expect(p.host.shadowRoot).toBeNull();
    expect(p.root.mode).toBe("closed");
    expect(
      p.root.querySelector("input, textarea, select, [contenteditable]"),
    ).toBeNull();
    // CSSOM only: no style element in the root, no markup-set style attribute on the host before
    // CSSOM wrote it (the attribute mirrors the inline declarations).
    expect(p.root.querySelector("style")).toBeNull();
  });

  it("shows the copy for each state", () => {
    const p = make();
    p.show({ kind: "on", count: 1 });
    expect(text(p)).toContain("● Recording · 1 field");
    expect(text(p)).not.toContain("1 fields");
    expect(button(p).textContent).toBe("Finish");
    p.show({ kind: "on", count: 3 });
    expect(text(p)).toContain("● Recording · 3 fields");
    p.show({ kind: "full", count: 200 });
    expect(text(p)).toContain("● Recording is full · 200 fields");
    expect(button(p).checkVisibility()).toBe(true);
    p.show({ kind: "stopped", reason: "locked" });
    expect(text(p)).toContain("Recording stopped — vault locked");
    expect(button(p).checkVisibility()).toBe(false);
    p.show({ kind: "stopped", reason: "expired" });
    expect(text(p)).toContain("Recording stopped after 30 minutes");
  });

  it("hides a stopped notice after six seconds", () => {
    vi.useFakeTimers();
    const p = make();
    p.show({ kind: "stopped", reason: "locked" });
    vi.advanceTimersByTime(STOPPED_PILL_MS - 1);
    expect(p.host.matches(":popover-open")).toBe(true);
    vi.advanceTimersByTime(1);
    expect(p.host.isConnected).toBe(false);
  });

  it("hide takes the host off the page; remove keeps it off", () => {
    const p = make();
    p.show({ kind: "on", count: 0 });
    p.hide();
    expect(p.host.isConnected).toBe(false);
    p.show({ kind: "on", count: 0 });
    expect(p.host.matches(":popover-open")).toBe(true);
    p.remove();
    p.show({ kind: "on", count: 0 });
    expect(p.host.isConnected).toBe(false);
  });

  it("a synthetic click does not finish; the user's click does", async () => {
    const onFinish = vi.fn();
    const p = make(onFinish);
    p.show({ kind: "on", count: 2 });
    button(p).click();
    button(p).dispatchEvent(
      new MouseEvent("click", { bubbles: true, composed: true }),
    );
    p.host.click();
    expect(onFinish).not.toHaveBeenCalled();
    // A real (trusted) click at the button's position. The root is closed, so the click is aimed
    // at the host with an offset.
    const host = p.host.getBoundingClientRect();
    const b = button(p).getBoundingClientRect();
    await userEvent.click(p.host, {
      position: {
        x: b.left - host.left + b.width / 2,
        y: b.top - host.top + b.height / 2,
      },
    });
    expect(onFinish).toHaveBeenCalledTimes(1);
  });

  it("renders at the top right under page CSS `* { all: unset }`", () => {
    pageCss(
      `* { all: unset !important; } div { display: none !important; } ` +
        `[popover] { inset: 0 !important; color: transparent !important; font-size: 1px !important; }`,
    );
    const p = make();
    p.show({ kind: "on", count: 4 });
    const box = p.host.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(80);
    expect(box.height).toBeGreaterThan(20);
    expect(box.top).toBeLessThan(40);
    expect(innerWidth - box.right).toBeLessThan(40);
    const hostStyle = getComputedStyle(p.host);
    expect(hostStyle.position).toBe("fixed");
    expect(hostStyle.fontSize).toBe("13px");
    expect(getComputedStyle(button(p)).display).not.toBe("none");
    expect(button(p).getBoundingClientRect().width).toBeGreaterThan(30);
    expect(getComputedStyle(button(p)).backgroundColor).toBe(
      "rgb(255, 255, 255)",
    );
    const label = p.root.querySelector('[role="status"]')!;
    expect(getComputedStyle(label).color).toBe("rgb(255, 255, 255)");
  });

  it("renders under a page CSP of style-src 'none'", async () => {
    const frame = document.createElement("iframe");
    frame.srcdoc =
      `<!doctype html><meta http-equiv="Content-Security-Policy" content="style-src 'none'">` +
      `<p>page</p>`;
    document.body.append(frame);
    await new Promise((r) => frame.addEventListener("load", r, { once: true }));
    const doc = frame.contentDocument!;
    // The policy is in force: markup styles are blocked.
    const probe = doc.createElement("p");
    probe.setAttribute("style", "color: rgb(1, 2, 3)");
    doc.body.append(probe);
    expect(getComputedStyle(probe).color).not.toBe("rgb(1, 2, 3)");

    const p = make(vi.fn(), doc);
    p.show({ kind: "on", count: 1 });
    expect(p.host.matches(":popover-open")).toBe(true);
    const style = frame.contentWindow!.getComputedStyle(p.host);
    expect(style.position).toBe("fixed");
    expect(style.fontSize).toBe("13px");
    expect(p.host.getBoundingClientRect().width).toBeGreaterThan(80);
  });
});
