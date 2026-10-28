// Review-page logic (spec §6.2), kept out of the Svelte component so it is unit-testable: the
// session id from the page URL, loading, the page state and the reveal check, the form checks the
// page can make itself, the save request and what the worker's answers mean. Decisions: ADR 0033.
import { sendToSw, type ReviewLoadResult } from "../messaging/protocol";
import { ID_RE, type FieldPolicy } from "../profiles/types";
import type { ReviewModel } from "./profile";

/** The `session` query parameter when it is a session id, else null. */
export function sessionIdFrom(search: string): string | null {
  const id = new URLSearchParams(search).get("session");
  return id !== null && ID_RE.test(id) ? id : null;
}

export type ReviewLoad = ReviewLoadResult | { state: "failed" };

/** No id, or a session the worker no longer has, is `gone`; a messaging failure is `failed`. */
export async function loadReview(
  sessionId: string | null,
): Promise<ReviewLoad> {
  if (sessionId === null) return { state: "gone" };
  try {
    const res = await sendToSw({ type: "review-load", sessionId });
    return res.state === "ready" || res.state === "gone"
      ? res
      : { state: "failed" };
  } catch {
    return { state: "failed" };
  }
}

export interface ReviewForm {
  name: string;
  fillMode: "auto" | "gesture";
  pathPrefix: string;
  /** One entry per field of the model, in its order. */
  policies: { fieldId: string; policy: FieldPolicy }[];
}

export function initialForm(model: ReviewModel): ReviewForm {
  return {
    name: model.name,
    fillMode: model.fillMode,
    pathPrefix: model.pathPrefix,
    policies: model.fields.map((f) => ({ fieldId: f.id, policy: f.policy })),
  };
}

/** The step's place in the recording (1 = the first page), whatever its stored index. */
export function stepNumber(model: ReviewModel, step: number): number {
  return model.steps.findIndex((s) => s.index === step) + 1;
}

export type FormProblem = "name" | "path";

/** What the page can tell on its own; whether the prefix covers every page is the worker's check. */
export function checkForm(form: ReviewForm): FormProblem | null {
  if (form.name.trim().length === 0) return "name";
  if (!form.pathPrefix.startsWith("/")) return "path";
  return null;
}

export type SaveOutcome = "saved" | "gone" | "failed" | FormProblem;

export async function saveReview(
  sessionId: string,
  form: ReviewForm,
): Promise<SaveOutcome> {
  const problem = checkForm(form);
  if (problem !== null) return problem;
  try {
    const res = await sendToSw({
      type: "review-save",
      sessionId,
      name: form.name.trim(),
      fillMode: form.fillMode,
      pathPrefix: form.pathPrefix,
      policies: form.policies.map((p) => ({
        fieldId: p.fieldId,
        policy: p.policy,
      })),
    });
    if (res.ok) return "saved";
    // The name and the policies were checked here and come from the model, so an invalid save is
    // a prefix that does not cover every recorded page.
    if (res.error === "gone") return "gone";
    if (res.error === "invalid") return "path";
    return "failed";
  } catch {
    return "failed";
  }
}

export async function discardReview(sessionId: string): Promise<boolean> {
  try {
    await sendToSw({ type: "review-discard", sessionId });
    return true;
  } catch {
    return false;
  }
}

/** How a value reads in the table: checkbox and radio values are words, not "true"/"false". */
export function displayValue(field: ReviewModel["fields"][number]): string {
  if (field.kind === "checkbox") {
    return field.value === "true" ? "Checked" : "Not checked";
  }
  // A recorded radio is always the chosen option (ADR 0028 stores only `"true"`).
  if (field.kind === "radio") return "Selected";
  return field.value;
}

export type ReviewView =
  "loading" | "ready" | "saved" | "gone" | "discarded" | "failed";

/** What the page holds. The component keeps it in one `$state` object and renders from it. */
export interface ReviewPage {
  view: ReviewView;
  model: ReviewModel | null;
  replacesProfile: boolean;
  form: ReviewForm | null;
  /** Per field of the model: its value is revealed. */
  shown: boolean[];
}

export function newPage(): ReviewPage {
  return {
    view: "loading",
    model: null,
    replacesProfile: false,
    form: null,
    shown: [],
  };
}

/** Ends the review: nothing of the recording stays on the page. */
export function endReview(
  page: ReviewPage,
  view: Exclude<ReviewView, "ready">,
): void {
  page.view = view;
  page.model = null;
  page.replacesProfile = false;
  page.form = null;
  page.shown = [];
}

export function applyLoad(page: ReviewPage, res: ReviewLoad): void {
  if (res.state !== "ready") {
    endReview(page, res.state);
    return;
  }
  page.view = "ready";
  page.model = res.model;
  page.replacesProfile = res.replacesProfile;
  page.form = initialForm(res.model);
  page.shown = res.model.fields.map(() => false);
}

/** Whether the page may still show the recording; `failed` on a messaging failure. */
async function checkReview(
  sessionId: string,
): Promise<"ready" | "gone" | "failed"> {
  try {
    const res = await sendToSw({ type: "review-check", sessionId });
    return res.state === "ready" || res.state === "gone" ? res.state : "failed";
  } catch {
    return "failed";
  }
}

/**
 * Show or Hide field `i`'s value. Hide needs nothing. Show asks the worker first and reveals only
 * on `ready` (ruling P15): after a lock, an expiry or a cancel the answer is `gone` and the review
 * ends, dropping every value the page held. A page that ended while the check ran reveals nothing.
 */
export async function toggleValue(
  page: ReviewPage,
  sessionId: string,
  i: number,
): Promise<"shown" | "hidden" | "gone" | "failed"> {
  if (page.view !== "ready" || i < 0 || i >= page.shown.length) return "hidden";
  if (page.shown[i]) {
    page.shown[i] = false;
    return "hidden";
  }
  const res = await checkReview(sessionId);
  if (res === "gone") {
    endReview(page, "gone");
    return "gone";
  }
  if (res === "failed") return "failed";
  if (page.view !== "ready" || i >= page.shown.length) return "hidden";
  page.shown[i] = true;
  return "shown";
}

/**
 * When the page becomes visible again: a review the worker no longer backs ends (`true`). A
 * messaging failure keeps the page; the next Show asks again.
 */
export async function recheckReview(
  page: ReviewPage,
  sessionId: string,
): Promise<boolean> {
  if (page.view !== "ready") return false;
  if ((await checkReview(sessionId)) !== "gone" || page.view !== "ready") {
    return false;
  }
  endReview(page, "gone");
  return true;
}
