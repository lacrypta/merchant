import { defineConfig, globalIgnores } from "eslint/config";
import nextVitals from "eslint-config-next/core-web-vitals";
import nextTs from "eslint-config-next/typescript";

const eslintConfig = defineConfig([
  ...nextVitals,
  ...nextTs,
  // Override default ignores of eslint-config-next.
  globalIgnores([
    // Default ignores of eslint-config-next:
    ".next/**",
    "out/**",
    "build/**",
    "next-env.d.ts",
  ]),

  // ───────────────────────────────────────────────────────────────────────
  // Nostr library quarantine.
  //
  // Everything in the app codes against the library-agnostic port in
  // src/lib/nostr/types.ts. All applesauce-specific code lives in
  // src/lib/nostr/adapters/**, so swapping libraries touches one directory.
  //
  // Exceptions:
  //  - src/lib/nostr/react.ts is a narrow re-export shim; applesauce-react's
  //    hooks are good enough to be worth a second boundary, but hooks/**
  //    must import them from the shim, not the package.
  //  - nostr-tools stays allowed app-wide: it's a pure toolbox (nip19,
  //    verifyEvent) plus the Node-only server relay reader, which sits
  //    outside the port by design.
  // ───────────────────────────────────────────────────────────────────────
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: [
      "src/lib/nostr/adapters/**",
      // The composition root — re-exports the adapter behind the port so the
      // rest of the app never names a library.
      "src/lib/nostr/backend.ts",
      "src/lib/nostr/react.ts",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "applesauce*",
                "rxjs",
                "rxjs/*",
                "observable-hooks",
                "@nostr-dev-kit/*",
              ],
              message:
                "Library-specific nostr code belongs in src/lib/nostr/adapters/** only. Code against the port in src/lib/nostr/types.ts, or use the hook shim at src/lib/nostr/react.ts.",
            },
          ],
        },
      ],
    },
  },

  // ───────────────────────────────────────────────────────────────────────
  // dnd-kit's documented API is to spread `attributes` and `listeners` onto
  // the drag handle during render, and to read `transform`/`transition`/
  // `isDragging` from the same hook result. The React-compiler `refs` rule
  // sees those as ref access during render and flags every one.
  //
  // Scoped to the files that actually consume useSortable, so the rule keeps
  // protecting the rest of the codebase.
  // ───────────────────────────────────────────────────────────────────────
  {
    files: ["src/components/products/catalog-board.tsx"],
    rules: {
      "react-hooks/refs": "off",
    },
  },

  // ───────────────────────────────────────────────────────────────────────
  // created_at is a correctness surface, not a convenience.
  //
  // NIP-01 breaks replaceable-event ties on created_at by lowest event id,
  // and the spec calls that a convention relays "may differ" on. A
  // same-second re-publish can therefore be silently discarded. Every
  // created_at in this codebase must come from nextCreatedAt(), which is
  // monotonic per address and clamps forward drift.
  // ───────────────────────────────────────────────────────────────────────
  {
    files: ["src/**/*.{ts,tsx}"],
    ignores: ["src/lib/nostr/created-at.ts", "**/*.test.ts"],
    rules: {
      "no-restricted-syntax": [
        "error",
        {
          selector:
            "CallExpression[callee.object.name='Math'][callee.property.name='floor'] > BinaryExpression[operator='/'] > CallExpression[callee.object.name='Date'][callee.property.name='now']",
          message:
            "Do not compute unix seconds inline. Use nextCreatedAt() from src/lib/nostr/created-at.ts — it is monotonic per address and clamps forward drift.",
        },
      ],
    },
  },
]);

export default eslintConfig;
