<script lang="ts">
  let el: HTMLElement | undefined;
  let html = "x";
  $effect(() => {
    // ruleid: refill-svelte-no-html-sinks
    el!.innerHTML = html;
    // ruleid: refill-svelte-no-html-sinks
    el!.outerHTML = html;
    // ruleid: refill-svelte-no-html-sinks
    el!["innerHTML"] = html;
    // ruleid: refill-svelte-no-html-sinks
    el!.insertAdjacentHTML("beforeend", html);
    // ruleid: refill-svelte-no-html-sinks
    el!.setHTMLUnsafe(html);
    // ruleid: refill-svelte-no-html-sinks
    document.write(html);
    // ruleid: refill-svelte-no-html-sinks
    document.writeln(html);
    // ok: refill-svelte-no-html-sinks
    el!.textContent = html;
  });
</script>

<!-- ruleid: refill-svelte-no-html-sinks -->
{@html html}
