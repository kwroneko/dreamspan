import reactHooks from "eslint-plugin-react-hooks"
import globals from "globals"
import tseslint from "typescript-eslint"

export default tseslint.config(
  { ignores: ["**/dist/**", "**/node_modules/**", "spikes/**", "data/**", ".claude/**"] },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["error", { argsIgnorePattern: "^_", varsIgnorePattern: "^_" }],
      // Effect code uses `function*` generators that may not yield; that's idiomatic.
      "require-yield": "off"
    }
  },
  {
    files: ["packages/server/**/*.ts", "packages/client/e2e/**/*.ts", "**/*.config.ts", "eslint.config.js"],
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
  },
  {
    // The app is also served over plain HTTP on LAN addresses, where secure-context APIs are missing.
    files: ["packages/client/src/**/*.{ts,tsx}"],
    rules: {
      "no-restricted-properties": [
        "error",
        {
          property: "randomUUID",
          message:
            "crypto.randomUUID needs a secure context, so it's missing over plain HTTP; use uuid() from src/uuid.ts."
        }
      ]
    }
  },
  {
    // Id schemas come from idSchema, which annotates their table: a brand alone leaves no
    // trace in a schema, and code that looks for ids (state.ts) would miss it.
    files: ["packages/*/src/**/*.{ts,tsx}"],
    ignores: ["packages/shared/src/id.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector: [
            "CallExpression[callee.property.name=/^(brand|fromBrand)$/]",
            "CallExpression[callee.property.value=/^(brand|fromBrand)$/]",
            "CallExpression[callee.name=/^(brand|fromBrand)$/]"
          ].join(", "),
          message: "Make id schemas with idSchema (@dreamspan/shared/id.ts)."
        }
      ],
      // A rule of its own name, so the blocks below that restrict other imports don't replace it.
      "@typescript-eslint/no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "effect/Schema",
              importNames: ["brand", "fromBrand"],
              message: "Make id schemas with idSchema (@dreamspan/shared/id.ts)."
            }
          ]
        }
      ]
    }
  },
  {
    // Every outgoing request goes through the network module, so none can skip the
    // instance proxy by accident (spec/PROVIDERS.md §6.2).
    files: ["packages/server/src/**/*.ts"],
    ignores: ["packages/server/src/net/**"],
    rules: {
      "no-restricted-globals": [
        "error",
        { name: "fetch", message: "Outgoing requests go through src/net/ (Network.fetchFor)." }
      ],
      "no-restricted-imports": [
        "error",
        {
          paths: [
            { name: "undici", message: "Outgoing requests go through src/net/." },
            { name: "node:https", message: "Outgoing requests go through src/net/." }
          ]
        }
      ]
    }
  }
)
