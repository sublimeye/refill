// ruleid: refill-storage-local-only-in-store
browser.storage.local.get();
// ruleid: refill-storage-local-only-in-store
chrome.storage.local.set({});
// ruleid: refill-storage-local-only-in-store
globalThis.chrome.storage.local.get();
// ruleid: refill-storage-local-only-in-store
globalThis.browser.storage.local.get();
// ruleid: refill-storage-local-only-in-store
self.chrome.storage.local.get();
// ruleid: refill-storage-local-only-in-store
chrome.storage["local"].get();
// ruleid: refill-storage-local-only-in-store
browser.storage["local"].set({});
// ruleid: refill-storage-local-only-in-store
chrome["storage"]["local"].get();
// ruleid: refill-storage-local-only-in-store
const l = browser.storage.local;

// ok: refill-storage-local-only-in-store
chrome.storage.session.get();
// ok: refill-storage-local-only-in-store
browser.storage.onChanged.addListener(() => {});
