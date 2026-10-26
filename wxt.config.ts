import { defineConfig } from "wxt";
import { MANIFEST_KEY } from "./src/manifest-key";

const PROD_CSP =
  "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'; connect-src 'none'";
// Dev server needs to reach localhost for HMR, so connect-src 'none' is omitted.
const DEV_CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";

export default defineConfig({
  srcDir: "src",
  modules: ["@wxt-dev/module-svelte"],
  manifest: ({ mode }) => ({
    name: "Refill",
    description: "Private, encrypted form memory. Local-only.",
    key: MANIFEST_KEY,
    minimum_chrome_version: "127",
    permissions: ["storage", "activeTab", "scripting", "alarms", "idle"],
    optional_host_permissions: ["https://*/*"],
    externally_connectable: { ids: [], matches: [] },
    content_security_policy: {
      extension_pages: mode === "production" ? PROD_CSP : DEV_CSP,
    },
  }),
});
