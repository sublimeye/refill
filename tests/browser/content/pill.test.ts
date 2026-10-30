import { afterEach, describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import {
  createPill,
  NOTICE_MS,
  type Pill,
  type PillActions,
  type PillState,
} from "../../../src/lib/content/pill";

const pills: Pill[] = [];
const sheets: HTMLElement[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const p of pills.splice(0)) p.remove();
  for (const s of sheets.splice(0)) s.remove();
  document.body.replaceChildren();
});

function actions(finish = vi.fn()) {
  return { finish, undo: vi.fn(), unlock: vi.fn() };
}

function make(
  onFinish = vi.fn(),
  doc: Document = document,
  onChange?: (kind: PillState["kind"] | null) => void,
): Pill {
  const p = createPill(doc, actions(onFinish), onChange);
  pills.push(p);
  return p;
}

function makeWith(
  a: PillActions,
  onChange?: (kind: PillState["kind"] | null) => void,
): Pill {
  const p = createPill(document, a, onChange);
  pills.push(p);
  return p;
}

/** A real (trusted) click on the pill's button. The root is closed, so it is aimed at the host. */
async function clickButton(p: Pill): Promise<void> {
  const host = p.host.getBoundingClientRect();
  const b = button(p).getBoundingClientRect();
  await userEvent.click(p.host, {
    position: {
      x: b.left - host.left + b.width / 2,
      y: b.top - host.top + b.height / 2,
    },
  });
}

const hover = (p: Pill, type: string): void => {
  p.host.dispatchEvent(new Event(type));
};

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
    vi.advanceTimersByTime(NOTICE_MS - 1);
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
    await clickButton(p);
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

  describe("return-visit states", () => {
    it("wraps a long notice inside the viewport and keeps the button on it", () => {
      const p = make();
      p.show({ kind: "locked", fallback: false });
      const box = p.host.getBoundingClientRect();
      expect(box.width).toBeLessThanOrEqual(420);
      expect(box.right).toBeLessThanOrEqual(innerWidth);
      const b = button(p).getBoundingClientRect();
      expect(b.right).toBeLessThanOrEqual(box.right);
      expect(b.left).toBeGreaterThanOrEqual(box.left);
      expect(b.width).toBeGreaterThan(30);
    });

    const visibleButton = (p: Pill): string | null =>
      button(p).checkVisibility() ? button(p).textContent : null;

    const rows: {
      state: PillState;
      text: string;
      button: string | null;
    }[] = [
      {
        state: { kind: "filled", count: 3, ask: 0 },
        text: "Refill filled 3 fields",
        button: "Undo",
      },
      {
        state: { kind: "filled", count: 1, ask: 1 },
        text: "Refill filled 1 field · 1 needs you",
        button: "Undo",
      },
      {
        state: { kind: "filled", count: 4, ask: 2 },
        text: "Refill filled 4 fields · 2 need you",
        button: "Undo",
      },
      { state: { kind: "undone" }, text: "Fill undone", button: null },
      {
        state: { kind: "ready", count: 1 },
        text: "1 field ready — open Refill to fill",
        button: null,
      },
      {
        state: { kind: "ready", count: 5 },
        text: "5 fields ready — open Refill to fill",
        button: null,
      },
      {
        state: { kind: "locked", fallback: false },
        text: "Refill has a saved form for this site — unlock from the toolbar icon",
        button: "Unlock",
      },
      {
        state: { kind: "locked", fallback: true },
        text: "Refill has a saved form for this site — unlock from the toolbar icon",
        button: null,
      },
      {
        state: { kind: "updated" },
        text: "Refill was updated — reload this page",
        button: null,
      },
    ];

    for (const row of rows) {
      const name = JSON.stringify(row.state);
      it(`shows the copy for ${name}`, () => {
        const p = make();
        p.show(row.state);
        expect(
          p.root.querySelector('[role="status"]')!.textContent?.trim(),
        ).toBe(row.text);
        expect(p.root.textContent).toContain(
          row.state.kind === "filled" ? `✓ ${row.text}` : row.text,
        );
        expect(visibleButton(p)).toBe(row.button);
      });
    }

    it("uses a green check for filled and a red dot for recording", () => {
      const p = make();
      const glyph = () =>
        getComputedStyle(p.root.querySelector('[aria-hidden="true"]')!);
      p.show({ kind: "filled", count: 1, ask: 0 });
      expect(glyph().color).toBe("rgb(48, 209, 88)");
      p.show({ kind: "on", count: 1 });
      expect(glyph().color).toBe("rgb(255, 69, 58)");
      p.show({ kind: "undone" });
      expect(glyph().display).toBe("none");
    });

    it("keeps its own palette, with a border that shows on dark pages", () => {
      const p = make();
      p.show({ kind: "on", count: 1 });
      const bar = p.root.querySelector("div")!;
      const style = getComputedStyle(bar);
      expect(style.backgroundColor).toBe("rgb(28, 28, 30)");
      expect(style.borderTopWidth).toBe("1px");
      expect(style.borderTopColor).toBe("rgba(255, 255, 255, 0.16)");
      expect(style.transitionDuration).toBe("0s");
      expect(style.animationName).toBe("none");
    });

    it("a trusted click on Undo calls undo once, and on Unlock calls unlock once", async () => {
      const a = actions();
      const p = makeWith(a);
      p.show({ kind: "filled", count: 2, ask: 0 });
      await clickButton(p);
      expect(a.undo).toHaveBeenCalledTimes(1);
      expect(a.unlock).not.toHaveBeenCalled();
      expect(a.finish).not.toHaveBeenCalled();
      p.show({ kind: "locked", fallback: false });
      await clickButton(p);
      expect(a.unlock).toHaveBeenCalledTimes(1);
      expect(a.undo).toHaveBeenCalledTimes(1);
      expect(a.finish).not.toHaveBeenCalled();
    });

    it("a synthetic click calls nothing", () => {
      const a = actions();
      const p = makeWith(a);
      for (const state of [
        { kind: "filled", count: 2, ask: 0 },
        { kind: "locked", fallback: false },
        { kind: "on", count: 2 },
      ] satisfies PillState[]) {
        p.show(state);
        button(p).click();
        p.host.dispatchEvent(
          new MouseEvent("click", { bubbles: true, composed: true }),
        );
      }
      expect(a.finish).not.toHaveBeenCalled();
      expect(a.undo).not.toHaveBeenCalled();
      expect(a.unlock).not.toHaveBeenCalled();
    });

    it("every kind but on and full hides after NOTICE_MS; on and full stay", () => {
      vi.useFakeTimers();
      for (const row of rows) {
        const p = make();
        p.show(row.state);
        vi.advanceTimersByTime(NOTICE_MS - 1);
        expect(p.host.isConnected).toBe(true);
        vi.advanceTimersByTime(1);
        expect(p.host.isConnected).toBe(false);
      }
      const stopped = make();
      stopped.show({ kind: "stopped", reason: "expired" });
      vi.advanceTimersByTime(NOTICE_MS);
      expect(stopped.host.isConnected).toBe(false);
      for (const state of [
        { kind: "on", count: 1 },
        { kind: "full", count: 200 },
      ] satisfies PillState[]) {
        const p = make();
        p.show(state);
        vi.advanceTimersByTime(60_000);
        expect(p.host.matches(":popover-open")).toBe(true);
      }
    });

    it("a new notice restarts the clock; a timed notice replaced by on never hides", () => {
      vi.useFakeTimers();
      const p = make();
      p.show({ kind: "filled", count: 1, ask: 0 });
      vi.advanceTimersByTime(NOTICE_MS - 1000);
      p.show({ kind: "undone" });
      vi.advanceTimersByTime(NOTICE_MS - 1);
      expect(p.host.isConnected).toBe(true);
      vi.advanceTimersByTime(1);
      expect(p.host.isConnected).toBe(false);
      p.show({ kind: "undone" });
      vi.advanceTimersByTime(1000);
      p.show({ kind: "on", count: 1 });
      vi.advanceTimersByTime(60_000);
      expect(p.host.matches(":popover-open")).toBe(true);
    });

    it("hover keeps a notice open; leaving closes it a full NOTICE_MS later", () => {
      vi.useFakeTimers();
      const p = make();
      p.show({ kind: "filled", count: 1, ask: 0 });
      vi.advanceTimersByTime(NOTICE_MS - 1000);
      hover(p, "pointerenter");
      vi.advanceTimersByTime(NOTICE_MS * 3);
      expect(p.host.matches(":popover-open")).toBe(true);
      hover(p, "pointerleave");
      vi.advanceTimersByTime(NOTICE_MS - 1);
      expect(p.host.matches(":popover-open")).toBe(true);
      vi.advanceTimersByTime(1);
      expect(p.host.isConnected).toBe(false);
    });

    it("focus keeps a notice open too, and the timer waits for hover and focus both to leave", () => {
      vi.useFakeTimers();
      const p = make();
      p.show({ kind: "locked", fallback: false });
      hover(p, "focusin");
      hover(p, "pointerenter");
      vi.advanceTimersByTime(NOTICE_MS * 2);
      expect(p.host.isConnected).toBe(true);
      hover(p, "pointerleave");
      vi.advanceTimersByTime(NOTICE_MS * 2);
      expect(p.host.isConnected).toBe(true); // still focused
      hover(p, "focusout");
      vi.advanceTimersByTime(NOTICE_MS - 1);
      expect(p.host.isConnected).toBe(true);
      vi.advanceTimersByTime(1);
      expect(p.host.isConnected).toBe(false);
    });

    it("a notice shown while hovered waits for the pointer to leave", () => {
      vi.useFakeTimers();
      const p = make();
      p.show({ kind: "filled", count: 1, ask: 0 });
      hover(p, "pointerenter");
      p.show({ kind: "undone" });
      vi.advanceTimersByTime(NOTICE_MS * 2);
      expect(p.host.isConnected).toBe(true);
      hover(p, "pointerleave");
      vi.advanceTimersByTime(NOTICE_MS);
      expect(p.host.isConnected).toBe(false);
    });

    it("hover state does not outlive a hide", () => {
      vi.useFakeTimers();
      const p = make();
      p.show({ kind: "filled", count: 1, ask: 0 });
      hover(p, "pointerenter");
      p.hide();
      p.show({ kind: "undone" });
      vi.advanceTimersByTime(NOTICE_MS);
      expect(p.host.isConnected).toBe(false);
    });

    it("showing() and onChange follow show, hide and the timer", () => {
      vi.useFakeTimers();
      const onChange = vi.fn();
      const p = make(vi.fn(), document, onChange);
      expect(p.showing()).toBeNull();
      p.show({ kind: "on", count: 1 });
      expect(p.showing()).toBe("on");
      expect(onChange).toHaveBeenLastCalledWith("on");
      p.show({ kind: "filled", count: 1, ask: 0 });
      expect(p.showing()).toBe("filled");
      expect(onChange).toHaveBeenLastCalledWith("filled");
      vi.advanceTimersByTime(NOTICE_MS);
      expect(p.showing()).toBeNull();
      expect(onChange).toHaveBeenLastCalledWith(null);
      p.show({ kind: "updated" });
      p.hide();
      expect(p.showing()).toBeNull();
      expect(onChange).toHaveBeenLastCalledWith(null);
      expect(onChange.mock.calls.map((c) => c[0])).toEqual([
        "on",
        "filled",
        null,
        "updated",
        null,
      ]);
      p.remove();
      p.show({ kind: "on", count: 1 });
      expect(p.showing()).toBeNull();
    });

    it("a show the page made fail reports nothing and leaves nothing on the page", () => {
      const onChange = vi.fn();
      const p = make(vi.fn(), document, onChange);
      p.show({ kind: "undone" });
      // The host is reachable from the page: dropping `popover` closes it and makes the next
      // `showPopover` throw.
      p.host.removeAttribute("popover");
      p.show({ kind: "filled", count: 2, ask: 0 });
      expect(p.showing()).toBeNull();
      expect(p.host.isConnected).toBe(false);
      expect(onChange.mock.calls.map((c) => c[0])).toEqual(["undone", null]);
    });

    it("a throwing onChange does not break the pill", () => {
      const p = make(
        vi.fn(),
        document,
        vi.fn(() => {
          throw new Error("boom");
        }),
      );
      expect(() => p.show({ kind: "undone" })).not.toThrow();
      expect(p.host.isConnected).toBe(true);
      expect(() => p.hide()).not.toThrow();
      expect(p.host.isConnected).toBe(false);
    });
  });
});
