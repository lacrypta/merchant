import "server-only"

import { drizzle, type NodePgDatabase } from "drizzle-orm/node-postgres"
import { Pool } from "pg"

import * as schema from "./schema"

/**
 * The Postgres pool, created on first use and never at import time.
 *
 * Lazy on purpose. Coupons are the only feature that needs a database, and a
 * top-level connection would make an app deployed without DATABASE_URL fail to
 * boot — taking the catalog, the storefront and checkout down with it. Instead
 * `getDb()` returns null, the coupon routes answer 503, and everything else
 * works exactly as before. Same graceful-degrade stance as LN_PROXY_SECRET in
 * src/lib/server/signed-url.ts.
 */

export type Db = NodePgDatabase<typeof schema>

/**
 * Cached on globalThis, not in a module const: `next dev` re-evaluates modules
 * on every hot reload, and a fresh Pool per reload leaks connections until
 * Postgres refuses new ones.
 */
const cache = globalThis as typeof globalThis & {
  __couponDb?: { pool: Pool; db: Db } | null
}

let warned = false

export function getDb(): Db | null {
  if (cache.__couponDb !== undefined) return cache.__couponDb?.db ?? null

  /**
   * The pooled URL wins when there is one. A managed Postgres hands out two
   * addresses: the direct one, for migrations and psql, and a pooler for
   * everything else. A serverless deploy opens a pool per instance against the
   * direct address and either exhausts the connection limit or — on Supabase,
   * whose direct host is IPv6-only — never connects at all, which is a 15s
   * timeout on every coupon request. Migrations still use DATABASE_URL: see
   * drizzle.config.ts.
   */
  const connectionString = process.env.DATABASE_POOL_URL || process.env.DATABASE_URL
  if (!connectionString) {
    if (!warned) {
      warned = true
      console.warn("[coupons] no DATABASE_URL; the coupon endpoints will answer 503.")
    }
    cache.__couponDb = null
    return null
  }

  // Small pool: these are short transactional queries, and serverless-ish
  // deployments run many instances against one Postgres.
  const pool = new Pool({ connectionString, max: 5 })
  // Without this an idle-client error (a network blip, a Postgres restart)
  // becomes an unhandled 'error' event and takes the whole process down.
  pool.on("error", (e) => console.error("[coupons] idle pg client error:", e.message))

  const db = drizzle(pool, { schema })
  cache.__couponDb = { pool, db }
  return db
}

/** Test seam: forget the cached pool so the next getDb() re-reads the env. */
export function __resetDb(): void {
  cache.__couponDb = undefined
  warned = false
}
