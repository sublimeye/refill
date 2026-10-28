# ADR 0028: Recorder model (steps, field identity, reverts, fill from the session, path prefix)

## Context
Plan 3 records a form or wizard once by hand and saves it as a profile (spec §6.2). The worker owns
the recording; it needs pure rules, with no DOM and no chrome APIs, for four things:
- which step a scanned page belongs to;
- which field a trusted edit updates;
- what to fill while recording;
- how a finished recording becomes the review page and a `Profile`.

Review Focus 1, 2, 3 and 5 of Plan 3 depend on these rules. The Plan 2 ledger (Task 7 re-review)
left three notes for the recorder:
- accordion flows recorded as several steps under-fill;
- the default `pathPrefix` must be computed per segment;
- dynamic label text drifts step fingerprints.

## Decision
The model lives in `src/lib/recorder/{types,steps,fields,plan,profile}.ts`. A `RecBody` holds the
steps, the fields, the current step, the last document id and the next field id. Each function
returns a new body and never mutates its input. The keys and the similarity are the matcher's own
(`sigKey`, `jaccard`, `MIN_JACCARD` = 0.5), and the limits are the profile `LIMITS`, so a session
always fits a profile.

### Steps (`observePage`, once per scan-report)
- **Same document** (non-null `documentId` equal to `lastDocument`): the page stays on the current
  step when its keys contain the step's whole fingerprint (an accordion opening) or Jaccard ≥ 0.5.
- **Otherwise** (an SPA step change that failed the test above, a new document, Back, a reload, a
  failed-validation re-render): the page joins the candidate step with the highest Jaccard. The latest
  step in the body wins a tie. A step is a candidate when:
  - its Jaccard with the page is ≥ 0.5; or
  - its fingerprint contains every key of a page that has at least 3 distinct keys (the subset rule).

  The subset rule covers an accordion reloaded collapsed: within one document the fingerprint grew to
  every section opened, and a re-render showing only the first of three sections has Jaccard 3/9.
  Without the rule it would become a duplicate step, which `recordingPlan` prefers, so section 1 would
  not be pre-filled (Review Focus 3, 2). Pages with fewer than 3 keys use Jaccard only, so a short
  later step that repeats a control of an earlier one (a single "amount" input) does not join it.
- **Else** the page becomes a new step, with the lowest unused index (a seeded profile's indexes need
  not be 0..n-1, and the profile parser allows only 0..9). Its `pathHint` is the pathname, cut back to
  its last "/" within 256 characters when it is longer, so the hint stays a segment prefix of the real
  path. With 10 steps already, the result is `"full"`.
- **Joining a step** adds the page's keys to its fingerprint: the old keys first, distinct, at most
  300. Keys over 1024 characters are dropped.
- **Accordions** (settles the ledger note): fingerprints are cumulative within one document, so a
  one-page flow whose sections open in turn is one step whose fingerprint covers every section. The
  matcher then fills all of it on the next visit.
- **Duplicate steps:** Back and a re-rendered POST land on the existing step, never a duplicate.
  Duplicate steps tie on similarity, and the matcher drops every claimant on a tie.
- **A page with no keys** files no step: `current` becomes `null`, so a capture there answers
  `"no-step"`. Plan 2's runner never reports an empty scan, so this matters only for direct callers.

### Fields (`applyCapture`)
- **Never stored** (answered `"ok"`): `sigLooksSensitive` (the worker re-checks secrets whatever the
  content script decided), a value or page default over 4096, a radio whose value is not `"true"`,
  a checkbox whose value is not `"true"`/`"false"`. Card numbers and SSNs are stored (spec §5.3 as
  amended). With no current step the answer is `"no-step"`.
- **Identity** within the current step:
  - A **named** radio is `radio|<name>|<formAction>`, so choosing another option replaces the group's
    field.
  - Every other control is `<sigKey>|<ordinal>`, so two controls with the same label are two fields.
  - An **unnamed** radio uses the second form. The browser does not group unnamed radios, and a
    shared `radio||` key would merge unrelated yes/no questions. The brief did not cover this case.
- **The `fieldId` link:** when the content script reports that Refill filled field `fieldId` into
  the edited element, that field is the target, in any step. The link holds even when the page has
  changed the label since the first recording, where identity would miss (Review Focus 5). The
  target takes the capture's signature, kind, value, page default and the current step, and keeps
  its id and policy.
  - A linked target moves to the current step: the page it was filled into is that step, so that is
    where it will be matched again.
- **The matcher fallback (signature drift without a link):** when `fieldId` is null or unknown and
  identity misses, the target is `matchControls(<current step's fields>, [<current step>], [the
  capture as control 0])`. Recording and filling then agree on which field a control is, with the fill
  thresholds. This covers Record again after a relabel for a field Refill did not fill: an `ask` or
  `skip` field, or a `save` field whose element was not empty. Without it a new field would be added
  next to the seeded one, both would claim the control, and the matcher would drop both
  (Review Focus 5).
  - Fields whose `sigKey` equals the capture's are left out of the fallback. Identity separates them
    on purpose: the same label at another ordinal, or the same radio group in another form. The
    fallback sees only the one control, so it cannot apply the margin against the page's other
    controls that would tell them apart.
  - A residual limit: two controls with different labels that share a name and an autocomplete token
    score 7 against each other. If only one of them was captured before, an edit of the other updates
    that field instead of adding one.
- **Older captures of the same control:** when the target was found by link or by the fallback, any
  other field of the current step with the capture's identity is an older capture of the same control.
  It is removed on an update and on a revert alike. Otherwise the matcher gets two claimants, which
  both drop, and a revert would leave a value the user cleared (Review Focus 1). The brief did not
  cover this case.
- **Reverts:** a capture whose value equals its page default removes the target field, a seeded
  field included. Clearing a value or setting it back means "don't save it" (Review Focus 1). The
  content script never refills an element the user edited in that document (Task 8), so the old value
  does not come back.
- **New fields** get `f<nextId>` (skipping any id in use) and policy `save`. A 201st field answers
  `"full"` with the body unchanged; updates and reverts of existing fields still apply.

### Fill from the session (`recordingPlan`) and seeding (`seedBody`)
- **While recording**, the fill plan is `matchControls(body.fields, body.steps, controls)`, filtered to
  `save` fields, the same rule as Plan 2's fill (ADR 0025): every field takes part in matching. The
  stored profile is never read on this path.
- **Record again** seeds the body from the stored profile (steps, fields, ids, policies and values),
  so saved values fill through the same path. `nextId` starts past every `f<n>` id in use, and the
  first page joins a seeded step like any other.

### Path prefix, review model and profile
- **`defaultPathPrefix`** (settles the ledger note):
  - Paths that are all equal give that path.
  - Otherwise the result is `/` + the shared leading segments + `/`, or `/` when no segment is
    shared. It is computed per segment, so `/billpay1` and `/billpay2` give `/`, never `/billpay`.
  - When one path is exactly the shared segments (`/billpay` next to `/billpay/confirm`), the
    trailing `/` is left off. Otherwise the prefix would not cover `/billpay` under `profileApplies`.
- **`reviewModel`**:
  - The label is `labelText ?? name ?? "Unlabeled field"`.
  - Name, prefix and fill mode come from the saved profile on Record again. A saved prefix that no
    longer covers every step that has fields is replaced by the default.
  - Without a saved profile, the name is the host (`URL.host`, cut to the 120-character name limit),
    the prefix is the default and the fill mode is `auto`.
- **`buildProfile`** returns `null` in these cases:
  - a field has no policy, or a policy names an unknown id (own keys only, so an id such as
    `constructor` cannot pick up the prototype);
  - the trimmed name is not 1..120 characters;
  - the prefix does not cover the `pathHint` of every step that has at least one field, under
    `profileApplies`.

  `createdAt` is kept on Record again and `lastUsedAt` is `null`. Steps and fields are copied (no
  body references), and the result goes through `parseProfile`.
- **Steps without fields** stay in the profile but do not set the prefix: the default prefix and the
  coverage check use only steps with at least one field. Kept, such a step keeps the matcher's
  cross-step gate honest, because a step-1 field does not fill a step-2 page that happens to share a
  name. A recording that starts on an unrelated page of the site (a landing page at `/`) does not
  widen the prefix.

## Consequences
- **Known matcher limit:** step fingerprints hold label text, so a label with dynamic text ("amount
  due $45.12") drifts between visits. The step it belongs to then loses similarity, and a small step
  that shares a header can win the gate, which under-fills without wrong-filling. While recording,
  the same drift can file a revisited page as a new step. A label normalizer (digits, currency) is
  left to corpus tuning.
- **A fieldless step outside the prefix** is saved with the profile, but the profile never applies
  on its page. It still takes part in the gate on pages inside the prefix.
- **After `"full"` the body is unchanged**, so `current` still names the previous step. The
  scan-report handler (`recordingScan`, ADR 0030) stores the body with `current: null` and
  `lastDocument` set to that document, so captures from the eleventh page get `"no-step"` and
  answer `full` instead of being filed into the previous step.
- The model is pure and imports DOM modules as types only, so it can run in the worker bundle
  (`check:sw-no-dom`).

## Status
Accepted (2026-10-27).
