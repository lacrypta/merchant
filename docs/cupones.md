# Coupons

This server **mints and redeems coupons on a merchant's behalf**, and the merchant authorizes it by signing a nostr event that says where the service lives. Any point of sale that reads that event can mint and redeem without ever having talked to us.

## The documents

| Document | What it answers |
|---|---|
| **This one** | Why there is a database, how it is configured, who is who |
| [Discounts](./cupones-descuentos.md) | What each coupon type takes off, under which arithmetic rules |
| [API](./cupones-api.md) | Every endpoint, with its body, its response and its errors |
| [Nostr events](./cupones-nostr.md) | The announcement (30078) and the voucher (20402), and how to verify them |
| [Flows](./cupones-flujos.md) | How it all chains together, and which decisions not to revert |
| [Data](./cupones-datos.md) | The tables, their columns and what each one guarantees |

If you are integrating a POS, [API](./cupones-api.md) and [Nostr events](./cupones-nostr.md) are enough.

---

## Who is who

| Role | What they do | With which key |
|---|---|---|
| **Merchant** (owner) | Creates coupons, authorizes minters, signs the announcement | Theirs (NIP-07 / NIP-46) |
| **Minter** | Mints coupons for a merchant who authorized them | Theirs |
| **Manager** | Signs the vouchers. It is this server | `COUPON_MANAGER_NSEC` |
| **Bearer** | Holds the nonce and redeems it. Needs no key | None — the nonce is the credential |

One deployment serves **many merchants** at once. Everything the API returns is scoped by the pubkey that signed the request: somebody else's coupon is indistinguishable from one that does not exist, which is the correct answer to give a stranger probing UUIDs.

---

## Why there is a database

It is the only part of the app with Postgres. Everything else lives on relays and in `localStorage`, and that is deliberate.

The reason is short: *"has this coupon been used?"* has to have **exactly one answer** at the instant two tills ask it. Relays are eventually-consistent by design — perfect for a catalog, useless for deciding who gets the last remaining discount.

Everything that needs that guarantee is in Postgres. Everything that needs to be discovered by third parties is on nostr.

The practical consequence: **there is no orders table**, and yet orders are stored. A paid purchase is reconstructed from its zap receipt on the relays; one that a coupon took to zero never produces an invoice or a receipt, so it is filed on the redemption row. See [Data § the order hangs off the redemption](./cupones-datos.md#the-order-hangs-off-the-redemption).

---

## Configuration

```bash
DATABASE_URL=postgres://merchant:merchant@localhost:55432/merchant
COUPON_MANAGER_NSEC=nsec1…       # the identity that signs the vouchers
NEXT_PUBLIC_APP_URL=http://localhost:4321
SESSION_JWT_SECRET=…             # signs the session JWTs
```

Without `DATABASE_URL` or without `COUPON_MANAGER_NSEC` the coupon endpoints answer `503` and the rest of the app works the same: **having no database is a supported state**.

Two of them are signing keys, and they fail differently on purpose:

- **`COUPON_MANAGER_NSEC` has no fallback.** It signs **vouchers** — long-lived artifacts that a POS verifies months later against the key the merchant named — so a key that silently rotates invalidates every one of them with no warning. Its absence is a 503. It does **not** sign the announcement: that one the merchant signs with their own key, and this service could not forge it (see [Nostr events](./cupones-nostr.md)).
- **`SESSION_JWT_SECRET` does have a per-process random fallback**, like `LN_PROXY_SECRET`: the worst that happens is one extra signature. **But with more than one instance it must be set**, or a token minted by A is rejected by B and the client re-mints every other request — worse than having no session at all.

`NEXT_PUBLIC_APP_URL` signs nothing; it configures **which origin NIP-98 validates against**. When set, it is the only one accepted and the `x-forwarded-*` headers are ignored. See [API § NIP-98](./cupones-api.md#nip-98).

### Migrations

```bash
npm run db:generate   # after touching the schema
npm run db:migrate    # by hand; the build already does it
```

**Migrations run at build time**, not at runtime: `npm run build` executes `drizzle-kit migrate` before compiling if there is a `DATABASE_URL` (or `DATABASE_POOL_URL`), and fails the build if they do not apply. A runtime migrator would race across several instances; leaving it only to whoever deploys has already been tried and ends in a table that does not exist.

The build runs them when **either** `DATABASE_URL` or `DATABASE_POOL_URL` is set. If the provider hands out both, the app and the migrations use **the pooler**. The textbook move is migrating over the direct connection, but this runs inside the deploy: if the build cannot reach it, there is no migration.

---

## Code map

| What | Where |
|---|---|
| Types, validation and arithmetic | [`src/lib/domain/coupon.ts`](../src/lib/domain/coupon.ts) |
| The wizard's form | [`src/lib/domain/coupon-schema.ts`](../src/lib/domain/coupon-schema.ts) |
| The 30078 announcement | [`src/lib/domain/coupon-discovery.ts`](../src/lib/domain/coupon-discovery.ts) |
| SQL | [`src/lib/server/coupon-store.ts`](../src/lib/server/coupon-store.ts) |
| Helpers shared by the routes | [`src/lib/server/coupon-api.ts`](../src/lib/server/coupon-api.ts) |
| Tables | [`src/lib/server/db/schema.ts`](../src/lib/server/db/schema.ts) |
| Endpoints | [`src/app/api/coupons/`](../src/app/api/coupons/) |

---

> **A note on language.** The docs are in English; the app is not. Error messages, UI labels and the example coupon names you will see quoted throughout are **es-AR verbatim** — they are what the API actually returns and what the merchant actually reads on screen, so translating them here would make this documentation wrong.
