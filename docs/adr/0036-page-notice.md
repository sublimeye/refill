# 0036 The page notice: the recording pill grows the return-visit states

## Context

Plan 4 (the return visit, milestone M4) makes Refill speak on the page itself: it filled a saved
form, a fill can be undone, a form is ready but waiting for a click, the vault is locked, the
extension was updated under an open tab. Until now the page's only voice was the recording pill
(ADR 0032), and the popup was the only place anything else was said.

A second element would mean a second host, a second top-layer popover and a second set of guarantees
to hold against a hostile page. One element means one place to get them right.

## Decision

### One notice, one element

The recording pill becomes the page's single notice. `createPill(doc, actions, onChange?)` keeps the
ADR 0032 guarantees as they are:

- a `div` host with a closed shadow root, shown in the top layer as a manual popover;
- text and at most one button, never an input and never a value;
- styles through CSSOM only, as `!important` declarations, so it renders under a page CSP of
  `style-src 'none'` and over page CSS such as `* { all: unset }`;
- every DOM member captured from the prototypes at import time;
- never throws;
- an action runs only for a trusted click on the button. A `click()` call or a dispatched event does
  nothing.

Only one state is on screen at a time: a `show` replaces what was there. Which state wins when two
want the page is the content runner's decision (below), not the pill's. A state is not queued and a
hidden one is not restored.

### States and copy

`·` is U+00B7 and `—` is U+2014. A count uses `fields(n)` from `src/lib/copy.ts` ("1 field", "n
fields"). `needs you` reads `1 needs you`, otherwise `n need you`.

| kind | glyph | text | button |
|---|---|---|---|
| `on` | red `●` | `Recording · {fields}` | Finish |
| `full` | red `●` | `Recording is full · {fields}` | Finish |
| `stopped` | none | `Recording stopped — vault locked` or `Recording stopped after 30 minutes` | none |
| `filled` | green `✓` | `Refill filled {fields}` and, when `ask` > 0, ` · {needs you}` | Undo |
| `undone` | none | `Fill undone` | none |
| `ready` | none | `{fields} ready — open Refill to fill` | none |
| `locked`, `fallback: false` | none | `Refill has a saved form for this site — unlock from the toolbar icon` | Unlock |
| `locked`, `fallback: true` | none | the same | none |
| `updated` | none | `Refill was updated — reload this page` | none |

`locked` with `fallback: true` points at the toolbar icon and offers no Unlock button. The runner
shows it after a `toast-unlock-click` did not open the popup: the worker answered anything but
`{ ok: true }`, or the message failed. The button's action comes from
`PillActions { finish, undo, unlock }`, passed at creation.

`src/lib/copy.ts` holds the shared wording. It has no imports, so the content bundle does not pull
`wxt/browser` through it, and the popup's `Saved form · N fields` line uses the same helper.

### Timing

- `on` and `full` stay until hidden, as before. Every other kind hides itself `NOTICE_MS` (6000 ms)
  after its `show`. `NOTICE_MS` replaces `STOPPED_PILL_MS`, which only the stopped notice used.
- `pointerenter` or `focusin` on the host stops the timer, so a notice the user is reading or about
  to press does not vanish. `pointerleave` or `focusout` restarts the full `NOTICE_MS` once neither
  hover nor focus is inside. A notice shown while the pointer is already on it waits for the leave.
- A hide clears the hover and focus flags: the host leaves the page, so no leave event follows.
- These events are not checked for trust. A page that forges them can only keep a notice open on its
  own page, which gains it nothing: the notice carries no value. Actions stay trusted-click only.

### Palette and shape

The pill's own palette, in light and dark colour schemes alike (the user's choice, 2026-10-29): bar
`#1c1c1e`, text `#ffffff`, red `#ff453a`, green `#30d158`, the button white on `#1c1c1e`. The bar gains
`border: 1px solid rgba(255, 255, 255, 0.16)`, so it stays visible on a dark page. There are no
transitions and no animations, so `prefers-reduced-motion` has nothing to reduce.

The longest text (`locked`) is about 450 px on one line, wider than a phone. The host's
`max-width` is therefore `min(420px, calc(100vw - 24px))`, the bar wraps its text
(`white-space: normal`), and the button does not shrink. The bar's radius is 20 px, which is a full
pill on one line and a rounded box on two.

### `onChange` and `showing()`

`onChange(kind | null)` is called with the kind on every show and with `null` on every hide, the
timer's included. `showing()` returns the kind on screen, or `null`. A throwing `onChange` is
swallowed.

A show that did not open the popover is not a show: the page can make `showPopover` throw (drop the
host's `popover` attribute) or cancel it (`beforetoggle`). The pill then takes the host off the page,
`showing()` stays `null`, and `onChange` hears no kind (a `null` if a kind was reported before).
The runner relies on `showing()` (the recording hides only its own kinds, Unlock acts only on a
`locked` notice), so it must never name a notice that is not on screen.

### The runner owns the notice

`startContentScript` creates the document's one pill (`createPill(doc, { finish, undo, unlock },
onChange)`) and hands it to the recording (`RecordingEnv.pill()`). `ContentEnv.onNotice` is passed
through as `onChange`. The scanner skips the pill's host by identity (`Recording.ownsHost` is gone).

- **Recording** shows only `on`, `full` and `stopped`. On `off`, and on a repeated `stopped`, it hides
  the pill only when `showing()` is one of those three: a recording state change never hides a
  return-visit notice.
- **Return-visit rules hold only while `recording.active()` is false and the plan is not a
  session plan** (rulings R1, R3). While recording, the runner keeps no Undo records, adds no
  outlines and shows nothing: recording fills come from the session, and the pill says
  `● Recording`. The worker marks every `fill` plan with a required `recording: boolean` (true when
  it came from the tab's session), because a fresh document's first plan, and the report of a nudge
  that starts a recording, arrive before `record-status` has answered. A plan without the flag is
  no plan. The per-element fill rule (ruling P20) stays tied to `recording.active()`: before the
  status answers, the stricter per-id rule applies, as before. When a recording starts in the
  document (`RecordingEnv.started`), the records are emptied and the outlines released: Undo after
  the recording must not put back values from before it.
- **`fill`.** Right before each `fillControl` the runner takes `snapshot([item])`; on `filled` it
  keeps `{ before, written: item.value }` in the document's records. Then each `ask` index whose
  control still means what was scanned and is a text or select reading `""`, or a checkbox or
  radio, is outlined. If the records grew, it shows `filled { count: records, ask: outlined }`. The
  `fill-result` after the plan carries `filled` = the records' count (the document's running total,
  capped at 300); while recording it carries that plan's own count, as before. Outside recording, a
  plan that wrote nothing still sends the running total while the records are not empty: the unlock
  pass cleared the badge, and the nudge's re-report fills nothing new.
- **`gesture`.** `n` = the plan's distinct `fieldIds` not yet filled in this document. `ready { n }`
  shows when `n > 0` and that set of pending ids (sorted, as one key) differs from the set of the
  last `ready` shown in this document, so a page that re-renders does not repeat it, while an SPA
  step with other pending fields is announced even when their count is the same.
- **`locked`** shows `locked { fallback: false }` once per document; a bfcache restore is the same
  document. It shows nothing (and is not yet counted as shown) while the notice shows `stopped`: a
  lock during Record again keeps "Recording stopped — vault locked".
- **Unlock** (trusted click) sends `toast-unlock-click`. If the notice still shows `locked` when the
  reply comes: `{ ok: true }` hides it (the popup is open), anything else shows `fallback: true`. A
  notice that moved on meanwhile (the unlock already filled the page) is left alone.
- **Undo** (trusted click) runs `undo(records)` from `fill.ts`: under the filling guard and with the
  fill technique (`restore`), it puts back each control that is still connected and still reads
  exactly what Refill wrote (the value; `String(checked)` for toggles). A field the user changed
  since keeps the user's value. The records are emptied, `undone` shows, and a `fill-result` with
  all counts 0 is sent. The ids stay filled for the document (ADR 0026), so a later plan does not
  write them again. A radio Refill checked cannot be unchecked by a click; restoring it is best
  effort, as for every restore.
- **The `ask` outline** (`src/lib/content/outline.ts`) is `outline: 2px solid #0a84ff` and
  `outline-offset: 2px`, both set `important` through CSSOM on the control itself. The page's own
  inline outline longhands and their priorities are saved first and put back on release. A trusted
  `input` or `change` (not during a fill) whose deepest target is outlined releases it; the listener
  is in the capture phase on the document and on every shadow root the scan entered, because
  `change` does not leave a shadow tree and a closed root retargets `input` to its host. A control
  the page removed is released and no longer counted. A control the user's edit released is never
  outlined again in this document (ruling R4): a later plan, such as a nudge's forced re-report,
  would otherwise outline a checkbox the user already answered, or a field the user emptied again.
  `stop()` releases every outline.
- **Extension gone.** When `send` finds the extension gone (the context invalidated or
  `runtime.id` undefined) the run stops as before. If Refill filled, recorded or showed a notice in
  this document, it first shows `updated` and leaves it to its own `NOTICE_MS` timer: that path does
  not remove the pill. A page Refill never touched hears nothing.

In the e2e build only, `refill-content.ts` mirrors the kind into
`document.documentElement.dataset.refillNotice` (`""` when hidden), since the notice's root is
closed.

## Consequences

- The return-visit states cost no new element and no new page-facing surface. A reviewer of the
  pill's hardening reads one file.
- The runner owns the pill (Task 3); `recording.ts` shows its states on it through
  `RecordingEnv.pill()` and no longer creates or removes one.
- `STOPPED_PILL_MS` is gone. Anything that waited a stopped notice out waits `NOTICE_MS`.
- The `updated` notice, and `locked` with `fallback: true`, only say what to do: the reload and the
  toolbar icon are the user's.
- The `ask` outline is an inline style on a page control, so page script can learn which of its
  controls Refill's saved form marks Ask. It learns no value: those fields are never filled.
- A forged click on the host does nothing (actions are trusted-click only), and a forged `input` or
  `change` does not release an outline.

## Status

Accepted (2026-10-29, Plan 4, Task 1). Amends ADR 0032 (the pill is the page's one notice; the
stopped notice's timeout is `NOTICE_MS`). Extended by Plan 4, Task 3 (2026-10-29): the runner owns
the notice, the return-visit rules, Undo, the `ask` outline, `updated`, and a failed show reports
nothing.
