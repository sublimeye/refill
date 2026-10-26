<script lang="ts">
  import { onMount, tick } from "svelte";
  import { browser } from "wxt/browser";
  import { sendToSw } from "../../lib/messaging/protocol";
  import type { VaultStatus } from "../../lib/vault/types";

  type View = "loading" | "none" | "corrupt" | "locked" | "unlocked" | "failed";

  let view = $state<View>("loading");
  let passphrase = $state("");
  let busy = $state(false);
  let error = $state("");
  let restored = $state(false);
  let message: HTMLElement | undefined = $state();

  const DAMAGED = "Refill's vault data is damaged";
  const GENERIC = "Something went wrong — try again";

  function viewOf(s: VaultStatus): View {
    return s.state;
  }

  async function announce(text: string) {
    error = text;
    await tick();
    message?.focus();
  }

  async function refresh() {
    try {
      view = viewOf(await sendToSw({ type: "vault-status" }));
    } catch {
      view = "failed";
    }
  }

  onMount(refresh);

  async function setUp() {
    await browser.tabs.create({
      url: browser.runtime.getURL("/onboarding.html"),
    });
    window.close();
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

<main>
  {#if view === "loading"}
    <p>Loading…</p>
  {:else if view === "none"}
    <button type="button" onclick={setUp}>Set up Refill</button>
  {:else if view === "corrupt"}
    <p bind:this={message} tabindex="-1" aria-live="polite">{DAMAGED}</p>
  {:else if view === "failed"}
    <p bind:this={message} tabindex="-1" aria-live="polite">{GENERIC}</p>
  {:else if view === "locked"}
    <form onsubmit={unlock}>
      <p>
        <label for="passphrase">Passphrase</label><br />
        <input
          id="passphrase"
          type="password"
          autocomplete="current-password"
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
  {/if}
</main>

<style>
  main {
    min-width: 16rem;
    padding: 0.75rem;
    font-family: system-ui, sans-serif;
  }
</style>
