# Refill — Design Spec

**Status:** Draft for review · **Date:** 2026-10-26 · **Author:** Roman Morozov (with Claude)
**One-liner:** Refill is a local-only, encrypted Chromium extension that remembers the forms you fill
repeatedly (e.g. a water-bill wizard), pre-fills them on return, and protects long-form drafts from loss.

---

## 1. Intent

### 1.1 Problem
Recurring web chores (paying a water bill every two months through a 2–3 step wizard) require
re-typing the same data. Long forms lose everything when a submit fails. Existing extensions are
either broken, closed-source, bloated, license-encumbered, sync data to the cloud, or request
access to every site (see `docs/research/prior-art.md`).

### 1.2 Success criteria
1. Record the water-bill wizard once; on every later visit, each step's saved fields are filled on
   arrival with a small reminder toast; the user only types what changes (amount/date) and clicks
   Next/Submit themselves.
2. A long form on an opted-in site survives a failed submit / crash / closed tab and can be
   restored with one click.
3. No form value, profile or draft is ever stored in plaintext on disk; passwords, OTPs, CVVs and hidden/CSRF fields are
   never stored.
4. Install shows **no permission warnings**; site access is requested per site, in context.
5. Passes a documented, adversarial security audit and Chrome Web Store review.

### 1.3 Decisions made with the user
| Topic | Decision |
|---|---|
| Encryption | Encrypt everything; vault locked behind a passphrase; nothing fills while locked |
| Unlock convenience | Touch ID via WebAuthn PRF (gated by a spike, §11) |
| Wizard automation | **Fill only** — never clicks Next/Submit |
| Fill trigger | Per-profile setting: **Auto** (default) or **One gesture** (popup "Fill now"); no hotkey |
| Draft scope | Per-site opt-in; optional global mode via runtime `<all_urls>` request with loud warning |
| Draft saving | Only after a user-originated change; untouched pages never produce drafts |
| Stack | WXT + TypeScript (strict) + Svelte 5 for extension pages; vanilla TS content script |
| Browsers | Chromium (Brave, Chrome) for v1 |
| Distribution | Public GitHub repo (MIT), Chrome Web Store |

### 1.4 Non-goals (v1)
- Credit-card fields (`cc-*`) and cross-origin payment iframes (browser autofill covers these).
- Custom widgets (react-select, MUI selects, calendar pickers) — detected and reported "can't fill".
- Multiple profiles per site; clicking buttons; scripting/macros; cloud sync; Firefox.
- Hotkeys.
- Protecting values *after* they are filled into a page from scripts running on that same origin
  (documented residual risk, §8.3).

---

## 2. Architecture

```
┌─ Service worker (trusted core; sole holder of keys) ─────────────────┐
│ vault/     unlock (passphrase | Touch ID), lock policy, KDF, wrap   │
│ crypto/    AES-GCM records, ECDH draft sealing, HKDF, AAD binding    │
│ store/     single write queue over chrome.storage.local              │
│ sites/     optional host perms ⇄ registerContentScripts reconciler  │
│ router/    typed message router + sender validation                  │
│ match/     signature matcher (pure; shared with content script)      │
│ drafts/    seal (works while locked), TTL sweep via alarms           │
│ recorder/  per-tab recording sessions in storage.session            │
└────────────▲──────────────────────────────────▲──────────────────────┘
             │ runtime messages (validated)      │
┌────────────┴───────────────┐    ┌─────────────┴────────────────────────┐
│ Content script             │    │ Extension pages (Svelte 5)           │
│ (registered per enabled    │    │ onboarding · popup · review ·        │
│  origin, top frame only)   │    │ dashboard · settings · unlock window │
│ scan → signature → fill    │    └──────────────────────────────────────┘
│ recorder capture, drafts   │
│ toast + fix mode (closed   │
│ shadow root, top layer)    │
└────────────────────────────┘
```

**Units and boundaries**
- `match/` is a pure module (no chrome APIs): given scanned field descriptors and a profile, it
  returns a fill plan. Unit-testable in isolation, used by both SW (validation) and content script.
- `fill/` (content script) only knows how to set a value on a DOM element robustly.
- `crypto/` is a thin WebCrypto wrapper with known-answer tests; no other module calls
  `crypto.subtle` directly.
- `store/` is the only module calling `chrome.storage.local`; serializes writes through one queue.
- Extension pages never hold the DEK; they request operations from the SW.

---

## 3. Permissions & manifest

| Permission | Install warning | Why |
|---|---|---|
| `storage` | none | encrypted vault, settings, session key mirror |
| `activeTab` | none | popup learns current tab URL; one-shot inject after toolbar click |
| `scripting` | none | register content script only for granted origins; inject after grant |
| `alarms` | none | TTL sweep, hard-max lock timer survive SW suspension |
| `idle` | none | lock on system idle / screen lock |
| `optional_host_permissions: ["https://*/*"]` | per-site prompt at use | requested per origin on Record / Protect drafts; whole pattern only for global drafts |

- **Never requested:** `tabs`, `<all_urls>` at install, `nativeMessaging`, `webRequest`, `history`,
  `cookies`, remote code, any network access (no `fetch` anywhere; enforced by lint + CSP).
- `externally_connectable: { "ids": [], "matches": [] }` — no other extension or web page may message
  Refill. No `onMessageExternal` listener.
- CSP (extension pages): `script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'none'`
  (`wasm-unsafe-eval` only for the bundled Argon2id WASM).
- No `web_accessible_resources`.
- A **manifest snapshot test** fails CI if permissions, host permissions, CSP or
  `externally_connectable` change without updating the snapshot deliberately.

### 3.1 Site enablement flow
1. User clicks toolbar icon → popup (has `activeTab` URL) → "Record this site" / "Protect drafts".
2. Popup calls `permissions.request({origins:[origin + "/*"]})` (user gesture). It does **no** work
   after the await (popup may close).
3. SW handles `permissions.onAdded`: registers/updates the dynamic content script
   (`matches` = granted origins, `allFrames:false`, `runAt:"document_idle"`, `world:"ISOLATED"`),
   then `scripting.executeScript` into the active tab so it works without reload.
4. **Reconciler** runs on `onInstalled`, `onStartup`, `permissions.onAdded/onRemoved`: registered
   scripts = exactly the granted origins that have a site record. Revoking access in Chrome's own
   menu disables the site in Refill (data kept, shown as "access revoked").
5. Content script is built as a WXT *unlisted script* and registered manually (WXT runtime
   registration would add required host permissions — WXT issue #2239).

Only `https:` origins are eligible (plus `http://localhost` in the test build only).

---

## 4. Data model & cryptography

### 4.1 Key hierarchy
```
passphrase ──Argon2id(salt, m=64MiB, t=3, p=1)──► KEK_pw ─┐
Touch ID ──WebAuthn PRF(salt_prf)──HKDF──────────► KEK_prf ┼─AES-GCM wrap──► DEK (256-bit random)
                                                           │
DEK ──AES-GCM──► draft private key (ECDH P-256)
draft public key (plaintext) ──ECDH+HKDF──► per-draft AES key (sealing works while locked)
```
- Argon2id parameters are stored versioned in the header and calibrated at vault creation to
  ~0.5–1 s on the user's machine (floor: m=64MiB, t=3). Implementation: one small, audited,
  vendored + pinned WASM library (choice recorded in an ADR).
- Unwrapping the DEK is the passphrase verifier (GCM tag). No separate hash is stored.
- Passphrase change = re-wrap DEK. Touch ID enable/disable = add/remove `KEK_prf` wrap.
- Passphrase policy: zxcvbn-style strength meter (implemented without network); minimum score
  enforced; explicit "there is no recovery" acknowledgment.

### 4.2 Records in `chrome.storage.local`
```
vault:header (plaintext)
  { v, kdf:{alg:"argon2id",m,t,p,salt}, wrappedDek:{iv,ct},
    prf?:{credentialId, salt, wrappedDek:{iv,ct}},
    draftPub:JWK, wrappedDraftPriv:{iv,ct},
    lock:{idleMinutes, maxHours, passphraseEveryDays}, lastPassphraseAt }

sites (plaintext index — needed while locked to run drafts and reconcile scripts)
  { [origin]: { profileId|null, drafts:boolean, ttl, accessRevoked } }

settings (plaintext; contains no secrets)
  { globalDrafts, defaultTtl, toastSeconds, ... }

p:<random 128-bit id>       AES-GCM(DEK, iv, AAD="refill/v1|profile|<id>|<origin>")
  { id, name, origin, pathPrefix, fillMode:"auto"|"gesture", createdAt, lastUsedAt,
    steps:[{ index, pathHint, fingerprint:[sig…] }],
    fields:[{ sig, step, value, policy:"save"|"ask"|"skip", kind:"text"|"select"|"checkbox"|"radio" }] }

d:<random 128-bit id>
  { expiresAt|null,                                   // plaintext: enables purge while locked
    eph:JWK, iv, ct }  // ECDH(eph, draftPub) → HKDF → AES-GCM, AAD="refill/v1|draft|<id>"
  ct = { origin, path, formFingerprint, fields:[{sig,value}], savedAt }
```
- Fresh random 96-bit IV per encryption; never reused.
- AAD binds each ciphertext to its type, id and origin; swapping ciphertexts between keys fails.
- **Site list is not secret, values are.** Chrome itself stores granted host permissions and
  registered content scripts in plaintext profile prefs, so encrypting Refill's site index would
  add complexity without hiding anything from a disk attacker. Every field value, profile name and
  draft is encrypted; the site index and settings are plaintext so drafts and script
  reconciliation work while locked.
- Quotas: ≤ 20 drafts and ≤ 512 KB per origin; ≤ 5 MB drafts total; oldest evicted first.

### 4.3 Key residency and locking
- After unlock, the DEK lives in SW memory as a non-extractable `CryptoKey` **and** as raw bytes in
  `chrome.storage.session` (RAM-only, `TRUSTED_CONTEXTS`) so a suspended SW can resume. Accepted
  and documented: raw bytes may reach swap/hibernation files. Decrypted records are never put in
  `storage.session`.
- Lock triggers: `idle.onStateChanged` → `locked` (immediate) or idle ≥ N min (default 15);
  hard max since unlock (default 12 h, `alarms`); browser restart; extension update/reload;
  manual "Lock now". Page activity never extends the session.
- Touch ID users must enter the passphrase every 14 days (configurable).

### 4.4 Export / import
- Export: user re-enters passphrase (or a separate export passphrase); fresh salt + Argon2id;
  envelope `{format:"refill-export", v:1, kdf, iv, ct}` with header as AAD. Drafts excluded.
- Import: treated as untrusted. Strict hand-written schema validation, size caps, diff preview,
  per-site accept. Settings are never imported.

---

## 5. Field model & matching

### 5.1 Field signature
For each candidate control: `{ name, idStable, autocomplete, type, labelText, ordinal, formAction }`
- `labelText` from `label[for]`, wrapping `<label>`, `aria-labelledby`, `aria-label`, `placeholder`
  (normalized: lowercase, collapsed whitespace, digits stripped).
- `idStable` = id unless it looks generated (hash-like, long digit runs, React `:r1:` style) → dropped.
- `ordinal` = index among eligible controls in the same form.

### 5.2 Eligibility (both record and fill)
Eligible only if: in top frame; `input` (text-like, email, tel, number, date, search, url),
`textarea`, `select`, `checkbox`, `radio`; visible (non-zero box, not `display:none`/
`visibility:hidden`/`hidden`/`inert`, not `aria-hidden` ancestor); enabled; not readonly.

### 5.3 Never-capture list (record, drafts)
- `type=password`, and any field that was *ever* `type=password` in this document (MutationObserver
  on `type` attribute — catches show-password toggles), `-webkit-text-security` styled fields.
- `type=hidden`, `file`, disabled/readonly, captcha-like fields.
- `autocomplete`: `current-password`, `new-password`, `one-time-code`, all `cc-*`.
- Name/label heuristics (case-insensitive): pass(word)?, pwd, pin, otp, 2fa, mfa, totp, code
  (verification), cvv, cvc, csc, security code, ssn, social security, card number, seed/mnemonic,
  recovery phrase, `__VIEWSTATE`, `__EVENTVALIDATION`, csrf, xsrf, token, nonce.
- Values that look like card numbers (Luhn-valid 13–19 digits) are dropped even in innocuous fields.
- Bank account / routing numbers are capturable (common for utility ACH payments) but default to
  `policy:"ask"` in review if detected; user may switch to `save`.

### 5.4 Matching (fill)
- A profile applies to a page iff `page.origin === profile.origin` (exact: scheme, punycode host,
  port) and `page.pathname.startsWith(profile.pathPrefix)`. `pathPrefix` defaults to the longest
  common path prefix of recorded steps; editable in dashboard.
- Per-field match: a saved field matches a page control when **≥ 2 signature parts agree**
  (`name`, `idStable`, `autocomplete`, `labelText`, with `type`/`kind` compatible) and the match is
  **unique** on the page. Ties across steps are broken by step fingerprint similarity
  (Jaccard over the page's signature set vs each step's fingerprint, threshold 0.5).
- SPA wizards: a debounced (250 ms) MutationObserver re-scans; each saved field is filled **at most
  once per document**.

### 5.5 Fill rules (security mitigations, §8)
Fill a control only if: vault unlocked; profile `fillMode` allows (auto, or user pressed Fill now);
control eligible (§5.2); control empty or still equal to its `defaultValue`; its form's `action`
(if any) resolves to the same origin; field policy is `save`. Never fill into `<form>`s submitting
cross-origin, never in sub-frames, never over http.

### 5.6 Fill technique
- Text-like: focus → native prototype `value` setter → `input`, `change`, `blur` events; verify
  value stuck; if a mask rewrote it, fallback `select()` + `document.execCommand('insertText')`.
- `select`: set value if option exists → `change`. Checkbox/radio: `.click()` only if state differs.
- Custom widgets (role=combobox without native select, etc.) → reported as "couldn't fill".
- Closed shadow roots reachable via `chrome.dom.openOrClosedShadowRoot` are scanned.
- Undo restores pre-fill values with the same technique.

---

## 6. Flows

### 6.1 Onboarding (extension tab on install)
Set passphrase (strength meter, no-recovery acknowledgment) → enable Touch ID (if PRF available)
→ "Pin Refill to your toolbar" → "Open a form you fill often and click Record".

### 6.2 Recording
1. Popup (vault must be unlocked) → **Record this site** → permission grant if needed.
2. SW creates a recording session `{tabId, origin, startedAt}` in `storage.session` (expires 30 min).
   Only the popup can arm recording; content-script requests to start are rejected.
3. Content script shows pill: `● Recording · N fields · Finish` (no inputs). Captures, on trusted
   `change`/`input` events, the final value of each eligible, non-excluded control whose value the
   user changed. Step boundary = new document, or field-set fingerprint change in an SPA.
4. **Finish** (pill or popup) → SW opens `review.html?session=<id>` in a new tab.
5. Review: table (step, label, masked value with reveal, policy dropdown), profile name,
   fill mode, path prefix. Suspicious fields pre-set to `skip`/`ask`. Save → encrypted profile.

### 6.3 Return visit
- Unlocked + auto: fill (§5.5) → toast `✓ Water bill · filled 5 · 1 needs you  [Undo] [Fix]`;
  `ask` fields get a subtle outline and stay empty.
- Unlocked + gesture: toast `Water bill · 5 fields ready — open Refill to fill`; popup **Fill now**.
- Locked: badge 🔒; toast `Water bill ready — unlock from the Refill toolbar icon`. The toast's
  Unlock button asks SW to `chrome.action.openPopup()`; if that's rejected, the text instruction
  remains. **No passphrase input ever appears inside a web page.** After unlock, the active tab
  fills (auto) or offers Fill now (gesture).
- **Fix mode:** outlines filled fields; clicking one shows the saved field it matched with
  **Unlink** / **Never fill here** (updates profile).

### 6.4 Drafts (opted-in sites)
- A form becomes *dirty* only on a **trusted** (`isTrusted`) `input`/`change` event on an eligible,
  non-excluded control. Programmatic changes (site scripts, Refill's own fill) never mark dirty.
- While dirty: debounce 1.5 s → seal draft (works locked) → clean. `visibilitychange:hidden`
  flushes only if dirty. Untouched pages produce nothing.
- Draft identity: origin + path + form fingerprint; same document keeps updating one draft id.
- Return visit, unlocked: SW decrypts drafts for this origin; if a draft's fingerprint overlaps the
  page's forms ≥ 0.7 → toast `Restore draft from 12 min ago · 9 fields  [Restore] [Discard]`.
  Restore fills only empty fields. **Never auto-restored.** If a profile also applies, the profile
  fills first and one combined toast offers the draft.
- Locked: popup shows "Unlock to check for drafts" on protected sites.
- Clear on success: on trusted `submit`, mark pending; on next load of the same origin, if the form
  fingerprint is absent → delete; if present (validation failed) → keep.
- TTL per site: 1 h / 1 day / **7 days (default)** / 30 days / no expiry. `alarms` sweep hourly and
  on startup deletes expired drafts (works while locked — `expiresAt` is plaintext).
- Global drafts (Settings): requests `https://*/*` after a full-screen warning explaining that
  Refill will then see and store what you type on every site. Off by default.

### 6.5 Toast & badge
- Closed shadow root, rendered in the top layer (`popover="manual"`), top-right, auto-hide 6 s,
  persists on hover/focus, keyboard reachable, `prefers-reduced-motion` and dark mode aware.
- Toast contains **no inputs** and no secret values. Toast is cosmetic, not a security boundary.
- Per-tab badge: count of filled fields, `●` while recording, `🔒` when a profile waits on unlock.

### 6.6 Popup states
- Site not enabled: Record this site · Protect drafts here.
- Site enabled: profile card (name, steps, last used, fill mode) · Fill now · Edit · Drafts toggle ·
  Remove site.
- Locked: Touch ID button (if enrolled) · passphrase field · Unlock.

### 6.7 Dashboard
Sites list (search) → site detail: profile (steps, field table with policy, edit values,
path prefix, fill mode) and drafts (preview, restore-in-tab, delete) → Settings (lock policy,
Touch ID, default TTL, global drafts, change passphrase) → Export/Import → About/Security.

---

## 7. Messaging protocol
- One typed discriminated-union protocol (`src/shared/messages.ts`).
- SW router validates **every** message:
  - `sender.id === chrome.runtime.id`.
  - Content-script messages: `sender.tab` present, `sender.frameId === 0`, `sender.origin` is an
    enabled, granted, https site; the origin used is always `sender.origin`, never from payload.
    Allowed types: `scan-report`, `fill-request` (returns only values for that origin's
    profile, only fields allowed by mode/policy), `record-capture` (only with an active session
    for that tab+origin), `draft-seal`, `draft-offer-query`, `toast-unlock-click`.
  - Extension-page messages: `sender.url` starts with `chrome-extension://<id>/` and no content
    script context; all vault/admin operations are page-only.
- Payload size caps and schema checks on every message.

---

## 8. Security

### 8.1 Assets
Saved field values, drafts, passphrase, DEK/KEKs, PRF secret, the list of enabled sites (low).

### 8.2 Adversaries (in scope)
Hostile web pages; compromised/XSS'd target site; malicious other extensions; local attacker with
read/write access to the browser profile on disk; supply-chain attacker (npm); hijacked
publisher account / malicious update.

### 8.3 Out of scope / accepted residual risk
- Malware with OS-level access (keyloggers, memory readers).
- Scripts on the *same* origin reading values after Refill fills them. With Auto mode this happens
  without a user action; mitigated (visible, eligible, current-step, once-per-document,
  same-origin form action) to roughly the exposure of typing it yourself. Users can set a profile
  to One gesture.
- DEK raw bytes in `storage.session` RAM may be paged to disk.
- LevelDB may retain deleted ciphertext until compaction (ciphertext only).

### 8.4 Controls summary
Covered in §3–§7: minimal permissions, exact-origin https matching, top-frame only, never-capture
list, mandatory review, AAD-bound AES-GCM, Argon2id, write-only draft sealing, idle/hard-max lock,
no in-page secret input, `externally_connectable` lockdown, sender validation, strict CSP, no
`{@html}`/`innerHTML` with page-derived data (lint-enforced), no network, zero runtime deps in SW
and content script except the vendored Argon2 WASM.

### 8.5 Audit process
- `docs/security/threat-model.md` (STRIDE per component) maintained with the code.
- CI gates: CodeQL, Semgrep (custom rules: no `fetch`, no `innerHTML`, no `chrome.storage.sync`,
  no `{@html}`), `pnpm audit` + osv-scanner, secret scanning, manifest/CSP snapshot,
  reproducible-build check (two clean builds → identical zip hash).
- Adversarial e2e fixtures: hidden honeypot fields, all-steps-at-once honeypot page, cross-origin
  iframe, lookalike/punycode origin, http downgrade, password-type flip, forged toast, content
  script sending spoofed origin / admin messages, tampered & swapped ciphertexts.
- Crypto: known-answer tests, wrong-AAD / wrong-key / truncated-ciphertext failure tests.
- **Release audit:** 2–3 fresh-context reviewer agents audit the code against the threat model, plus a
  red-team agent against the fixtures. Every finding → GitHub issue → fixed or explicitly
  accepted (with rationale) before tagging.
- Publishing: Chrome Web Store verified CRX uploads; hardware-key 2FA on publisher account;
  no store credentials in CI; manual upload of the release-built zip. `SECURITY.md`
  (disclosure), `PRIVACY.md`, store data disclosures.

---

## 9. UX & visual design
- Calm, utility aesthetic; one accent color; system font stack; light/dark; 4/8 px spacing grid.
- Popup ≤ 360 × 520; dashboard responsive; WCAG 2.2 AA contrast; full keyboard support.
- Detailed visual design produced during milestone M6 (frontend-design pass), not in this spec.

---

## 10. Engineering & SDLC
- **Repo:** `~/projects/refill`, public GitHub, MIT. Protected `main`; branch + PR per task;
  conventional commits; SemVer; release-please changelog; GitHub release with zip + SBOM.
- **Docs:** README, this spec, implementation plans, `docs/adr/` (Argon2 lib, PRF, signature
  matching, unlisted content script, draft sealing), threat model, SECURITY.md, PRIVACY.md,
  `docs/research/prior-art.md`.
- **Tooling:** pnpm, WXT, TypeScript strict, Svelte 5, ESLint (+ security rules), Prettier,
  svelte-check.
- **Testing (TDD):**
  - Unit (Vitest): crypto, store queue, matcher, policies, router validation, TTL.
  - Browser-mode Vitest (real Chromium): fill engine & recorder against React/Vue/Angular controlled
    inputs, masked inputs, shadow DOM.
  - E2E (Playwright, Chromium with `--load-extension`): local fixture sites on two origins —
    SPA wizard on one URL, POST wizard with fake viewstate/CSRF, random ids, masked inputs,
    react-select (expect "can't fill"), cross-origin iframe (expect no fill), adversarial set.
    A test-only build flag pre-grants fixture origins and allows `http://localhost`; the manifest
    snapshot test proves it is absent from production builds.
  - Manual Brave smoke test checklist before each release.
- **CI (GitHub Actions):** lint, typecheck, unit, browser-unit, e2e, CodeQL, Semgrep, osv-scanner,
  manifest snapshot, reproducible build.

### 10.1 Milestones
- **M0** Spike: WebAuthn PRF + Touch ID from a Brave extension page; repo scaffold; CI.
- **M1** Crypto & vault (KDF, wrap, records, lock policy, Touch ID if spike passes).
- **M2** Sites & permissions reconciler; content script scan + fill engine.
- **M3** Recorder + review page.
- **M4** Return-visit fill, toast, badge, Fix mode, unlock flow.
- **M5** Drafts (sealing, offer/restore, clear-on-success, TTL, global mode).
- **M6** Design pass: popup, dashboard, onboarding.
- **M7** Hardening + release audit.
- **M8** Store listing & submission.

---

## 11. Risks & open questions
| Risk | Plan |
|---|---|
| PRF + Touch ID unavailable in Brave extension pages (rpId = extension origin) | M0 spike; if it fails, ship passphrase-only v1, Touch ID via native helper in v2 |
| WXT runtime content-script registration quirks | Unlisted script + manual `registerContentScripts`; covered by e2e |
| `chrome.action.openPopup()` rejected from toast click | Text fallback already in design |
| Argon2 WASM library choice | ADR in M1: small, audited, vendored, pinned |
| "Refill" name taken on the store | Check in M8; fallback names: FormKeep, Stash |
| Bill-pay sites behind payment processors with iframes | Out of scope v1; browser card autofill |
