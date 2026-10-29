# 0034 Path scope: case-insensitive paths and an off-path fingerprint gate

## Context

A saved form never filled again on a real SPA (heartlandpaymentservices.net, a React app). Opening
`/WebPayments/GreatOaksWaterCo/bills` renders the form, then the client-side router rewrites the URL
to `/webpayments/GreatOaksWaterCo/search`: the first segment's case changes and so does the route.

- A recorded step's `pathHint` is set once, at its first scan (ADR 0028), so the default prefix
  (`defaultPathPrefix`) became `/WebPayments/GreatOaksWaterCo/bills`.
- Every later scan reports `/webpayments/GreatOaksWaterCo/search`. `profileApplies` was
  case-sensitive (ADR 0021: "Paths stay case-sensitive (the safe direction)"), so it returned false,
  the plan was `none`, and nothing filled.
- Record again hid it: filling during a recording ignores the prefix (ADR 0030).
- Setting the prefix to `/` by hand fixed it; the fields (`id1`/`id2` with proper labels) are stable.

Options weighed (controller ruling F1):

1. Default the prefix to `/`. A single-step profile then fills a footer newsletter email or a header
   search box anywhere on the site, and that consumes the once-per-document fill.
2. Fold every path seen during the recording into the step's `pathHint`. It misses rewrites that
   happen after the last render, and breaks on id segments that differ per visit.
3. Compare paths case-insensitively, and outside the prefix fill only pages that look like the
   recorded form. Chosen.

## Decision

- **Case-insensitive paths.** `profileApplies` lowercases the pathname and the prefix before
  comparing, with the same segment-boundary rules: `/BillPay` applies to `/billpay/x` and does not
  apply to `/billpayment`. The origin is still compared exactly. `buildProfile`'s coverage check and
  `reviewModel`'s "saved prefix still covers" check call `profileApplies`, so they follow the same
  rule. This amends ADR 0021.
- **Path scope.** `pathScope(profile, origin, pathname)` (`src/lib/match/match.ts`) is `on-path`
  under the prefix, `off-path` elsewhere on the profile's own origin, and null on any other origin or
  for a prefix that does not start with `/`. The scan-report handler answers `none` for null.
- **Off-path fingerprint gate.** `matchControls(saved, steps, page, { offPath })`: off-path, a saved
  field may claim a control only if `jaccard(step.fingerprint, pageKeys) >= MIN_JACCARD` (0.5) for
  that field's own step, with the page keys the cross-step gate already uses (`sigKey`). It applies
  to single-step profiles too, and on multi-step profiles it applies after the cross-step gate.
  Scores, margins, conflicts, fill rules, field policies and the fill mode are unchanged. On-path
  behaviour is exactly as before.
- **The default prefix stays** the narrow longest-common-segment prefix (ADR 0028, compared
  case-sensitively as recorded). Its meaning becomes: always applies under it; elsewhere on the
  site only where the page looks like the recorded form.
- **Review page.** The field is labelled "Fills on pages under", with the hint "Elsewhere on
  {host}, Refill fills only pages that look like this form." as its accessible description.
- Recording is unchanged: a session fills from its own body and ignores the prefix (ADR 0030).

## Consequences

- Never fewer fills than before: on-path pages behave as they did, and off-path pages filled nothing
  before. More fills happen only on pages that resemble a recorded step. On the bug site J = 1.0, so
  the form fills after the rewrite; a footer email or a header search box on an unrelated page is far
  below 0.5 (one shared key among several others).
- The e2e `/account` fixture was a copy of the twins form and now legitimately fills off-path. It
  became a distinct page with one matching field among others (stays empty), and `/lookalike` is the
  copy that must fill.
- Residual (accepted under ruling F1): markup-only injection now reaches a step's plan anywhere on
  the origin, not only under the prefix. Script injection could already do that through
  `history.pushState` to the prefix before a scan (ADR 0025), but markup alone cannot call
  `pushState`. So a page that lets an attacker place `form`, `input` and `label` without script (for
  example sanitized user content that allows those elements, or HTML injection under a
  script-blocking CSP) can copy a step's fingerprint and, in auto mode, have that step's `save`
  values filled into its controls. Limits:
  - the copy must reach step-level J >= 0.5 with the page;
  - the fill rules hold: the form's action must resolve to the page origin and no submitter may
    carry a cross-origin `formaction` (ADR 0024);
  - each field is filled at most once per document;
  - gesture mode returns a count and no values;
  - without script the attacker cannot read the filled values, so a value reaches a third party only
    if the user submits the form to a same-origin endpoint that publishes what it receives.
- Cost if wrong: a site that randomizes field names and labels AND rewrites its URL stays unfilled
  off-path (no worse than before).
- Two paths that differ only in case are one scope. A site that serves different forms at
  `/Pay` and `/pay` is not distinguished; the matcher's per-field evidence still decides what fills.

## Status

Accepted (2026-10-28, Plan 3 follow-up, ruling F1). Amends ADR 0021 (path case).
