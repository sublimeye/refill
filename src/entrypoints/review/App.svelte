<script lang="ts">
  // The review page (spec §6.2, ADR 0033): what a finished recording captured, masked until the
  // user asks, a policy per field, the form's name, fill mode and path prefix, then Save or
  // Discard. Values are rendered as text only. Every reveal, and every return to the page, is
  // re-confirmed with the worker first (ruling P15): after a lock, an expiry or a cancel the page
  // drops the recording and shows the gone copy.
  import { onMount, tick } from "svelte";
  import {
    applyLoad,
    discardReview,
    displayValue,
    endReview,
    loadReview,
    newPage,
    recheckReview,
    saveReview,
    sessionIdFrom,
    stepNumber,
    toggleValue,
    type FormProblem,
  } from "../../lib/recorder/review-flow";

  const MASK = "••••••";
  const GENERIC = "Something went wrong — try again";
  const GONE =
    "This recording is no longer available. Recordings end when Refill locks, after 30 minutes, or when you cancel them.";
  const PROBLEMS: Record<FormProblem, string> = {
    name: "Enter a name",
    path: "The path must start with / and cover every recorded page",
  };

  const sessionId = sessionIdFrom(globalThis.location?.search ?? "");

  const page = $state(newPage());
  let busy = $state(false);
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
    applyLoad(page, await loadReview(sessionId));
    if (page.view !== "ready") await focusMessage();
  }

  onMount(() => {
    void load();
    // Back to the page (another tab, the screen unlocked): drop the recording if it is gone.
    const onVisible = () => {
      if (document.visibilityState !== "visible" || sessionId === null) return;
      void recheckReview(page, sessionId).then((ended) =>
        ended ? focusMessage() : undefined,
      );
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
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
    if (sessionId === null) return;
    failed = false;
    const out = await toggleValue(page, sessionId, i);
    if (out === "gone") await focusMessage();
    else if (out === "failed") await announceFailure();
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || page.form === null || sessionId === null) return;
    busy = true;
    problem = null;
    failed = false;
    // saveReview never throws. The controls are enabled again before focus moves to one of them.
    const out = await saveReview(sessionId, page.form);
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
  }

  async function discard() {
    if (busy || sessionId === null) return;
    busy = true;
    problem = null;
    failed = false;
    const ok = await discardReview(sessionId); // never throws
    busy = false;
    if (ok) {
      endReview(page, "discarded");
      await focusMessage();
    } else {
      await announceFailure();
    }
  }
</script>

<main>
  {#if page.view === "loading"}
    <p>Loading…</p>
  {:else if page.view === "saved"}
    <p bind:this={message} tabindex="-1" role="status">
      Saved. Refill will fill this form the next time you open it.
    </p>
  {:else if page.view === "gone"}
    <p bind:this={message} tabindex="-1" role="status">{GONE}</p>
  {:else if page.view === "discarded"}
    <p bind:this={message} tabindex="-1" role="status">
      Discarded. Nothing was saved.
    </p>
  {:else if page.view === "failed"}
    <p bind:this={message} tabindex="-1" role="status">{GENERIC}</p>
    <button type="button" onclick={retry}>Try again</button>
  {:else if page.model && page.form}
    {@const model = page.model}
    {@const form = page.form}
    <h1>Review what Refill recorded on {model.host}</h1>
    {#if model.fields.length === 0}
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
              <tr>
                <td>{stepNumber(model, field.step)}</td>
                <th scope="row" id={`field-${i}`}>{field.label}</th>
                <td>
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
                </td>
                <td>
                  <select
                    aria-labelledby={`col-when field-${i}`}
                    bind:value={form.policies[i]!.policy}
                    disabled={busy}
                  >
                    <option value="save">Fill it in</option>
                    <option value="ask">Ask me</option>
                    <option value="skip">Don't save</option>
                  </select>
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
          <label for="prefix">Applies to pages under</label><br />
          <input
            id="prefix"
            type="text"
            maxlength="256"
            autocomplete="off"
            spellcheck="false"
            bind:this={prefixInput}
            bind:value={form.pathPrefix}
            aria-invalid={problem === "path" ? "true" : undefined}
            aria-describedby={problem === "path" ? "prefix-error" : undefined}
            disabled={busy}
          />
          {#if problem === "path"}
            <br /><span id="prefix-error">{PROBLEMS.path}</span>
          {/if}
        </p>

        <button type="submit" disabled={busy}>Save</button>
        <button type="button" onclick={discard} disabled={busy}>
          Discard
        </button>
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
  input[type="text"] {
    width: 100%;
    max-width: 24rem;
    box-sizing: border-box;
  }
</style>
