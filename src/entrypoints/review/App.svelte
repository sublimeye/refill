<script lang="ts">
  // The review page (spec §6.2, ADR 0033): what a finished recording captured, masked until the
  // user asks, a policy per field, the form's name, fill mode and path prefix, then Save or
  // Discard. Values are rendered as text only. Every reveal, and every return to the page, is
  // re-confirmed with the worker first (ruling P15): after a lock, an expiry or a cancel the page
  // drops the recording and shows the gone copy. The worker's data-free "check again" message
  // triggers the same check, so a lock elsewhere hides a revealed value with no action here (I3).
  // Saved mode (ADR 0035, `?saved=<profile id>`): the same page for the site's saved form, with
  // Close instead of Discard; a lock or the site's removal ends it the same way.
  import { onMount, tick } from "svelte";
  import { onRecheck } from "../../lib/messaging/recheck";
  import {
    applyLoad,
    discardReview,
    displayValue,
    endReview,
    loadReview,
    newPage,
    notSaved,
    pageKeyFrom,
    recheckReview,
    saveReview,
    stepNumber,
    toggleValue,
    type FormProblem,
  } from "../../lib/recorder/review-flow";

  const MASK = "••••••";
  const GENERIC = "Something went wrong — try again";
  const PROBLEMS: Record<FormProblem, string> = {
    name: "Enter a name",
    path: "The path must start with / and cover every recorded page",
  };

  const key = pageKeyFrom(globalThis.location?.search ?? "");
  const savedMode = key?.mode === "saved";
  const GONE = savedMode
    ? "This saved form is no longer shown: Refill locked, or the site was removed. Open it again from the Refill button."
    : "This recording is no longer available. Recordings end when Refill locks, after 30 minutes, when you cancel them, or when the site is removed.";
  const SAVED = savedMode
    ? "Saved. Refill uses your changes the next time you open this form."
    : "Saved. Refill will fill this form the next time you open it.";
  if (savedMode) document.title = "Saved form · Refill";

  const page = $state(newPage());
  let busy = $state(false);
  /** A check was asked for while a save or discard was in flight (see `recheck`). */
  let recheckWhenIdle = false;
  let problem = $state<FormProblem | null>(null);
  let failed = $state(false);

  let message: HTMLElement | undefined = $state();
  let failure: HTMLElement | undefined = $state();
  let nameInput: HTMLInputElement | undefined = $state();
  let prefixInput: HTMLInputElement | undefined = $state();

  /** The review ended (saved, gone, discarded) or failed to load: its message takes focus. */
  async function focusMessage() {
    await tick();
    message?.focus();
  }

  async function load() {
    applyLoad(page, await loadReview(key));
    if (page.view !== "ready") await focusMessage();
  }

  /**
   * Asks the worker whether the recording is still there and ends the review if not (ruling P15).
   * While a save or discard is in flight its own answer settles the page; the check runs after it.
   */
  function recheck() {
    if (key === null) return;
    if (busy) {
      recheckWhenIdle = true;
      return;
    }
    void recheckReview(page, key).then((ended) =>
      ended ? focusMessage() : undefined,
    );
  }

  /** After a save or discard: a check asked for meanwhile runs now (a no-op once the page ended). */
  function idle() {
    if (!recheckWhenIdle) return;
    recheckWhenIdle = false;
    recheck();
  }

  onMount(() => {
    void load();
    // The worker's signal (a lock in another window, an expiry, a new recording, a removed site):
    // check now, so a revealed value does not stay on screen (I3, ADR 0035).
    const stop = onRecheck(recheck);
    // Back to the page (another tab, the screen unlocked): drop the recording if it is gone.
    const onVisible = () => {
      if (document.visibilityState === "visible") recheck();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisible);
    };
  });

  async function retry() {
    page.view = "loading";
    await load();
  }

  async function announceFailure() {
    failed = true;
    await tick();
    failure?.focus();
  }

  async function toggle(i: number) {
    if (key === null) return;
    failed = false;
    const out = await toggleValue(page, key, i);
    if (out === "gone") await focusMessage();
    else if (out === "failed") await announceFailure();
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || page.form === null || key === null) return;
    busy = true;
    problem = null;
    failed = false;
    // saveReview never throws. The controls are enabled again before focus moves to one of them.
    const out = await saveReview(key, page.form);
    busy = false;
    switch (out) {
      case "saved":
      case "gone":
        endReview(page, out);
        await focusMessage();
        break;
      case "failed":
        await announceFailure();
        break;
      default:
        problem = out;
        await tick();
        (out === "name" ? nameInput : prefixInput)?.focus();
    }
    idle();
  }

  async function discard() {
    if (busy || key === null || key.mode !== "review") return;
    busy = true;
    problem = null;
    failed = false;
    const ok = await discardReview(key.id); // never throws
    busy = false;
    if (ok) {
      endReview(page, "discarded");
      await focusMessage();
    } else {
      await announceFailure();
    }
    idle();
  }

  // Saved mode: nothing to undo on the worker. The page drops the form and its values, then closes
  // its tab (a tab with one history entry may close itself); if it cannot, the copy stays.
  async function close() {
    if (busy) return;
    endReview(page, "closed");
    await focusMessage();
    window.close();
  }
</script>

<main>
  {#if page.view === "loading"}
    <p>Loading…</p>
  {:else if page.view === "saved"}
    <p bind:this={message} tabindex="-1" role="status">{SAVED}</p>
  {:else if page.view === "gone"}
    <p bind:this={message} tabindex="-1" role="status">{GONE}</p>
  {:else if page.view === "discarded"}
    <p bind:this={message} tabindex="-1" role="status">
      Discarded. Nothing was saved.
    </p>
  {:else if page.view === "closed"}
    <p bind:this={message} tabindex="-1" role="status">
      Closed. Nothing was changed.
    </p>
  {:else if page.view === "failed"}
    <p bind:this={message} tabindex="-1" role="status">{GENERIC}</p>
    <button type="button" onclick={retry}>Try again</button>
  {:else if page.model && page.form}
    {@const model = page.model}
    {@const form = page.form}
    <!-- At "/" the prefix covers the whole site: there is no "elsewhere" to explain. -->
    {@const wholeSite = form.pathPrefix === "/"}
    {#if savedMode}
      <h1>Saved form for {model.host}</h1>
    {:else}
      <h1>Review what Refill recorded on {model.host}</h1>
    {/if}
    {#if model.fields.length === 0 && !savedMode}
      <p>
        Nothing was recorded. Type into the form while recording, then finish.
      </p>
      <button type="button" onclick={discard} disabled={busy}>Discard</button>
    {:else}
      {#if page.replacesProfile}
        <p>Saving replaces the form saved for {model.host}.</p>
      {/if}
      <form onsubmit={save} novalidate>
        <table>
          <thead>
            <tr>
              <th scope="col">Step</th>
              <th scope="col">Field</th>
              <th scope="col">Value</th>
              <th scope="col" id="col-when">When I return</th>
            </tr>
          </thead>
          <tbody>
            {#each model.fields as field, i (field.id)}
              <!-- Saved mode: a "Don't save" field holds no value (ADR 0035). -->
              {@const empty = notSaved(key, field)}
              <tr>
                <td>{stepNumber(model, field.step)}</td>
                <th scope="row" id={`field-${i}`}>{field.label}</th>
                <td>
                  {#if empty}
                    <span class="value">Not saved</span>
                  {:else}
                    <span class="value"
                      >{page.shown[i] ? displayValue(field) : MASK}</span
                    >
                    <!-- A visible Show/Hide label, no aria-pressed (ruling P16); the accessible name
                         carries the field's label so each button says what it reveals. -->
                    <button
                      type="button"
                      aria-label={`${page.shown[i] ? "Hide" : "Show"} ${field.label}`}
                      onclick={() => toggle(i)}
                    >
                      {page.shown[i] ? "Hide" : "Show"}
                    </button>
                  {/if}
                </td>
                <td>
                  <select
                    aria-labelledby={`col-when field-${i}`}
                    aria-describedby={empty ? `hint-${i}` : undefined}
                    bind:value={form.policies[i]!.policy}
                    disabled={busy}
                  >
                    <option value="save" disabled={empty}>Fill it in</option>
                    <option value="ask">Ask me</option>
                    <option value="skip">Don't save</option>
                  </select>
                  {#if empty}
                    <br /><span id={`hint-${i}`} class="hint"
                      >Record again to capture it</span
                    >
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>

        <p>
          <label for="name">Name</label><br />
          <input
            id="name"
            type="text"
            maxlength="120"
            autocomplete="off"
            bind:this={nameInput}
            bind:value={form.name}
            aria-invalid={problem === "name" ? "true" : undefined}
            aria-describedby={problem === "name" ? "name-error" : undefined}
            disabled={busy}
          />
          {#if problem === "name"}
            <br /><span id="name-error">{PROBLEMS.name}</span>
          {/if}
        </p>

        <fieldset>
          <legend>Fill mode</legend>
          <label>
            <input
              type="radio"
              name="fill-mode"
              value="auto"
              bind:group={form.fillMode}
              disabled={busy}
            />
            Fill automatically when I open the page
          </label><br />
          <label>
            <input
              type="radio"
              name="fill-mode"
              value="gesture"
              bind:group={form.fillMode}
              disabled={busy}
            />
            Fill only when I click Fill now in Refill
          </label>
        </fieldset>

        <p>
          <label for="prefix">Fills on pages under</label><br />
          <input
            id="prefix"
            type="text"
            maxlength="256"
            autocomplete="off"
            spellcheck="false"
            bind:this={prefixInput}
            bind:value={form.pathPrefix}
            aria-invalid={problem === "path" ? "true" : undefined}
            aria-describedby={[
              wholeSite ? null : "prefix-hint",
              problem === "path" ? "prefix-error" : null,
            ]
              .filter((id) => id !== null)
              .join(" ") || undefined}
            disabled={busy}
          />
          {#if !wholeSite}
            <br /><span id="prefix-hint"
              >Elsewhere on {model.host}, Refill fills only pages that look like
              this form.</span
            >
          {/if}
          {#if problem === "path"}
            <br /><span id="prefix-error">{PROBLEMS.path}</span>
          {/if}
        </p>

        <button type="submit" disabled={busy}>Save</button>
        {#if savedMode}
          <button type="button" onclick={close} disabled={busy}>Close</button>
        {:else}
          <button type="button" onclick={discard} disabled={busy}>
            Discard
          </button>
        {/if}
      </form>
    {/if}
    <div aria-live="polite">
      {#if failed}
        <p bind:this={failure} tabindex="-1">{GENERIC}</p>
      {/if}
    </div>
  {/if}
</main>

<style>
  main {
    max-width: 48rem;
    margin: 2rem auto;
    padding: 0 1rem;
    font-family: system-ui, sans-serif;
  }
  table {
    border-collapse: collapse;
    margin-bottom: 1rem;
  }
  th,
  td {
    border-bottom: 1px solid #ccc;
    padding: 0.4rem 0.6rem;
    text-align: left;
    vertical-align: middle;
  }
  .value {
    display: inline-block;
    min-width: 8rem;
    font-family: ui-monospace, monospace;
    overflow-wrap: anywhere;
  }
  fieldset {
    margin: 0 0 1rem;
  }
  .hint {
    font-size: 0.85em;
  }
  input[type="text"] {
    width: 100%;
    max-width: 24rem;
    box-sizing: border-box;
  }
</style>
