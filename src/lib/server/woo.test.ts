import { describe, expect, it } from "vitest"

import { WOO_API_PREFIX, isAllowedWooPath } from "./woo"

describe("isAllowedWooPath", () => {
  const allow = [
    `${WOO_API_PREFIX}products`,
    `${WOO_API_PREFIX}products/42`,
    `${WOO_API_PREFIX}products/batch`,
    `${WOO_API_PREFIX}orders`,
    `${WOO_API_PREFIX}orders/7`,
    `${WOO_API_PREFIX}settings/general`,
  ]

  it.each(allow)("allows %s", (path) => {
    expect(isAllowedWooPath(path)).toBe(true)
  })

  const deny = [
    // WordPress mounts far more than WooCommerce under /wp-json.
    "/wp-json/wp/v2/users",
    "/wp-json/wp/v2/posts",
    // Other WooCommerce endpoints we have no business reaching.
    `${WOO_API_PREFIX}customers`,
    `${WOO_API_PREFIX}reports/sales`,
    `${WOO_API_PREFIX}webhooks`,
    `${WOO_API_PREFIX}system_status`,
    // Traversal and host-escape attempts.
    `${WOO_API_PREFIX}../../wp-json/wp/v2/users`,
    "//evil.example/wp-json/wc/v3/products",
    "https://evil.example/wp-json/wc/v3/products",
    // Query smuggled into the path.
    `${WOO_API_PREFIX}products?x=1`,
    `${WOO_API_PREFIX}products#x`,
    // Near misses.
    `${WOO_API_PREFIX}productsX`,
    `${WOO_API_PREFIX}orders/abc`,
    "/wp-json/wc/v2/products",
    "",
    "/",
  ]

  it.each(deny)("refuses %s", (path) => {
    expect(isAllowedWooPath(path)).toBe(false)
  })
})
