import { fileURLToPath } from "node:url"
import { defineConfig } from "vitest/config"

/**
 * The domain layer is pure — no React, no network, no relays — so it needs no
 * jsdom, no setup file and no mocks. Anything that needs a browser does not
 * belong in this suite.
 */
export default defineConfig({
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
      /**
       * `server-only` exists to make a build FAIL when server code is pulled
       * into a client bundle. There is no bundle here, and the package has no
       * plain-Node entry point, so it is stubbed — otherwise nothing under
       * src/lib/server can be unit-tested at all.
       */
      "server-only": fileURLToPath(new URL("./src/test/server-only.ts", import.meta.url)),
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})
