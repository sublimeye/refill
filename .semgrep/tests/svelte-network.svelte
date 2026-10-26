<script lang="ts">
  // Semgrep generic rules over .svelte (run: scripts/semgrep.sh selftest)
  let url = "x";
  // ruleid: refill-svelte-no-network
  fetch(url);
  // ruleid: refill-svelte-no-network
  window.fetch(url);
  // ruleid: refill-svelte-no-network
  globalThis["fetch"](url);
  // ruleid: refill-svelte-no-network
  const x = new XMLHttpRequest();
  // ruleid: refill-svelte-no-network
  const w = new window.WebSocket(url);
  // ruleid: refill-svelte-no-network
  const e = new EventSource(url);
  // ruleid: refill-svelte-no-network
  self.navigator.sendBeacon(url);
  // ok: refill-svelte-no-network
  const harmless = url.length;
</script>

<p>{url}</p>
