// Semgrep rule tests (run: scripts/semgrep.sh selftest). Path filters are NOT applied by
// `semgrep --test`; see .semgrep/path-fixtures for include/exclude checks.
declare const url: string;
declare const nav: { sendBeacon(u: string): boolean };

// ruleid: refill-no-network
fetch(url);
// ruleid: refill-no-network
window.fetch(url);
// ruleid: refill-no-network
self.fetch(url);
// ruleid: refill-no-network
globalThis.fetch(url);
// ruleid: refill-no-network
self.window.fetch(url);
// ruleid: refill-no-network
window["fetch"](url);
// ruleid: refill-no-network
globalThis["fetch"](url);
// ruleid: refill-no-network
new XMLHttpRequest();
// ruleid: refill-no-network
new window.XMLHttpRequest();
// ruleid: refill-no-network
new globalThis.XMLHttpRequest();
// ruleid: refill-no-network
new WebSocket(url);
// ruleid: refill-no-network
new window.WebSocket(url);
// ruleid: refill-no-network
new self.WebSocket(url);
// ruleid: refill-no-network
new EventSource(url);
// ruleid: refill-no-network
new globalThis.EventSource(url);
// ruleid: refill-no-network
navigator.sendBeacon(url);
// ruleid: refill-no-network
self.navigator.sendBeacon(url);
// ruleid: refill-no-network
window.navigator.sendBeacon(url);
// ruleid: refill-no-network
globalThis.navigator.sendBeacon(url);
// ruleid: refill-no-network
navigator["sendBeacon"](url);
// ruleid: refill-no-network
self.navigator["sendBeacon"](url);

// ok: refill-no-network
nav.sendBeacon(url);
// ok: refill-no-network
const doFetchLater = () => url.length;
// ok: refill-no-network
const sock = { WebSocket: 1 };
