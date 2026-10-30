<script lang="ts">
  import { onMount, tick } from "svelte";
  import { browser } from "wxt/browser";
  import { sendToSw } from "../../lib/messaging/protocol";
  import type { VaultStatus } from "../../lib/vault/types";
  import {
    cancelRecordingFor,
    enableSite,
    fillNowFor,
    finishRecordingFor,
    loadSiteView,
    recordSite,
    recordingLine,
    removeSiteFor,
    resolveTarget,
    savedLine,
    sequencedSite,
    viewSavedFor,
    type SiteView,
  } from "../../lib/sites/popup-site";

  type Active = Extract<SiteView, { kind: "off" | "on" | "revoked" }>;

  type View = "loading" | "none" | "corrupt" | "locked" | "unlocked" | "failed";

  let view = $state<View>("loading");
  let passphrase = $state("");
  let busy = $state(false);
  let error = $state("");
  let restored = $state(false);
  let message: HTMLElement | undefined = $state();

  // "This site" section (shown once a vault exists; no secrets are involved, so locked is fine).
  let site = $state<SiteView | null>(null);
  // Every assignment to `site` goes through `siteSeq`: a load that resolves late (the unlock path,
  // a slow tab query) must not overwrite a view assigned after it began.
  const siteSeq = sequencedSite((v) => (site = v));
  let siteBusy = $state(false);
  let siteError = $state("");
  let confirming = $state(false);
  let siteStatus: HTMLElement | undefined = $state();
  let siteMessage: HTMLElement | undefined = $state();
  let confirmText: HTMLElement | undefined = $state();
  let removeButton: HTMLElement | undefined = $state();

  const DAMAGED = "Refill's vault data is damaged";
  const GENERIC = "Something went wrong — try again";
  const TAB_MOVED =
    "This tab moved to another site — open the form and try again.";

  function viewOf(s: VaultStatus): View {
    return s.state;
  }

  async function focusMessage() {
    await tick();
    message?.focus();
  }

  async function announce(text: string) {
    error = text;
    await focusMessage();
  }

  async function refresh() {
    try {
      view = viewOf(await sendToSw({ type: "vault-status" }));
    } catch {
      view = "failed";
      await focusMessage();
    }
  }

  async function retry() {
    view = "loading";
    await refresh();
  }

  function loadSite(): Promise<void> {
    return siteSeq.load(async () => {
      const target = await resolveTarget();
      return target ? await loadSiteView(target) : { kind: "unsupported" };
    });
  }

  onMount(async () => {
    await refresh();
    if (view === "locked" || view === "unlocked") await loadSite();
  });

  // Click handler for "Enable Refill on this site" / "Enable again".
  // permissions.request needs the click's user activation (ADR 0018): enableSite() must be the
  // FIRST statement and nothing may be awaited before it. Everything after runs later.
  function enable(s: Active) {
    const flow = enableSite(s);
    siteBusy = true;
    siteError = "";
    void settleEnable(flow);
  }

  async function settleEnable(flow: ReturnType<typeof enableSite>) {
    try {
      const res = await flow;
      siteSeq.set(res.view);
      if (res.outcome === "denied") {
        await announceSite("Access to this site wasn't granted");
      } else if (res.view.kind !== "on") {
        await announceSite(GENERIC);
      } else {
        await tick();
        siteStatus?.focus();
      }
    } finally {
      siteBusy = false;
    }
  }

  // Click handler for "Record this site" / "Record again". Same rule as enable(): recordSite() must
  // be the FIRST statement, nothing awaited before it (user activation, ADR 0018).
  function record(s: Active) {
    const flow = recordSite(s);
    siteBusy = true;
    siteError = "";
    void settleRecord(flow);
  }

  async function settleRecord(flow: ReturnType<typeof recordSite>) {
    try {
      const res = await flow;
      siteSeq.set(res.view);
      switch (res.outcome) {
        case "recording":
          await tick();
          siteStatus?.focus();
          break;
        case "denied":
          await announceSite("Access to this site wasn't granted");
          break;
        case "locked":
          await refresh(); // the vault locked meanwhile: show the unlock form
          await announceSite("Refill locked — unlock, then record again.");
          break;
        case "tab-moved":
          await announceSite(TAB_MOVED);
          break;
        default:
          break; // granted-pending: the grant path finishes it
      }
    } finally {
      siteBusy = false;
    }
  }

  // "Finish" and "Open review": the worker opens the review page; this popup is done.
  async function finishRecording(s: Active) {
    if (siteBusy) return;
    siteBusy = true;
    siteError = "";
    try {
      if (await finishRecordingFor(s)) {
        window.close();
        return;
      }
      await announceSite(GENERIC);
    } finally {
      siteBusy = false;
    }
  }

  // "View": the review page in saved mode for this site's saved form (ADR 0035); this popup is done.
  async function viewSaved(s: Active) {
    if (siteBusy || s.saved === null) return;
    siteBusy = true;
    siteError = "";
    try {
      if (await viewSavedFor(s.saved)) {
        window.close();
        return;
      }
      await announceSite(GENERIC);
    } finally {
      siteBusy = false;
    }
  }

  // "Fill now": a one-time grant for this tab, then the page fills; this popup is done (ADR 0038).
  async function fillNow(s: Active) {
    if (siteBusy) return;
    siteBusy = true;
    siteError = "";
    try {
      switch (await fillNowFor(s)) {
        case "ok":
          window.close();
          return;
        case "locked":
          await refresh(); // the vault locked meanwhile: show the unlock form
          await announceSite("Refill locked — unlock, then fill again.");
          break;
        case "tab-moved":
          await announceSite(TAB_MOVED);
          break;
        default:
          await announceSite(GENERIC);
      }
    } finally {
      siteBusy = false;
    }
  }

  async function cancelRecording(s: Active) {
    if (siteBusy) return;
    siteBusy = true;
    siteError = "";
    try {
      const res = await cancelRecordingFor(s);
      siteSeq.set(res.view);
      if (res.ok) {
        await tick();
        siteStatus?.focus();
      } else {
        await announceSite(GENERIC);
      }
    } finally {
      siteBusy = false;
    }
  }

  async function announceSite(text: string) {
    siteError = text;
    await tick();
    siteMessage?.focus();
  }

  async function askRemove() {
    confirming = true;
    siteError = "";
    await tick();
    confirmText?.focus();
  }

  async function cancelRemove() {
    confirming = false;
    await tick();
    removeButton?.focus();
  }

  async function confirmRemove(s: Active) {
    if (siteBusy) return;
    siteBusy = true;
    siteError = "";
    try {
      const res = await removeSiteFor(s);
      confirming = false;
      siteSeq.set(res.view);
      if (res.ok) {
        await tick();
        siteStatus?.focus();
      } else {
        await announceSite(GENERIC);
      }
    } finally {
      siteBusy = false;
    }
  }

  async function setUp() {
    try {
      await browser.tabs.create({
        url: browser.runtime.getURL("/onboarding.html"),
      });
      window.close();
    } catch {
      view = "failed";
      await focusMessage();
    }
  }

  async function unlock(event: SubmitEvent) {
    event.preventDefault();
    if (busy) return;
    busy = true;
    error = "";
    const attempt = passphrase;
    passphrase = "";
    try {
      const res = await sendToSw({ type: "vault-unlock", passphrase: attempt });
      if (res.ok) {
        restored = res.warning === "integrity-restored";
        await refresh();
        // The site view was read while locked: its saved-form line (ADR 0035) needs the
        // unlocked vault, so read it again.
        if (view === "unlocked") await loadSite();
        return;
      }
      switch (res.reason) {
        case "wrong-passphrase":
          await announce("Wrong passphrase");
          break;
        case "backoff":
          await announce(
            `Too many attempts — try again in ${Math.max(1, Math.ceil((res.retryAfterMs ?? 0) / 1000))} s`,
          );
          break;
        case "corrupt":
          view = "corrupt";
          await focusMessage();
          break;
        case "no-vault":
          view = "none";
          break;
        case "locked-during-unlock":
          await announce("Refill locked while unlocking — try again");
          break;
      }
    } catch {
      await announce(GENERIC);
    } finally {
      busy = false;
    }
  }

  async function lockNow() {
    if (busy) return;
    busy = true;
    error = "";
    try {
      await sendToSw({ type: "vault-lock" });
      restored = false;
      await refresh();
    } catch {
      await announce(GENERIC);
    } finally {
      busy = false;
    }
  }
</script>

{#snippet recordControls(s: Active)}
  {#if view === "locked"}
    <p>Unlock to record this site.</p>
  {:else}
    {#if s.recording.state === "review"}
      <p>
        A finished recording is waiting for review. Starting here discards it.
      </p>
    {:else if s.recording.state !== "off"}
      <p>Refill is recording in another tab. Starting here stops it.</p>
    {:else if s.kind === "off"}
      <p>
        Refill will ask Chrome for access to this site only, then remember what
        you type.
      </p>
    {:else if s.hasProfile}
      <p>Your saved form fills in as you go; change what's different.</p>
    {/if}
    <button type="button" onclick={() => record(s)} disabled={siteBusy}>
      {s.recording.state === "off" && s.kind === "on" && s.hasProfile
        ? "Record again"
        : "Record this site"}
    </button>
  {/if}
{/snippet}

{#snippet siteSection()}
  {#if site && site.kind !== "error"}
    <section aria-labelledby="site-title">
      <h2 id="site-title">This site</h2>
      {#if site.kind === "unsupported"}
        <p bind:this={siteStatus} tabindex="-1">
          Refill works on secure (https) sites only.
        </p>
      {:else}
        {@const s = site}
        {@const rec = s.recording}
        {#if rec.state === "review" && rec.here}
          <p bind:this={siteStatus} tabindex="-1">
            {recordingLine(rec)}
          </p>
          <button
            type="button"
            onclick={() => finishRecording(s)}
            disabled={siteBusy}
          >
            Open review
          </button>
        {:else if rec.state !== "off" && rec.state !== "review" && rec.here}
          <p bind:this={siteStatus} tabindex="-1">
            {recordingLine(rec)}
          </p>
          <button
            type="button"
            onclick={() => finishRecording(s)}
            disabled={siteBusy}
          >
            Finish
          </button>
          <button
            type="button"
            onclick={() => cancelRecording(s)}
            disabled={siteBusy}
          >
            Cancel recording
          </button>
        {:else if s.kind === "off"}
          <p bind:this={siteStatus} tabindex="-1">
            Refill will ask Chrome for access to this site only.
          </p>
          <button type="button" onclick={() => enable(s)} disabled={siteBusy}>
            Enable Refill on this site
          </button>
          {@render recordControls(s)}
        {:else if s.kind === "revoked"}
          <p bind:this={siteStatus} tabindex="-1">
            Access to {s.host} was turned off in Chrome. Enable again to use Refill
            here.
          </p>
          <button type="button" onclick={() => enable(s)} disabled={siteBusy}>
            Enable again
          </button>
        {:else if confirming}
          <p bind:this={confirmText} tabindex="-1">
            Remove {s.host} and its saved form?
          </p>
          <button
            type="button"
            onclick={() => confirmRemove(s)}
            disabled={siteBusy}
          >
            Remove
          </button>
          <button type="button" onclick={cancelRemove} disabled={siteBusy}>
            Cancel
          </button>
        {:else}
          <p bind:this={siteStatus} tabindex="-1">Enabled on {s.host}</p>
          <!-- The saved form's line (ADR 0035). Its count is read from the sealed record, so it
               shows only while unlocked; a Lock now in this popup hides it at once. -->
          {#if view === "unlocked" && s.saved}
            <p id="saved-line">{savedLine(s.saved.count)}</p>
            <button
              type="button"
              aria-describedby="saved-line"
              onclick={() => viewSaved(s)}
              disabled={siteBusy}
            >
              View
            </button>
            {#if s.saved.fillMode === "gesture" && rec.state === "off"}
              <button
                type="button"
                onclick={() => fillNow(s)}
                disabled={siteBusy}
              >
                Fill now
              </button>
            {/if}
          {/if}
          {@render recordControls(s)}
          <button
            type="button"
            bind:this={removeButton}
            onclick={askRemove}
            disabled={siteBusy}
          >
            Remove site
          </button>
        {/if}
      {/if}
      <div aria-live="polite">
        {#if siteError}
          <p bind:this={siteMessage} tabindex="-1">{siteError}</p>
        {/if}
      </div>
    </section>
  {:else if site}
    <section aria-labelledby="site-title">
      <h2 id="site-title">This site</h2>
      <p>{GENERIC}</p>
    </section>
  {/if}
{/snippet}

<main>
  {#if view === "loading"}
    <p>Loading…</p>
  {:else if view === "none"}
    <button type="button" onclick={setUp}>Set up Refill</button>
  {:else if view === "corrupt"}
    <p bind:this={message} tabindex="-1" aria-live="polite">{DAMAGED}</p>
  {:else if view === "failed"}
    <p bind:this={message} tabindex="-1" aria-live="polite">{GENERIC}</p>
    <button type="button" onclick={retry}>Try again</button>
  {:else if view === "locked"}
    <form onsubmit={unlock}>
      <p>
        <label for="passphrase">Passphrase</label><br />
        <input
          id="passphrase"
          type="password"
          autocomplete="current-password"
          maxlength="1024"
          bind:value={passphrase}
          disabled={busy}
        />
      </p>
      <button type="submit" disabled={busy || passphrase.length === 0}>
        Unlock
      </button>
    </form>
    <div aria-live="polite">
      {#if error}
        <p bind:this={message} tabindex="-1">{error}</p>
      {/if}
    </div>
    {@render siteSection()}
  {:else}
    {#if restored}
      <p role="status">
        Some vault settings were changed outside Refill and have been restored.
      </p>
    {/if}
    <p>Unlocked</p>
    <button type="button" onclick={lockNow} disabled={busy}>Lock now</button>
    <div aria-live="polite">
      {#if error}
        <p bind:this={message} tabindex="-1">{error}</p>
      {/if}
    </div>
    {@render siteSection()}
  {/if}
</main>

<style>
  main {
    min-width: 16rem;
    padding: 0.75rem;
    font-family: system-ui, sans-serif;
  }
</style>
