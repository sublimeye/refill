<script lang="ts">
  import { tick } from "svelte";
  import { MessagingError, sendToSw } from "../../lib/messaging/protocol";
  import { scorePassphrase } from "../../lib/passphrase/strength";

  let passphrase = $state("");
  let confirmation = $state("");
  let acknowledged = $state(false);
  let busy = $state(false);
  let done = $state(false);
  let error = $state("");
  let message: HTMLElement | undefined = $state();

  const strength = $derived(scorePassphrase(passphrase));
  const matches = $derived(passphrase === confirmation);
  const canCreate = $derived(
    acknowledged && strength.acceptable && matches && !busy,
  );

  async function announce() {
    await tick();
    message?.focus();
  }

  async function create(event: SubmitEvent) {
    event.preventDefault();
    if (!canCreate) return;
    busy = true;
    error = "";
    // Held in a local and cleared from the page at once; any failure means retyping both.
    const attempt = passphrase;
    passphrase = "";
    confirmation = "";
    try {
      const res = await sendToSw({ type: "vault-create", passphrase: attempt });
      if (res.ok) {
        done = true;
      } else if (res.error === "exists") {
        error = "A Refill vault already exists. Open Refill from the toolbar.";
      } else {
        error = "That passphrase is too short or too weak.";
      }
    } catch (err) {
      error =
        err instanceof MessagingError
          ? "Refill could not create the vault. Try again."
          : "Something went wrong. Try again.";
    } finally {
      busy = false;
    }
    await announce();
  }
</script>

<main>
  <h1>Create your Refill passphrase</h1>
  <p>
    Refill encrypts everything it saves with this passphrase. There is no
    recovery: if you forget it, your saved forms are gone.
  </p>

  {#if done}
    <p bind:this={message} tabindex="-1" aria-live="polite">
      Refill is ready. Pin it to your toolbar, then open a form you fill often.
    </p>
  {:else}
    <form onsubmit={create}>
      <p>
        <label for="passphrase">Passphrase</label><br />
        <input
          id="passphrase"
          type="password"
          autocomplete="new-password"
          maxlength="1024"
          aria-describedby="strength"
          bind:value={passphrase}
          disabled={busy}
        />
      </p>
      <!-- Not a live region: it changes on every keystroke and would be announced constantly. -->
      <p id="strength">
        {#if passphrase.length > 0}
          Strength: {strength.score} of 4. {strength.feedback}
        {/if}
      </p>
      <p>
        <label for="confirmation">Confirm passphrase</label><br />
        <input
          id="confirmation"
          type="password"
          autocomplete="new-password"
          maxlength="1024"
          aria-describedby="mismatch"
          bind:value={confirmation}
          disabled={busy}
        />
      </p>
      <p id="mismatch">
        {#if confirmation.length > 0 && !matches}
          Passphrases don't match
        {/if}
      </p>
      <p>
        <label>
          <input type="checkbox" bind:checked={acknowledged} disabled={busy} />
          I understand there is no recovery
        </label>
      </p>
      <button type="submit" disabled={!canCreate}>Create vault</button>
    </form>
    <div aria-live="polite">
      {#if error}
        <p bind:this={message} tabindex="-1">{error}</p>
      {/if}
    </div>
  {/if}
</main>

<style>
  main {
    max-width: 32rem;
    margin: 2rem auto;
    padding: 0 1rem;
    font-family: system-ui, sans-serif;
  }
  input[type="password"] {
    width: 100%;
    box-sizing: border-box;
  }
</style>
