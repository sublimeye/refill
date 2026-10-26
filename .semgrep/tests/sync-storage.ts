// ruleid: refill-no-sync-storage
chrome.storage.sync.get();
// ruleid: refill-no-sync-storage
browser.storage.sync.set({});
// ruleid: refill-no-sync-storage
chrome.storage["sync"].get();
// ruleid: refill-no-sync-storage
globalThis.chrome.storage.sync.get();
// ruleid: refill-no-sync-storage
chrome["storage"]["sync"].get();
// ruleid: refill-no-sync-storage
const s = browser.storage.sync;

// ok: refill-no-sync-storage
chrome.storage.session.get();
// ok: refill-no-sync-storage
const synced = true;
