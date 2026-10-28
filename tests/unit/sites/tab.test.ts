import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it } from "vitest";
import { tabShowsOrigin } from "../../../src/lib/sites/tab";
import { installShims } from "../helpers/browser-shims";

const A = "https://a.example";

let shims: ReturnType<typeof installShims>;

beforeEach(() => {
  fakeBrowser.reset();
  shims = installShims();
});

describe("tabShowsOrigin", () => {
  it("is true when the tab's URL has exactly this origin", async () => {
    shims.setTab(1, A + "/path?q=1#frag");
    expect(await tabShowsOrigin(1, A)).toBe(true);
  });

  it("is false for another origin, port, scheme or lookalike host", async () => {
    for (const url of [
      "https://b.example/",
      "https://a.example:8443/",
      "http://a.example/",
      "https://a.example.evil.test/",
      "https://sub.a.example/",
      "about:blank",
      "chrome://newtab/",
    ]) {
      shims.setTab(1, url);
      expect(await tabShowsOrigin(1, A), url).toBe(false);
    }
  });

  it("is false when the URL is unreadable (undefined) or empty", async () => {
    shims.setTab(1, undefined);
    expect(await tabShowsOrigin(1, A)).toBe(false);
    shims.setTab(1, "");
    expect(await tabShowsOrigin(1, A)).toBe(false);
  });

  it("is false, never a throw, when the tab is gone or tabs.get fails", async () => {
    expect(await tabShowsOrigin(404, A)).toBe(false);
    shims.setTab(2, A + "/");
    shims.closeTab(2);
    expect(await tabShowsOrigin(2, A)).toBe(false);
  });
});
