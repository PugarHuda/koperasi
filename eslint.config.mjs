// npm run lint
import js from "@eslint/js";
import globals from "globals";

export default [
  { ignores: ["node_modules/", "web/vendor/", "contract/target/", "test-results/", "playwright-report/"] },
  js.configs.recommended,
  {
    files: ["agent/**/*.mjs", "api/**/*.mjs", "scripts/**/*.mjs", "tests/**/*.mjs", "*.mjs"],
    languageOptions: { ecmaVersion: 2025, sourceType: "module", globals: { ...globals.node } },
  },
  {
    // Playwright specs run code inside the page too (page.evaluate)
    files: ["tests/**/*.spec.mjs"],
    languageOptions: { globals: { ...globals.node, ...globals.browser } },
  },
  {
    files: ["web/**/*.js"],
    languageOptions: { ecmaVersion: 2025, sourceType: "module", globals: { ...globals.browser } },
  },
  {
    rules: {
      "no-unused-vars": ["error", { argsIgnorePattern: "^_", caughtErrors: "none" }],
      eqeqeq: ["error", "always"],
      "no-implicit-globals": "error",
    },
  },
];
