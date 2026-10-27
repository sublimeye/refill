# 0021 Matcher details (type gate, derived pair, conflict resolution)

## Context

Spec 5.4 defines a weighted per-field score with a hard type/kind gate, a threshold, a margin and a step-fingerprint tie-break. Several edge cases were left open: which types count as "text-like", how a derived name/id pair is weighed, and what happens when two saved fields claim one control.

## Decision

- Pure module `src/lib/match/match.ts`: no DOM, no chrome APIs, `import type` only, so the service-worker bundle does not pull in field/eligibility DOM code.
- Gate: kinds must be equal. Within kind `text`, the types text, email, tel, number, search, url, textarea and date are interchangeable; any other type (and every non-text kind) must be equal. Failing the gate scores `-Infinity`, which never counts as a runner-up.
- Evidence counts only when both sides are non-null and non-empty; autocomplete `on`/`off` never counts. If either side has `nameIdDerived`, the name weight counts once and the idStable weight is never added, even when ids are equal.
- A saved field claims its best control only if score >= 5 and it leads the runner-up by >= 2 (a tie for best has margin 0). Controls are ranked by score desc, then control index asc, so input order cannot change a result.
- When several saved fields claim one control, the winner is the one whose step fingerprint has the highest Jaccard (over `sigKey` sets) with the page's `sigKey` set, if that is >= 0.5 and strictly above every other claimant; otherwise all claimants are dropped. A claimant whose step is unknown has Jaccard 0. Unconflicted claims skip the Jaccard check.
- Empty-set Jaccard is 0, so empty inputs never throw and never match through the tie-break.

## Consequences

- Ambiguity is reported as "couldn't match" rather than guessed; same-step twins with identical evidence are dropped.
- The text-like set is a closed list; a new text-kind type (e.g. `month`) matches only itself until added.
- Cost is O(saved x controls log controls); 200 x 300 runs well under the 50 ms test budget.

## Status

Accepted
