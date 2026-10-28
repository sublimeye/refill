// The fill plan while recording: values come from the session body, never from the stored profile
// (Record again seeds the body from it). Same matcher and policy rule as Plan 2's fill (ADR 0025):
// every field takes part in matching, only `save` fields are returned. Pure. ADR 0028.
import { matchControls } from "../match/match";
import type { FillItem, ScanControl } from "../messaging/content-protocol";
import type { RecBody } from "./types";

export function recordingPlan(
  body: RecBody,
  controls: ScanControl[],
): FillItem[] {
  const matched = matchControls(body.fields, body.steps, controls);
  const items: FillItem[] = [];
  for (const field of body.fields) {
    const i = matched.get(field.id);
    if (i === undefined || field.policy !== "save") continue;
    items.push({
      fieldId: field.id,
      i,
      kind: field.kind,
      value: field.value,
      pageDefault: field.pageDefault,
    });
  }
  return items;
}
