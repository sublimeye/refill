<script lang="ts">
  let code = "1";
  // ruleid: refill-svelte-no-eval
  eval(code);
  // ruleid: refill-svelte-no-eval
  window.eval(code);
  // ruleid: refill-svelte-no-eval
  new Function(code);
  // ruleid: refill-svelte-no-eval
  Function(code);
  // ruleid: refill-svelte-no-eval
  setTimeout("doIt()", 10);
  // ruleid: refill-svelte-no-eval
  setInterval("doIt()", 10);
  // ok: refill-svelte-no-eval
  setTimeout(() => code.length, 10);
</script>
