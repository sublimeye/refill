// Review-page logic (spec §6.2), kept out of the Svelte component so it is unit-testable: the
// session id from the page URL, loading, the form checks the page can make itself, the save
// request and what the worker's answers mean. Decisions: ADR 0033.
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
