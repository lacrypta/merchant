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
    },
  },
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
  },
})
