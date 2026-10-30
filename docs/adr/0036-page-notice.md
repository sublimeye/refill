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
want the page is the content runner's decision (a later task), not the pill's. A state is not queued
and a hidden one is not restored.

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

`locked` with `fallback: true` points at the toolbar icon and offers no Unlock button; the caller
sets it when the button would have nothing to do. The button's action comes from
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
timer's included. `showing()` returns the kind on screen, or `null`. Both are for tests and e2e: the
product reads neither. A throwing `onChange` is swallowed.

## Consequences

- The return-visit states cost no new element and no new page-facing surface. A reviewer of the
  pill's hardening reads one file.
- The recording code keeps working while the runner takes the pill over: `recording.ts` passes a
  `PillActions` with no-op `undo` and `unlock` for now.
- `STOPPED_PILL_MS` is gone. Anything that waited a stopped notice out waits `NOTICE_MS`.
- The `updated` notice, and `locked` with `fallback: true`, only say what to do: the reload and the
  toolbar icon are the user's.

## Status

Accepted (2026-10-29, Plan 4, Task 1). Amends ADR 0032 (the pill is the page's one notice; the
stopped notice's timeout is `NOTICE_MS`).
