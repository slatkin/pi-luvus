import js from "@eslint/js";
import tseslint from "typescript-eslint";
import prettier from "eslint-config-prettier";
import globals from "globals";

export default [
  {
    ignores: ["node_modules/**", ".pi/**", "openspec/**"],
  },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  // Must come last: switches off every rule that would fight the formatter.
  prettier,
  {
    files: ["**/*.ts"],
    rules: {
      // A leading underscore marks an identifier that is unused on purpose,
      // such as a callback parameter kept for its position in the signature.
      "@typescript-eslint/no-unused-vars": [
        "error",
        {
          argsIgnorePattern: "^_",
          varsIgnorePattern: "^_",
          caughtErrorsIgnorePattern: "^_",
        },
      ],
      // This package exchanges untyped JSON with the pi SDK and the Luvus CLI.
      // Warn, not error: 175 sites predate the linter. Reported, but not gating.
      "@typescript-eslint/no-explicit-any": "warn",
    },
  },
  {
    // The Claude stop hook and the stream tailer are plain Node scripts, so
    // they need Node globals.
    files: ["**/*.js", "**/*.mjs"],
    languageOptions: { globals: globals.node },
  },
];
