import { defineConfig } from "drizzle-kit"

/**
 * drizzle-kit runs as a plain CLI, outside Next.js, so nothing has loaded
 * .env.local for it. Node's own loader does the job and keeps dotenv out of the
 * dependency list; a missing file is fine because CI and production pass
 * DATABASE_URL through the environment instead.
 */
try {
  process.loadEnvFile(".env.local")
} catch {
  /* no .env.local — the shell environment is expected to carry DATABASE_URL */
}

export default defineConfig({
  dialect: "postgresql",
  schema: "./src/lib/server/db/schema.ts",
  out: "./drizzle",
  /**
   * Same order as the app (src/lib/server/db/index.ts): pooler first. The
   * textbook rule is to migrate over the direct connection, but this runs
   * inside the deploy, and a managed Postgres often exposes its direct host
   * where the build cannot reach it — on Vercel that is a two-minute hang and
   * a failed build. Reachable beats textbook.
   */
  dbCredentials: {
    url: process.env.DATABASE_POOL_URL || process.env.DATABASE_URL || "",
  },
})
