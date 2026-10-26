const logEl = document.getElementById("log");
const results = (window.__results = {});
function log(...a) {
  const line = a.map((x) => (typeof x === "string" ? x : JSON.stringify(x))).join(" ");
  logEl.textContent += line + "\n";
  console.log(line);
}
document.getElementById("origin").textContent = location.origin;
log("origin:", location.origin, "UA:", navigator.userAgent);

// (a) WebAuthn PRF
async function probeA() {
  try {
    const salt = crypto.getRandomValues(new Uint8Array(32));
    const created = await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        rp: { name: "Refill spike" },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: "spike", displayName: "spike" },
        pubKeyCredParams: [{ type: "public-key", alg: -7 }, { type: "public-key", alg: -257 }],
        authenticatorSelection: {
          authenticatorAttachment: "platform",
          residentKey: "required",
          userVerification: "required",
        },
        extensions: { prf: { eval: { first: salt } } },
      },
    });
    const cExt = created.getClientExtensionResults();
    log("create ext:", { enabled: cExt.prf && cExt.prf.enabled, firstLen: cExt.prf && cExt.prf.results && cExt.prf.results.first && cExt.prf.results.first.byteLength });
    const got = await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: "public-key", id: created.rawId }],
        userVerification: "required",
        extensions: { prf: { eval: { first: salt } } },
      },
    });
    const gExt = got.getClientExtensionResults();
    const len = gExt.prf && gExt.prf.results && gExt.prf.results.first ? gExt.prf.results.first.byteLength : null;
    results.a = { origin: location.origin, createEnabled: cExt.prf && cExt.prf.enabled, getFirstLen: len };
    log("(a) get prf:", results.a);
  } catch (e) {
    results.a = { error: String(e), origin: location.origin };
    log("(a) ERROR:", e.name, e.message, "origin:", location.origin);
  }
}

// (b) Argon2id timing
async function probeB() {
  const out = {};
  const salt = crypto.getRandomValues(new Uint8Array(16));
  for (const t of [3, 4, 6]) {
    const ms = [];
    for (let i = 0; i < 3; i++) {
      const t0 = performance.now();
      const h = await hashwasm.argon2id({
        password: "correct horse battery staple",
        salt,
        parallelism: 1,
        iterations: t,
        memorySize: 65536,
        hashLength: 32,
        outputType: "binary",
      });
      ms.push(Math.round(performance.now() - t0));
      if (h.length !== 32) throw new Error("bad hash length");
    }
    const sorted = [...ms].sort((x, y) => x - y);
    out["t" + t] = { runs: ms, medianMs: sorted[1] };
    log("(b) t=" + t, "runs(ms)=" + ms.join(","), "median=" + sorted[1]);
  }
  results.b = out;
  return out;
}

// (c) read what popup wrote
async function probeC() {
  const v = await chrome.storage.session.get(["before", "after"]);
  results.c = v;
  log("(c) session:", v);
}

document.getElementById("a-create").onclick = probeA;
document.getElementById("b-run").onclick = () => probeB().catch((e) => log("(b) ERROR:", String(e)));
document.getElementById("c-read").onclick = probeC;
