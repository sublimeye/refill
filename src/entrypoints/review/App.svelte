<script lang="ts">
  // The review page (spec §6.2, ADR 0033): what a finished recording captured, masked until the
  // user asks, a policy per field, the form's name, fill mode and path prefix, then Save or
  // Discard. Values are rendered as text only.
  import { onMount, tick } from "svelte";
  import type { ReviewModel } from "../../lib/recorder/profile";
  import {
    discardReview,
    initialForm,
    loadReview,
    saveReview,
    sessionIdFrom,
    stepNumber,
    type FormProblem,
    type ReviewForm,
  } from "../../lib/recorder/review-flow";

  type View = "loading" | "ready" | "saved" | "gone" | "discarded" | "failed";

  const MASK = "••••••";
  const GENERIC = "Something went wrong — try again";
  const GONE =
    "This recording is no longer available. Recordings end when Refill locks, after 30 minutes, or when you cancel them.";
  const PROBLEMS: Record<FormProblem, string> = {
    name: "Enter a name",
    path: "The path must start with / and cover every recorded page",
  };

  const sessionId = sessionIdFrom(globalThis.location?.search ?? "");

  let view = $state<View>("loading");
  let model = $state<ReviewModel | null>(null);
  let replacesProfile = $state(false);
  let form = $state<ReviewForm | null>(null);
  let shown = $state<boolean[]>([]);
  let busy = $state(false);
  let problem = $state<FormProblem | null>(null);
  let failed = $state(false);

  let message: HTMLElement | undefined = $state();
  let failure: HTMLElement | undefined = $state();
  let nameInput: HTMLInputElement | undefined = $state();
  let prefixInput: HTMLInputElement | undefined = $state();

  async function show(next: View) {
    view = next;
    if (next !== "ready") {
      // Nothing of the recording stays on the page once it is saved, gone or discarded.
      model = null;
      form = null;
      shown = [];
    }
    await tick();
    message?.focus();
  }

  async function load() {
    const res = await loadReview(sessionId);
    if (res.state === "ready") {
      model = res.model;
      replacesProfile = res.replacesProfile;
      form = initialForm(res.model);
      shown = res.model.fields.map(() => false);
      view = "ready";
      return;
    }
    await show(res.state);
  }

  onMount(load);

  async function retry() {
    view = "loading";
    await load();
  }

  async function announceFailure() {
    failed = true;
    await tick();
    failure?.focus();
  }

  async function save(event: SubmitEvent) {
    event.preventDefault();
    if (busy || form === null || sessionId === null) return;
    busy = true;
    problem = null;
    failed = false;
    // saveReview never throws. The controls are enabled again before focus moves to one of them.
    const out = await saveReview(sessionId, form);
    busy = false;
    switch (out) {
      case "saved":
      case "gone":
        await show(out);
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
    if (ok) await show("discarded");
    else await announceFailure();
  }
</script>

<main>
  {#if view === "loading"}
    <p>Loading…</p>
  {:else if view === "saved"}
    <p bind:this={message} tabindex="-1" role="status">
      Saved. Refill will fill this form the next time you open it.
    </p>
  {:else if view === "gone"}
    <p bind:this={message} tabindex="-1" role="status">{GONE}</p>
  {:else if view === "discarded"}
    <p bind:this={message} tabindex="-1" role="status">
      Discarded. Nothing was saved.
    </p>
  {:else if view === "failed"}
    <p bind:this={message} tabindex="-1" role="status">{GENERIC}</p>
    <button type="button" onclick={retry}>Try again</button>
  {:else if model && form}
    <h1>Review what Refill recorded on {model.host}</h1>
    {#if replacesProfile}
      <p>Saving replaces the form saved for {model.host}.</p>
    {/if}
    {#if model.fields.length === 0}
      <p>
        Nothing was recorded. Type into the form while recording, then finish.
      </p>
      <button type="button" onclick={discard} disabled={busy}>Discard</button>
    {:else}
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
                  <span class="value">{shown[i] ? field.value : MASK}</span>
                  <button
                    type="button"
                    aria-pressed={shown[i] ? "true" : "false"}
                    aria-describedby={`field-${i}`}
                    onclick={() => (shown[i] = !shown[i])}
                  >
                    {shown[i] ? "Hide" : "Show"}
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
