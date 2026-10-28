// Review-page logic (spec §6.2, ADR 0033): reading the session id, loading, checking the form,
// building the save request and mapping the worker's answers.
import { fakeBrowser } from "wxt/testing/fake-browser";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReviewModel } from "../../../src/lib/recorder/profile";
import {
  checkForm,
  discardReview,
  initialForm,
  loadReview,
  saveReview,
  sessionIdFrom,
  stepNumber,
} from "../../../src/lib/recorder/review-flow";

const ID = "sess_0123456789abcdefgh";

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

describe("sessionIdFrom", () => {
  it("reads a valid session id from the query", () => {
    expect(sessionIdFrom(`?session=${ID}`)).toBe(ID);
    expect(sessionIdFrom(`?x=1&session=${ID}`)).toBe(ID);
  });

  it("anything else is null", () => {
    for (const q of ["", "?session=", "?session=a%7Cb", "?other=" + ID]) {
      expect(sessionIdFrom(q)).toBeNull();
    }
    expect(sessionIdFrom("?session=" + "x".repeat(65))).toBeNull();
  });
});

describe("loadReview", () => {
  it("no session id is gone without asking the worker", async () => {
    expect(await loadReview(null)).toEqual({ state: "gone" });
    expect(sent).toEqual([]);
  });

  it("asks for the session and passes the answer on", async () => {
    answer = { state: "ready", model, replacesProfile: true };
    expect(await loadReview(ID)).toEqual(answer);
    expect(sent).toEqual([{ type: "review-load", sessionId: ID }]);
  });

  it("a messaging failure is failed", async () => {
    answer = new Error("no receiver");
    expect(await loadReview(ID)).toEqual({ state: "failed" });
    answer = { ok: false, error: "rejected" };
    expect(await loadReview(ID)).toEqual({ state: "failed" });
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
    expect(await saveReview(ID, form)).toBe("saved");
    expect(sent).toEqual([
      {
        type: "review-save",
        sessionId: ID,
        name: "Bills",
        fillMode: "auto",
        pathPrefix: "/billpay/",
        policies: [
          { fieldId: "f1", policy: "save" },
          { fieldId: "f2", policy: "skip" },
        ],
      },
    ]);
  });

  it("a form problem is answered without asking the worker", async () => {
    const form = initialForm(model);
    expect(await saveReview(ID, { ...form, name: " " })).toBe("name");
    expect(await saveReview(ID, { ...form, pathPrefix: "pay" })).toBe("path");
    expect(sent).toEqual([]);
  });

  it("maps gone, invalid (the prefix misses a page) and failures", async () => {
    const form = initialForm(model);
    answer = { ok: false, error: "gone" };
    expect(await saveReview(ID, form)).toBe("gone");
    answer = { ok: false, error: "invalid" };
    expect(await saveReview(ID, form)).toBe("path");
    answer = { ok: false, error: "internal" };
    expect(await saveReview(ID, form)).toBe("failed");
    answer = new Error("closed");
    expect(await saveReview(ID, form)).toBe("failed");
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
