import { defineConfig } from "wxt";
import { MANIFEST_KEY } from "./src/manifest-key";

// ADR 0016: default-src 'none' so no resource class is open by omission.
const PROD_CSP =
  "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self'; font-src 'self'; object-src 'self'; connect-src 'none'; base-uri 'none'; form-action 'none'";
// Dev server needs to reach localhost for HMR, so the production lockdown is not applied.
const DEV_CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";

export default defineConfig({
  srcDir: "src",
  // ADR 0016: Vite's modulepreload polyfill carries a dead `fetch(` call; Chromium 127+ never needs it.
  vite: () => ({ build: { modulePreload: { polyfill: false } } }),
  modules: ["@wxt-dev/module-svelte"],
  manifest: ({ mode }) => ({
    name: "Refill",
    description: "Private, encrypted form memory. Local-only.",
    key: MANIFEST_KEY,
    minimum_chrome_version: "127",
    permissions: ["storage", "activeTab", "scripting", "alarms", "idle"],
    optional_host_permissions: ["https://*/*"],
    // ADR 0017: only the e2e build pre-grants the fixture origins, so specs need no permission prompt.
    ...(mode === "e2e" ? { host_permissions: ["https://localhost/*"] } : {}),
    externally_connectable: { ids: [], matches: [] },
    content_security_policy: {
      extension_pages: mode === "development" ? DEV_CSP : PROD_CSP,
    },
  }),
});
