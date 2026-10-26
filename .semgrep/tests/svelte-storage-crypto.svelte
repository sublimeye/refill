<script lang="ts">
  // ruleid: refill-svelte-no-sync-storage
  chrome.storage.sync.get();
  // ruleid: refill-svelte-no-sync-storage
  browser.storage["sync"].set({});
  // ruleid: refill-svelte-no-subtle
  crypto.subtle.digest("SHA-256", new Uint8Array());
  // ruleid: refill-svelte-no-subtle
  globalThis.crypto["subtle"].digest("SHA-256", new Uint8Array());
  // ruleid: refill-svelte-no-storage-local
  chrome.storage.local.get();
  // ruleid: refill-svelte-no-storage-local
  browser.storage["local"].set({});
  // ok: refill-svelte-no-sync-storage
  chrome.storage.session.get();
</script>
