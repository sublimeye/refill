import js from "@eslint/js";
import ts from "typescript-eslint";
import svelte from "eslint-plugin-svelte";

export default ts.config(
  {
    ignores: [".output/", ".wxt/", "node_modules/", "dist/", ".semgrep/"],
  },
  js.configs.recommended,
  ...ts.configs.recommended,
  ...svelte.configs["flat/recommended"],
  {
    files: ["**/*.svelte", "**/*.svelte.ts"],
    languageOptions: { parserOptions: { parser: ts.parser } },
    // TypeScript already checks undefined names (DOM types); no-undef only gets browser globals wrong.
    rules: { "no-undef": "off" },
  },
  {
    // Plain page scripts of the e2e fixture sites (served to the browser as-is, no bundling).
    files: ["tests/e2e/sites/**/*.js"],
    languageOptions: {
      globals: { document: "readonly", crypto: "readonly" },
    },
  },
  {
    files: ["scripts/**/*.mjs"],
    languageOptions: {
      globals: { console: "readonly", process: "readonly" },
    },
  },
);
