import reactHooks from "eslint-plugin-react-hooks"
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "spikes/**", "data/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Effect code uses `function*` generators that may not yield; that's idiomatic.
      "require-yield": "off"
    }
  },
  {
    files: ["packages/server/**/*.ts", "*.config.ts", "eslint.config.js"],
    languageOptions: { globals: globals.node }
  },
  {
    files: ["packages/client/**/*.{ts,tsx}"],
    languageOptions: { globals: globals.browser },
    // Includes the React Compiler rules: code the compiler can't optimize is an error.
    ...reactHooks.configs.flat["recommended-latest"]
  },
  {
    // Feature code goes through our ui/ layer, so a redesign happens in one place
    // (CLIENT-FRAMEWORK.md §8).
    files: ["packages/client/src/**/*.{ts,tsx}"],
    ignores: ["packages/client/src/ui/**"],
    rules: {
      "no-restricted-imports": [
        "error",
        { patterns: [{ group: ["@base-ui/*"], message: "Import UI from src/ui/ instead of Base UI directly." }] }
      ]
    }
  }
)
