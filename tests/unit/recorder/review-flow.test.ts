// Review-page logic (spec §6.2, ADR 0033; saved mode, ADR 0035): reading the page key, loading,
// checking the form, building the save request and mapping the worker's answers.
import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewModel } from "../../../src/lib/recorder/profile";
import {
  applyLoad,
  checkForm,
  discardReview,
  displayValue,
  endReview,
  initialForm,
  loadReview,
  newPage,
  recheckReview,
  notSaved,
  pageKeyFrom,
  saveReview,
  stepNumber,
  toggleValue,
  type PageKey,
  type ReviewPage,
} from "../../../src/lib/recorder/review-flow";

const ID = "sess_0123456789abcdefgh";
const PID = "prof_0123456789abcdefgh";
const REVIEW: PageKey = { mode: "review", id: ID };
const SAVED: PageKey = { mode: "saved", id: PID };

const model: ReviewModel = {
  origin: "https://pay.example.com",
  host: "pay.example.com",
  steps: [
    { index: 3, pathHint: "/billpay/one" },
    { index: 0, pathHint: "/billpay/two" },
  ],
  fields: [
    {
      id: "f1",
      step: 3,
      label: "Account",
      kind: "text",
      value: "12345",
      policy: "save",
    },
    {
      id: "f2",
      step: 0,
      label: "Amount",
      kind: "text",
      value: "45.12",
      policy: "ask",
    },
  ],
  name: "pay.example.com",
  pathPrefix: "/billpay/",
  fillMode: "gesture",
};

let answer: unknown;
let sent: unknown[];

beforeEach(() => {
  fakeBrowser.reset();
  sent = [];
  answer = { ok: true };
  vi.spyOn(fakeBrowser.runtime, "sendMessage").mockImplementation(((
    msg: unknown,
  ) => {
    sent.push(msg);
    return answer instanceof Error
      ? Promise.reject(answer)
      : Promise.resolve(answer);
  }) as never);
});

describe("pageKeyFrom", () => {
  it("reads a valid session id (review) or profile id (saved mode) from the query", () => {
    expect(pageKeyFrom(`?session=${ID}`)).toEqual(REVIEW);
    expect(pageKeyFrom(`?x=1&session=${ID}`)).toEqual(REVIEW);
    expect(pageKeyFrom(`?saved=${PID}`)).toEqual(SAVED);
  });

  it("anything else is null, and so is a query naming both", () => {
    for (const q of [
      "",
      "?session=",
      "?session=a%7Cb",
      "?saved=",
      "?saved=a%7Cb",
      "?other=" + ID,
      `?session=${ID}&saved=${PID}`,
      `?session=${ID}&session=${ID}`,
    ]) {
      expect(pageKeyFrom(q)).toBeNull();
    }
    expect(pageKeyFrom("?session=" + "x".repeat(65))).toBeNull();
    expect(pageKeyFrom("?saved=" + "x".repeat(65))).toBeNull();
  });
});

describe("loadReview", () => {
  it("no key is gone without asking the worker", async () => {
    expect(await loadReview(null)).toEqual({ state: "gone" });
    expect(sent).toEqual([]);
  });

  it("asks for the session and passes the answer on", async () => {
    answer = { state: "ready", model, replacesProfile: true };
    expect(await loadReview(REVIEW)).toEqual(answer);
    expect(sent).toEqual([{ type: "review-load", sessionId: ID }]);
  });

  it("saved mode asks for the saved form; it replaces nothing", async () => {
    answer = { state: "ready", model };
    expect(await loadReview(SAVED)).toEqual({
      state: "ready",
      model,
      replacesProfile: false,
    });
    expect(sent).toEqual([{ type: "saved-load", profileId: PID }]);
    answer = { state: "gone" };
    expect(await loadReview(SAVED)).toEqual({ state: "gone" });
  });

  it("a messaging failure is failed", async () => {
    for (const key of [REVIEW, SAVED]) {
      answer = new Error("no receiver");
      expect(await loadReview(key)).toEqual({ state: "failed" });
      answer = { ok: false, error: "rejected" };
      expect(await loadReview(key)).toEqual({ state: "failed" });
    }
  });
});

describe("the form", () => {
  it("starts from the model", () => {
    expect(initialForm(model)).toEqual({
      name: "pay.example.com",
      fillMode: "gesture",
      pathPrefix: "/billpay/",
      policies: [
        { fieldId: "f1", policy: "save" },
        { fieldId: "f2", policy: "ask" },
      ],
    });
  });

  it("numbers steps by their place in the recording, not their index", () => {
    expect(stepNumber(model, 3)).toBe(1);
    expect(stepNumber(model, 0)).toBe(2);
  });

  it("a blank name, then a path that does not start with /", () => {
    const form = initialForm(model);
    expect(checkForm(form)).toBeNull();
    expect(checkForm({ ...form, name: "  " })).toBe("name");
    expect(checkForm({ ...form, name: "", pathPrefix: "x" })).toBe("name");
    expect(checkForm({ ...form, pathPrefix: "billpay/" })).toBe("path");
    expect(checkForm({ ...form, pathPrefix: "" })).toBe("path");
  });
});

describe("saveReview", () => {
  it("sends the trimmed name, the mode, the prefix and every field's policy", async () => {
    const form = initialForm(model);
    form.name = "  Bills ";
    form.fillMode = "auto";
    form.policies[1]!.policy = "skip";
    expect(await saveReview(REVIEW, form)).toBe("saved");
    expect(await saveReview(SAVED, form)).toBe("saved");
    const edit = {
      name: "Bills",
      fillMode: "auto",
      pathPrefix: "/billpay/",
      policies: [
        { fieldId: "f1", policy: "save" },
        { fieldId: "f2", policy: "skip" },
      ],
    };
    expect(sent).toEqual([
      { type: "review-save", sessionId: ID, ...edit },
      { type: "saved-save", profileId: PID, ...edit },
    ]);
  });

  it("a form problem is answered without asking the worker", async () => {
    const form = initialForm(model);
    expect(await saveReview(REVIEW, { ...form, name: " " })).toBe("name");
    expect(await saveReview(SAVED, { ...form, pathPrefix: "pay" })).toBe(
      "path",
    );
    expect(sent).toEqual([]);
  });

  it("maps gone, invalid (the prefix misses a page) and failures", async () => {
    const form = initialForm(model);
    for (const key of [REVIEW, SAVED]) {
      answer = { ok: false, error: "gone" };
      expect(await saveReview(key, form)).toBe("gone");
      answer = { ok: false, error: "invalid" };
      expect(await saveReview(key, form)).toBe("path");
      answer = { ok: false, error: "internal" };
      expect(await saveReview(key, form)).toBe("failed");
      answer = new Error("closed");
      expect(await saveReview(key, form)).toBe("failed");
    }
  });
});

describe("discardReview", () => {
  it("asks the worker to discard that session", async () => {
    expect(await discardReview(ID)).toBe(true);
    expect(sent).toEqual([{ type: "review-discard", sessionId: ID }]);
    answer = new Error("closed");
    expect(await discardReview(ID)).toBe(false);
  });
});

describe("displayValue", () => {
  it("checkboxes and radios read as words; other values as they are", () => {
    const f = (kind: ReviewModel["fields"][number]["kind"], value: string) =>
      displayValue({ ...model.fields[0]!, kind, value });
    expect(f("checkbox", "true")).toBe("Checked");
    expect(f("checkbox", "false")).toBe("Not checked");
    expect(f("radio", "true")).toBe("Selected");
    expect(f("text", "true")).toBe("true");
    expect(f("select", "CA")).toBe("CA");
  });
});

describe("the page state", () => {
  function ready(): ReviewPage {
    const page = newPage();
    applyLoad(page, { state: "ready", model, replacesProfile: false });
    return page;
  }

  it("a load fills the page; a gone or failed load keeps nothing", () => {
    const page = ready();
    expect(page).toMatchObject({ view: "ready", model, shown: [false, false] });
    expect(page.form).toEqual(initialForm(model));
    const gone = newPage();
    applyLoad(gone, { state: "gone" });
    expect(gone).toMatchObject({ view: "gone", model: null, form: null });
  });

  it("Show asks the worker first and reveals only on ready", async () => {
    const page = ready();
    answer = { state: "ready" };
    expect(await toggleValue(page, REVIEW, 1)).toBe("shown");
    expect(sent).toEqual([{ type: "review-check", sessionId: ID }]);
    expect(page.shown).toEqual([false, true]);
  });

  it("Hide needs no check", async () => {
    const page = ready();
    page.shown[0] = true;
    expect(await toggleValue(page, REVIEW, 0)).toBe("hidden");
    expect(page.shown).toEqual([false, false]);
    expect(sent).toEqual([]);
  });

  it("Show after a lock: gone drops the model, the form and every shown value", async () => {
    const page = ready();
    page.shown[0] = true;
    answer = { state: "gone" };
    expect(await toggleValue(page, REVIEW, 1)).toBe("gone");
    expect(page).toEqual({
      view: "gone",
      model: null,
      replacesProfile: false,
      form: null,
      shown: [],
    });
  });

  it("a failed check reveals nothing and keeps the page", async () => {
    const page = ready();
    answer = new Error("closed");
    expect(await toggleValue(page, REVIEW, 0)).toBe("failed");
    expect(page.shown).toEqual([false, false]);
    expect(page.model).toBe(model);
  });

  it("a page that ended while the check ran reveals nothing", async () => {
    const page = ready();
    vi.mocked(fakeBrowser.runtime.sendMessage).mockImplementationOnce((() => {
      endReview(page, "saved");
      return Promise.resolve({ state: "ready" });
    }) as never);
    expect(await toggleValue(page, REVIEW, 0)).toBe("hidden");
    expect(page).toMatchObject({ view: "saved", model: null, shown: [] });
  });

  it("back to the page: gone ends the review, ready keeps it, other views are not asked", async () => {
    const page = ready();
    answer = { state: "ready" };
    expect(await recheckReview(page, REVIEW)).toBe(false);
    expect(page.view).toBe("ready");
    answer = { state: "gone" };
    expect(await recheckReview(page, REVIEW)).toBe(true);
    expect(page).toMatchObject({ view: "gone", model: null, form: null });
    sent = [];
    expect(await recheckReview(page, REVIEW)).toBe(false);
    expect(sent).toEqual([]);
  });
});

describe("saved mode on the page (ADR 0035)", () => {
  function ready(): ReviewPage {
    const page = newPage();
    applyLoad(page, { state: "ready", model, replacesProfile: false });
    return page;
  }

  it("Show asks saved-check first and reveals only on ready", async () => {
    const page = ready();
    answer = { state: "ready" };
    expect(await toggleValue(page, SAVED, 0)).toBe("shown");
    expect(sent).toEqual([{ type: "saved-check", profileId: PID }]);
    expect(page.shown).toEqual([true, false]);
  });

  it("gone (a lock, a removed site) drops the model, the form and every shown value", async () => {
    const page = ready();
    page.shown[0] = true;
    answer = { state: "gone" };
    expect(await recheckReview(page, SAVED)).toBe(true);
    expect(sent).toEqual([{ type: "saved-check", profileId: PID }]);
    expect(page).toEqual({
      view: "gone",
      model: null,
      replacesProfile: false,
      form: null,
      shown: [],
    });
  });

  it("a field that holds nothing and does not fill is Not saved, only in saved mode", () => {
    const skip = { ...model.fields[0]!, value: "", policy: "skip" as const };
    const emptyAsk = { ...model.fields[1]!, value: "", policy: "ask" as const };
    expect(notSaved(SAVED, skip)).toBe(true);
    // Don't save, then Ask me: still nothing to fill (F2).
    expect(notSaved(SAVED, emptyAsk)).toBe(true);
    expect(notSaved(SAVED, model.fields[0]!)).toBe(false);
    expect(notSaved(SAVED, model.fields[1]!)).toBe(false); // ask with a value
    // A Fill it in field keeps its row as it is, even an empty one.
    expect(notSaved(SAVED, { ...model.fields[0]!, value: "" })).toBe(false);
    expect(notSaved(REVIEW, skip)).toBe(false);
    expect(notSaved(REVIEW, emptyAsk)).toBe(false);
    expect(notSaved(null, skip)).toBe(false);
  });

  it("Show of an Ask me field that holds nothing reveals nothing and asks nothing", async () => {
    const page = newPage();
    const m = {
      ...model,
      fields: [{ ...model.fields[1]!, value: "", policy: "ask" as const }],
    };
    applyLoad(page, { state: "ready", model: m, replacesProfile: false });
    expect(await toggleValue(page, SAVED, 0)).toBe("hidden");
    expect(sent).toEqual([]);
  });

  it("Show of a Not saved field reveals nothing and asks nothing", async () => {
    const page = newPage();
    const m = {
      ...model,
      fields: [{ ...model.fields[0]!, value: "", policy: "skip" as const }],
    };
    applyLoad(page, { state: "ready", model: m, replacesProfile: false });
    expect(await toggleValue(page, SAVED, 0)).toBe("hidden");
    expect(page.shown).toEqual([false]);
    expect(sent).toEqual([]);
  });

  it("Close ends the page with nothing kept", () => {
    const page = ready();
    page.shown[1] = true;
    endReview(page, "closed");
    expect(page).toEqual({
      view: "closed",
      model: null,
      replacesProfile: false,
      form: null,
      shown: [],
    });
  });
});
