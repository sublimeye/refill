# ADR 0023: Document scanner (bounded iterative walk, cap before signatures, shadow roots joined to the password history)

## Context
`scanDocument` feeds both record and fill with the page's eligible, non-sensitive controls (spec 5.1 to 5.3). It runs in the content script on hostile pages, so its cost and its failure behavior matter as much as its output. Task 5 review also asked that the 300-control cap apply before signatures are built for further elements.

## Decision
- `src/lib/fields/scan.ts`: `scanDocument(doc, history, openOrClosedShadowRoot?, isTopWindow?)` and `pageFingerprint` (`sigKey` per control). `isTopWindow` is passed through to `isEligible` and exists for tests only.
- Walk: iterative pre-order (no recursion, so a 20 000-deep chain cannot overflow the stack), document order, light DOM plus shadow roots. A shadow root is read before its host's light children. The callback (`chrome.dom.openOrClosedShadowRoot` in production) supplies closed roots; otherwise `el.shadowRoot`. A throwing callback skips that host.
- Node reads go through the `Node`/`Element` prototype accessors captured at load. A `<form>` exposes its named controls as properties that override its own (LegacyOverrideBuiltIns), so `<form><input name="firstChild">` would otherwise redirect the walk, and `<input name="action">` would replace `form.action`. The form action is read from the attribute, not the property.
- Bounds: at most `MAX_NODE_VISITS` = 50 000 nodes (elements, text and comments all count) and `MAX_CONTROLS` = 300 kept controls. Hitting either sets `truncated`. A page with more than 50 000 nodes before its form is therefore partly unscanned (fail closed). Walk cost measured locally: about 5 ms for 2 000 inputs (300 kept), worst of five runs about 24 ms (cold first run).
- Order per element, cheapest first: `controlKind` (non-null) then `isEligible` then `buildSignature` then `isSensitive`. Once 300 controls are kept, the first further element with a control kind sets `truncated` and ends the walk without any eligibility or signature work. So "truncated" means "another control-shaped element exists", not "another kept control exists" (it can over-report; exactly 300 candidates is not truncated).
- A failure on one element (a page-controlled getter throws) skips that element; the walk continues. An unexpected failure of the walk itself returns what was collected with `truncated: true`. `scanDocument` never throws.
- `ordinal` is the index among kept controls with the same form owner (`el.form`, which honors `form=`), or among formless controls of the document. Skipped controls take no ordinal. The signature is built with the tentative ordinal and the counter advances only when the control is kept. Radios contribute one entry each.
- `formAction`: `new URL(action attribute, doc.baseURI).pathname` for a form with an `action` attribute (an empty attribute resolves to the document); a form without the attribute uses the current document's pathname (the browser submits there); formless is null; an unparsable action is null. `buildSignature` applies the 256 cap.
- Password history: `PasswordHistory.observe(root)` replaces the previous observation, so it cannot be called for each shadow root. New `PasswordHistory.observeShadow(root)` adds a shadow root to the same observer (sweep plus `type` observation), is idempotent per root and resets on `disconnect()`. `scanDocument` calls it for every shadow root it enters, before judging that root's controls. The caller keeps one history per document and calls `observe(document)` once. A toggle that happened in a shadow root before the first scan that entered it is not seen; that control is judged by its current type only.

## Consequences
- Pages with deep or huge DOMs scan partially and report `truncated`; the content script must treat that as "may be incomplete" (no claim of a full page).
- `sensitive.ts` gained one method; existing `observe` semantics are unchanged.
- The walk reads page nodes through captured prototype accessors, so it is immune to named-property shadowing but not to a hostile page that replaces prototypes in the same JS world (not reachable from an isolated-world content script).

## Status
Accepted.
