# 0021 Matcher details (type gate, derived pair, conflict resolution)

## Context

Spec 5.4 defines a weighted per-field score with a hard type/kind gate, a threshold, a margin and a step-fingerprint tie-break. Several edge cases were left open: which types count as "text-like", how a derived name/id pair is weighed, and what happens when two saved fields claim one control.

## Decision

- Pure module `src/lib/match/match.ts`: no DOM, no chrome APIs, `import type` only, so the service-worker bundle does not pull in field/eligibility DOM code.
- Gate: kinds must be equal. Within kind `text`, the types text, email, tel, number, search, url, textarea and date are interchangeable; any other type (and every non-text kind) must be equal. Failing the gate scores `-Infinity`, which never counts as a runner-up.
- Evidence counts only when both sides are non-null and non-empty; autocomplete counts only when its value (ignoring `section-*`, shipping/billing/home/work/mobile/fax/pager/webauthn) contains a WHATWG autofill field name; junk such as `nope`, `chrome-off`, `disabled` is shared by every control on sites that defeat autofill and scores 0 (otherwise junk 4 + formAction 1 reaches the threshold with no field-specific evidence and fills a lone control). Equality still uses the full normalized string, so `shipping email` != `billing email`; `on`/`off` are already null in signatures. If either side has `nameIdDerived`, the name weight counts once and the idStable weight is never added, even when ids are equal.
- A saved field claims its best control only if score >= 5 and it leads the runner-up by >= 2 (a tie for best has margin 0). Controls are ranked by score desc, then control index asc, so input order cannot change a result.
- When several saved fields claim one control, the winner is the one whose step fingerprint has the highest Jaccard (over `sigKey` sets) with the page's `sigKey` set, if that is >= 0.5 and strictly above every other claimant; otherwise all claimants are dropped. A claimant whose step is unknown has Jaccard 0. Unconflicted claims skip this conflict check; with a single recorded step that means they skip Jaccard entirely, but with more than one step every claim, conflicted or not, must first pass the cross-step gate below.
- Cross-step gate: with more than one recorded step, a saved field may match only if its step is among the steps with the maximal Jaccard (fingerprint vs the page's `sigKey` set) and that maximum is > 0. A step-1 field never fills a step-2 page; an SPA page holding both steps' signatures fills both only if their Jaccards tie at the max. Single-step profiles have no gate. The conflict rule above still applies after the gate (reachable mainly with a single step or an unknown step, since gated claimants share the max and so tie).
- Placeholder label (3) + same formAction (1) + same ordinal (1) = 5 is a match: same form, same position and same placeholder is real evidence. Placeholder alone, or with only one of formAction/ordinal, stays unmatched. This refines the spec example "randomized name+id with only a placeholder can't reach the threshold".
- `profileApplies` matches on path-segment boundaries: `pathname === prefix`, or the prefix ends with `/` and the pathname starts with it, or the pathname starts with `prefix + "/"`. `/billpay` does not apply to `/billpayment`. Paths stay case-sensitive (the safe direction). The default prefix (longest common prefix of recorded steps) must be computed per segment.
- `scoreSig` takes both control kinds as required parameters.
- Empty-set Jaccard is 0, so empty inputs never throw and never match through the tie-break.

## Consequences

- Ambiguity is reported as "couldn't match" rather than guessed; same-step twins with identical evidence are dropped.
- The text-like set is a closed list; a new text-kind type (e.g. `month`) matches only itself until added.
- Cost is O(saved x controls log controls); 200 x 300 runs well under the 50 ms test budget.

## Status

Accepted. Wording clarified in Plan 3 Task 12 (2026-10-28, Plan 2 final review M10): unconflicted claims skip only the conflict Jaccard check, and the cross-step gate still applies to them on multi-step profiles; the pointer to the conflict rule now points up.
