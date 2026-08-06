# Coupons API

Full reference: every endpoint with its body, its response and its errors, and the schema of every type it returns.

The examples are real — copied from a run against `npm run dev` — with the identifiers swapped.

> **Error messages and example names are quoted verbatim in es-AR.** They are what the API actually returns; translating them here would make this document wrong about the wire.

- [Conventions](#conventions)
- [Authentication](#authentication)
- [Return types](#return-types)
- [Endpoints](#endpoints)
- [Error catalog](#error-catalog)
- [Example client](#example-client)

---

## Conventions

**Base URL.** The deployment's own. In this document, `https://merchant.lacrypta.ar`.

**CORS is open on all of them.** The preflight includes `Authorization`, which is not a safelisted header — leaving it out would fail only for cross-origin clients, which is to say only for third-party POS apps, which are exactly the ones that matter.

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: <the route's own>, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```

**`Cache-Control: no-store` on all but one.** Authenticated state is per-caller. The exception is `GET /api/coupons/manager`, which is `public, max-age=300` because the key is stable for the life of the deployment.

**Errors.** Always JSON, always in Spanish, always the same envelope:

```json
{ "error": "No estás autorizado a emitir este cupón." }
```

Some add a field:

| Extra field | When | What for |
|---|---|---|
| `retryAfter` | `429` | Seconds until the window frees up |
| `reason` | `401` | Machine-readable: `expired`, `replay`, `url-mismatch`, `session-expired`, `session-invalid`, `malformed`, `missing`, `too-large` |

**Size limits.** Body: 16 KB (`413`). `Authorization` header: 8 KB (`401` with `reason: "too-large"`). A signed event base64s to ~700 bytes, so 8 KB is generous and bounded.

**Rate limits.** Per IP, per process, 60 s window. **They authorize nothing** — they raise the cost for whoever insists, and they are not shared across instances.

| Bucket | Max/min | Routes |
|---|---|---|
| `auth-session` | 20 | `POST /api/auth/session` |
| `coupons-mgmt` | 60 | Everything management: `/api/coupons`, `{id}`, `mints`, `minters`, `discovery`, `mintable`, `redemptions` |
| `coupon-mint` | 30 | `POST /api/coupons/mint` |
| `coupon-check` | 60 | `GET /api/coupons/claim` |
| `coupon-claim` | 30 | `POST /api/coupons/claim` |

`auth-session` gets its own bucket on purpose: a busy coupons page must not be able to exhaust the login budget, or the other way round.

**Preconditions.** Without `DATABASE_URL`, every route that touches the database answers `503`. Without `COUPON_MANAGER_NSEC`, the ones that sign vouchers (`mint`, `POST claim`) answer `503`.

---

## Authentication

Two schemes, **the same tenant**. Dispatched on the header prefix, never trying one and falling back to the other: both read the body, and a `Request` is consumed exactly once.

| Route | Auth |
|---|---|
| `POST /api/auth/session` | NIP-98 **only** |
| All management, `mint` included | NIP-98 **or** Bearer |
| `GET`/`POST /api/coupons/claim` | None — the nonce is the credential |
| `GET /api/coupons/manager` | None |

### NIP-98

Kind `27235` in `Authorization: Nostr <base64 of the event>`. Verified in this order — cheap first, and the signature before trusting any tag:

1. Event shape
2. `kind === 27235`
3. **Valid signature**
4. `|now − created_at| ≤ 60s`
5. `method` tag matches
6. `u` tag matches the external URL (origin + path + query, exactly)
7. `payload` tag = sha256 hex of the body, when there is one

```jsonc
{
  "kind": 27235,
  "created_at": 1764630000,
  "content": "",
  "tags": [
    ["u", "https://merchant.lacrypta.ar/api/coupons/mint"],
    ["method", "POST"],
    ["payload", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
    ["nonce", "k3f9xq2"]                                    // see below
  ],
  "pubkey": "…", "id": "…", "sig": "…"
}
```

With `NEXT_PUBLIC_APP_URL` set, that is the **only** origin accepted and the `x-forwarded-*` headers are ignored, so forging them does not widen the token's audience.

There is an in-process cache of seen ids (150 s) against replay. Same scope as the rate limit: it raises the cost, it does not make it impossible, and it is not shared across instances.

> **If you are implementing a client:** the token has to carry **something that makes it unique**. Everything else is deterministic and `created_at` has one-second resolution, so two mints of the same coupon in the same second hash to the same id and the second is rejected with `reason: "replay"`. Our client adds a random `nonce` tag; a till minting several coupons per second has to do the same.

### Bearer

Sign a NIP-98 once, get a JWT, use it for everything else: `Authorization: Bearer <token>`.

**It is not a security improvement, it is a trade.** NIP-98 binds each token to a pubkey, a URL, a method, a body hash, sixty seconds and a single use. The bearer binds a pubkey and an expiry: stealing it grants everything that pubkey can do until it lapses. What it buys is not paying a signature per request, which on a NIP-46 bunker is a round trip to the merchant's phone on every click.

- **12 hours**, one shift. The browser keeps it in `sessionStorage`, so it also dies when the tab closes.
- **Every route accepts it, minting included.** Restricting `mint` to NIP-98 would protect nothing: with the same bearer you call `POST /api/coupons/minters`, add yourself as an authorized minter, and mint with your own signature.
- **There is no logout.** The token has no server-side state, so there is nothing to revoke: signing out is dropping it. To invalidate everything right now, rotate `SESSION_JWT_SECRET`.
- **Re-mint on any `401`.** Without `SESSION_JWT_SECRET` the key is random per process, so a restart makes live tokens fail as `session-invalid` rather than `session-expired`.

---

## Return types

### `Benefit`

What the coupon takes off. A union discriminated by `type`; all five accept an optional `cap`. The semantics are in [Discounts](./cupones-descuentos.md).

```ts
type Benefit = (
  | { type: "percent";   percent: number;   productDs?: string[] }
  | { type: "fixed";     amount: number; currency: Currency; productDs?: string[] }
  | { type: "multibuy";  buyQty: number; payQty: number; productDs?: string[] }
  | { type: "buyXgetY";  buyProductD: string; giftProductD: string }
  | { type: "freeItems"; items: { d: string; qty: number }[] }
) & { cap?: { amount: number; currency: Currency } }

type Currency = "ARS" | "USD" | "SAT"
```

One of each:

```jsonc
{ "type": "percent", "percent": 10 }
{ "type": "percent", "percent": 20, "cap": { "amount": 5000, "currency": "ARS" } }
{ "type": "fixed", "amount": 500, "currency": "ARS" }
{ "type": "fixed", "amount": 1500, "currency": "SAT", "productDs": ["aab1c0de-7f2c-4b8e-9d31-2c5f6a8b1e40"] }
{ "type": "multibuy", "buyQty": 2, "payQty": 1, "productDs": ["b7e21d94-3a55-4c07-8f6b-9d0e4a1c2b38"] }
{ "type": "buyXgetY", "buyProductD": "b7e21d94-3a55-4c07-8f6b-9d0e4a1c2b38", "giftProductD": "aab1c0de-7f2c-4b8e-9d31-2c5f6a8b1e40" }
{ "type": "freeItems", "items": [{ "d": "aab1c0de-7f2c-4b8e-9d31-2c5f6a8b1e40", "qty": 2 }] }
```

Absent keys are meaningful: an absent `productDs` means **all products**, an absent `cap` means **no ceiling**. They are never sent as `null`.

### `DefinitionJson`

A coupon as the management page sees it. Returned by `GET /api/coupons`, `POST /api/coupons` and `PATCH /api/coupons/{id}`.

```ts
interface DefinitionJson {
  id: string            // uuid
  name: string          // 1..80
  description: string   // "" when it has none
  image: string | null  // https
  benefit: Benefit | null
  maxUses: number | null    // null ⇒ unlimited
  minted: number            // live mints; voiding one lowers it and gives the slot back
  claimed: number           // redeemed
  expiresAt: number | null  // unix SECONDS
  archivedAt: number | null
  createdAt: number
  updatedAt: number
}
```

```json
{
  "id": "55b5ee4f-4dcc-4a6a-a58e-6d1d94d811a3",
  "name": "20% de verano",
  "description": "Sólo de lunes a jueves, no acumulable con otras promos.",
  "image": "https://blossom.example/9f3c.webp",
  "benefit": {
    "type": "percent",
    "percent": 20,
    "cap": { "amount": 5000, "currency": "ARS" }
  },
  "maxUses": 100,
  "minted": 12,
  "claimed": 7,
  "expiresAt": 1764633600,
  "archivedAt": null,
  "createdAt": 1762041600,
  "updatedAt": 1762128000
}
```

> **`benefit: null` is not an API error, it is a broken coupon.** A definition whose columns no longer parse — a hand-edited database, a future version that wrote a shape we do not know — is a real thing that can happen. Hiding it would leave the merchant with a coupon they can neither see, edit nor delete; showing it broken lets them fix it. `POST /api/coupons/mint` **will not issue it**: it answers `503`.

### `MintJson`

One issuance. Returned by `GET /api/coupons/{id}/mints` and `DELETE …/mints/{nonce}`.

```ts
interface MintJson {
  nonce: string     // 22 chars base64url — the bearer token
  status: "minted" | "claimed" | "voided"
  mintedBy: string      // hex of whoever minted it
  mintedByNpub: string
  mintedAt: number      // unix seconds
  claimedAt: number | null
  voidedAt: number | null
}
```

```json
{
  "nonce": "hcLPDzERvvHzS4Vn0OLbAQ",
  "status": "claimed",
  "mintedBy": "2ad91f1dca2dcd5fc89e7208d1e5059f0bac0870d63fc3bac21c7a9388fa18fd",
  "mintedByNpub": "npub19tv378w29hx4ljy7wgydreg9nu96czrs6clu8wkzr3af8z86rr7sujx4xe",
  "mintedAt": 1762041600,
  "claimedAt": 1762045200,
  "voidedAt": null
}
```

### `MinterJson`

An npub authorized to mint.

```ts
interface MinterJson {
  pubkey: string        // hex, always lowercase
  npub: string
  label: string | null  // up to 80 chars
  createdAt: number
}
```

```json
{
  "pubkey": "7d1f4c8a90b3e26d5f0a1c8e4b7936da2f5c08e1b46d97a3c02e5f8b1d64a9c3",
  "npub": "npub10501y32ze7ymt470586yhpxmw3atsx8pk3ke0g7q9e0chr4j5ussk4h9uf",
  "label": "Caja 2",
  "createdAt": 1762041600
}
```

### `RedemptionJson`

A redemption, with the order it paid for. Returned by `GET /api/coupons/redemptions`.

```ts
interface RedemptionJson {
  nonce: string
  claimedAt: number
  couponId: string
  name: string
  benefit: Benefit | null   // the snapshot frozen at mint time
  order: SignedEvent | null // the signed kind-9734, verbatim
  orderId: string | null    // order.id, for indexing
  amountMsat: number | null // 0 ⇒ reclaimed, will never have a receipt
}
```

```json
{
  "nonce": "MsBNsNq-0GYzXAd7Z6Lu1A",
  "claimedAt": 1762045200,
  "couponId": "55b5ee4f-4dcc-4a6a-a58e-6d1d94d811a3",
  "name": "Cerveza gratis",
  "benefit": {
    "type": "freeItems",
    "items": [{ "d": "aab1c0de-7f2c-4b8e-9d31-2c5f6a8b1e40", "qty": 1 }]
  },
  "order": {
    "kind": 9734,
    "pubkey": "31ac7f0e5d92b8461a0c3f7e2d85916b4c0fa73e8d21596b0c4e7a3f81d2560b",
    "created_at": 1762045190,
    "content": "Pedido · 3 ítems · ARS 3000",
    "tags": [
      ["p", "2ad91f1dca2dcd5fc89e7208d1e5059f0bac0870d63fc3bac21c7a9388fa18fd"],
      ["order", "1"],
      ["items_count", "3"],
      ["total", "3000", "ARS"],
      ["coupon", "55b5ee4f-4dcc-4a6a-a58e-6d1d94d811a3", "freeItems", "Cerveza gratis"],
      ["discount", "1000", "ARS"],
      ["item", "aab1c0de-7f2c-4b8e-9d31-2c5f6a8b1e40", "2", "1000", "ARS"]
    ],
    "id": "910c292aaecb6fb478ce933e32d0de6c7f55add70d533103f8f47e785324eacd",
    "sig": "…"
  },
  "orderId": "910c292aaecb6fb478ce933e32d0de6c7f55add70d533103f8f47e785324eacd",
  "amountMsat": 0
}
```

`order: null` is normal, not an error: a coupon scanned at a counter never went through a checkout, and neither did anything redeemed before the app started filing orders.

### `CouponPayloadJson`

What is handed to whoever holds the coupon. It is the base of the mint and claim responses.

```ts
interface CouponPayloadJson {
  couponId: string
  coupon: Benefit    // the MINT's snapshot, not the current columns
  name: string
  description: string
  npub: string       // the OWNER — check this to know the coupon is for this shop
  image: string | null
  nonce: string
  expiresAt: number | null
}
```

### `SignedEvent`

A nostr event, as-is. It shows up as `voucher`, as `discovery` and as `order`.

```ts
interface SignedEvent {
  id: string; pubkey: string; created_at: number
  kind: number; tags: string[][]; content: string; sig: string
}
```

---

## Endpoints

### `POST /api/auth/session`

Trades a NIP-98 signature for a 12 h bearer. **No body** — the event already binds `u` and `method`, and hashing a body defends against no replay at all: whoever can repeat the header can repeat the bytes underneath it.

```bash
curl -X POST https://merchant.lacrypta.ar/api/auth/session \
  -H "Authorization: Nostr $NIP98"
```

```json
{
  "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9…",
  "pubkey": "2ad91f1dca2dcd5fc89e7208d1e5059f0bac0870d63fc3bac21c7a9388fa18fd",
  "expiresAt": 1762088400
}
```

`pubkey` and `expiresAt` are echoed so **the client never decodes the token**: the moment somebody reads a claim, somebody starts trusting one, and the browser cannot check the signature that would make it true.

`200`, not `201`: no addressable resource exists afterwards.

| Error | When |
|---|---|
| `400` | You sent a body |
| `401` + `reason` | Invalid NIP-98 |
| `429` | 20/min |

---

### `GET /api/coupons`

Coupons + minters + announcement, in one call. **That is not laziness:** every request costs a signature, and on a NIP-46 bunker every signature is a round trip to the merchant's phone. Two endpoints would mean two taps to open one page.

```bash
curl https://merchant.lacrypta.ar/api/coupons -H "Authorization: Bearer $TOKEN"
```

```jsonc
{
  "coupons": [ /* DefinitionJson[], newest first, archived included */ ],
  "minters": [ /* MinterJson[] */ ],
  "discovery": { /* SignedEvent kind 30078 */ }   // null if never activated
}
```

Archived ones are included: the merchant needs to see that a retired coupon still has 12 unclaimed instances out in the world.

---

### `POST /api/coupons`

Creates a definition.

```jsonc
{
  "name": "20% de verano",                    // required, 1..80
  "description": "No acumulable.",            // optional, up to 500
  "image": "https://blossom.example/9f3c.webp", // optional, https or null
  "benefit": { "type": "percent", "percent": 20,
               "cap": { "amount": 5000, "currency": "ARS" } },  // required
  "maxUses": 100,                             // optional, null ⇒ unlimited
  "expiresAt": 1764633600                     // optional, unix SECONDS, in the future
}
```

**`201`** with `{ "coupon": DefinitionJson }`.

| Error | Message |
|---|---|
| `400` | `Poné un nombre de hasta 80 caracteres.` |
| `400` | `La descripción puede tener hasta 500 caracteres.` |
| `400` | `La imagen tiene que ser una URL https.` |
| `400` | `El cupón no es válido: <reason>.` — the reason comes from `parseBenefit` |
| `400` | `El máximo de usos no es válido.` |
| `400` | `La fecha de vencimiento no es válida.` / `…ya pasó.` |

The image is validated the way `woo-config.ts` does, and for the same reason: that string ends up in somebody else's `<img src>`. https, no embedded credentials, a real hostname.

**On `POST` the date must be in the future; on `PATCH` it need not be.** A past date is the kill switch for coupons already issued, and only makes sense on a coupon that exists.

---

### `PATCH /api/coupons/{id}`

Edits. Every field is optional; only what you send is touched. An empty body is `400` (`No hay nada para cambiar.`).

```jsonc
{
  "name": "20% de verano",
  "description": "…",
  "image": null,              // null clears the image
  "benefit": { … },
  "maxUses": null,            // null removes the limit
  "expiresAt": 1735689600,    // a PAST date kills the ones already out there
  "archived": true            // stops new mints, not redemptions
}
```

`200` with `{ "coupon": DefinitionJson }`, counters re-read so the client's row comes back complete rather than half-fresh.

| Error | When |
|---|---|
| `404` | Does not exist **or belongs to somebody else** — a stranger probing UUIDs gets the same answer either way |
| `400` | Same as `POST`, plus `No hay nada para cambiar.` |

Lowering `maxUses` below what has already been minted **is allowed**: it stops further minting without touching coupons already handed out.

> Editing the definition **does not change** what an already-minted coupon promises. The voucher was signed over the snapshot frozen in `coupon_mints.benefit`.

---

### `DELETE /api/coupons/{id}`

Deletes if nothing was ever minted; archives otherwise. A definition with coupons in circulation cannot be deleted: the nonces in people's phones point at it, and they are still owed.

```json
{ "deleted": false, "archived": true }
```

---

### `GET /api/coupons/{id}/mints`

The issuances of one coupon, newest first.

```json
{ "mints": [ /* MintJson[] */ ] }
```

A separate endpoint from `GET /api/coupons` on purpose: the list of definitions is what the page opens with and it is small; this can be hundreds of rows for a coupon that has been handed out all month, so it loads when the merchant actually asks for it.

---

### `DELETE /api/coupons/{id}/mints/{nonce}`

Voids an issuance that was never redeemed. `200` with `{ "mint": MintJson }` — the row comes back with `status: "voided"`.

| Error | When |
|---|---|
| `404` | No such issuance, or the coupon belongs to somebody else |
| `409` | `Ese cupón ya fue canjeado, no se puede anular.` |
| `409` | `Ese cupón ya estaba anulado.` |

It is nested under the definition so ownership comes from the path: the nonce alone is a bearer token, and an endpoint that acted on it without checking who owns the coupon would let anyone void anyone's issuance.

**The row survives.** A till that scans a cancelled QR has to be told it was cancelled; a deleted row could only answer "does not exist", which sends the cashier looking for a typo that is not there.

**It gives the slot back to the cap.** Whoever misclicks "Emitir" on a single-use coupon would otherwise have to go edit the coupon to issue it again, and "this issuance never happened" is exactly what voiding means.

---

### `GET /api/coupons/redemptions`

Every redemption for this merchant, with the order each one paid for. Newest first, **capped at 500**.

```json
{ "redemptions": [ /* RedemptionJson[] */ ] }
```

This is the closest thing to an orders table in the app. A paid purchase is still reconstructed from its zap receipt on the relays — but one a coupon took to zero is never invoiced, never receipted, and would exist nowhere. The row written at claim time is its only record.

Its own endpoint rather than a field on `GET /api/coupons`: that response is what the page opens with, and stapling a signed event per redemption to it would make it grow with the merchant's sales.

---

### `POST /api/coupons/mint`

**Mint.** This is the `mintUrl` from the announcement. Two gates: a valid signature, and the signer being either the owner or somebody on the minters list.

```json
{ "couponId": "55b5ee4f-4dcc-4a6a-a58e-6d1d94d811a3" }
```

```jsonc
{
  "couponId":    "55b5ee4f-4dcc-4a6a-a58e-6d1d94d811a3",
  "coupon":      { "type": "percent", "percent": 20,
                   "cap": { "amount": 5000, "currency": "ARS" } },
  "name":        "20% de verano",
  "description": "No acumulable.",
  "npub":        "npub19tv378w29hx4ljy7wgydreg9nu96czrs6clu8wkzr3af8z86rr7sujx4xe",
  "image":       "https://blossom.example/9f3c.webp",
  "nonce":       "hcLPDzERvvHzS4Vn0OLbAQ",
  "expiresAt":   1764633600,
  "voucher":     { /* SignedEvent kind 20402, phase "minted" */ }
}
```

| Error | When |
|---|---|
| `400` | `Falta el cupón.` — `couponId` is not a uuid |
| `403` | `No estás autorizado a emitir este cupón.` |
| `404` | Does not exist |
| `409` | `Se agotaron los cupones disponibles.` |
| `410` | `El cupón fue archivado.` / `El cupón está vencido.` |
| `503` | No database, no manager, or the definition does not parse |

**The nonce is 16 random bytes in base64url (22 characters):** unguessable and it fits in any QR. **It is a bearer token** — whoever holds it can redeem. It exists only in this response and in the database, it is never logged, and the response is never cached.

The mint cap holds via the `UPDATE … WHERE minted_count < max_uses` that increments the counter. Counting rows in `coupon_mints` would be a race.

---

### `GET /api/coupons/claim?nonce=…`

**Checks without consuming.** This is half of the `claimUrl`. Our own storefront calls it the moment somebody pastes a code, so it can show the discount before anything is spent.

```bash
curl "https://merchant.lacrypta.ar/api/coupons/claim?nonce=hcLPDzERvvHzS4Vn0OLbAQ"
```

```jsonc
{
  "status": "minted",          // minted | claimed | expired | voided
  "couponId": "55b5ee4f-4dcc-4a6a-a58e-6d1d94d811a3",
  "coupon": { "type": "percent", "percent": 20, "cap": { "amount": 5000, "currency": "ARS" } },
  "name": "20% de verano",
  "description": "No acumulable.",
  "npub": "npub19tv378w29hx4ljy7wgydreg9nu96czrs6clu8wkzr3af8z86rr7sujx4xe",
  "image": "https://blossom.example/9f3c.webp",
  "nonce": "hcLPDzERvvHzS4Vn0OLbAQ",
  "expiresAt": 1764633600,
  "claimedAt": null
}
```

**Always `200` for a nonce we recognize**, with the reason in `status`. This is a preview endpoint: an HTTP error would make "already used" and "expired" look exactly like a network fault, and the cashier would not know which of the three happened.

`voided` outranks `expired`: a merchant cancelling an issuance is a decision, and saying "expired" would send them to change a date that has nothing to do with it.

| Error | When |
|---|---|
| `400` | `Falta el cupón.` — no `nonce`, or a malformed one |
| `404` | `Cupón inexistente.` |

> **One deployment serves many shops**, and this endpoint answers for any nonce it knows — it has to, because a POS validating a code has no storefront context. If you are a storefront, **check `npub` against the merchant you are charging**; without that, somebody carries a 50%-off from one shop to another.

---

### `POST /api/coupons/claim`

**Redeems.** Consumes the nonce, once.

```jsonc
{
  "nonce": "hcLPDzERvvHzS4Vn0OLbAQ",   // required
  "zapRequest": { /* signed kind 9734 */ },   // optional
  "amountMsat": 0                             // optional, integer ≥ 0
}
```

`zapRequest` and `amountMsat` describe **what is being bought** and are stored on the redemption row. They are the only record a reclaimed order has, and what makes the sale show up in `/admin/orders`. `amountMsat: 0` is what marks it "reclaimed": it distinguishes *will never have a receipt* from *has not arrived yet*.

To be filed, the event must verify its signature, be `kind 9734`, carry a `coupon` tag and weigh under 8000 characters. If it does not, **the redemption still happens** and all that is lost is the record: refusing a coupon to somebody standing at the counter because we could not file the paperwork is the worst possible outcome.

```jsonc
{
  "status": "success",         // or "claimed"
  "claimedAt": 1762045200,
  "couponId": "…", "coupon": { … }, "name": "…", "description": "…",
  "npub": "…", "image": null, "nonce": "…", "expiresAt": null,
  "voucher": { /* SignedEvent kind 20402, phase "claimed" */ }
}
```

| Status | Means |
|---|---|
| `200` `success` | Just redeemed |
| `200` `claimed` | Already redeemed, with the **original** `claimedAt` |

**"Already redeemed" being `200` and not an error is deliberate:** a POS that lost our response retries, and by comparing `claimedAt` against its own clock it knows whether the redemption was its own. An error would collapse "I redeemed this" and "somebody beat me to it" into "the request failed".

| Error | When |
|---|---|
| `400` | `Falta el cupón.` / `Cuerpo inválido.` |
| `404` | `Cupón inexistente.` |
| `410` | `El cupón fue anulado.` / `El cupón está vencido.` |

Concurrency is decided by the database, not by this process:

```sql
UPDATE coupon_mints SET status='claimed', claimed_at=now(),
       order_event = $2, order_id = $3, amount_msat = $4
 WHERE nonce = $1 AND status = 'minted' AND EXISTS (… not expired …)
RETURNING *;
```

Two tills scanning the same QR at the same instant produce one UPDATE that returns a row and one that does not; the second is reported as already claimed. A read-then-write would be a race with money on the other side of it.

**The order rides in that same UPDATE**: a row cannot end up claimed without the order that claimed it, and the second caller — who by definition lost the race — cannot overwrite the winner's order with their own.

---

### `GET /api/coupons/mintable`

What the asking npub is allowed to mint, across every merchant that authorized them. This is what a POS draws its buttons from.

```jsonc
{
  "coupons": [
    {
      "id": "55b5ee4f-4dcc-4a6a-a58e-6d1d94d811a3",
      "name": "20% de verano",
      "description": "No acumulable.",
      "image": "https://blossom.example/9f3c.webp",
      "coupon": { "type": "percent", "percent": 20, "cap": { "amount": 5000, "currency": "ARS" } },
      "npub": "npub19tv378w29hx4ljy7wgydreg9nu96czrs6clu8wkzr3af8z86rr7sujx4xe",
      "remaining": 88,        // null ⇒ unlimited
      "expiresAt": 1764633600
    }
  ]
}
```

Archived, expired and exhausted ones are filtered **server-side**: a terminal showing an option that always fails is worse than one that does not show it. Ones that do not parse are dropped too — a definition whose terms we cannot state is not offerable.

---

### `GET` / `POST /api/coupons/minters`, `DELETE /api/coupons/minters/{pubkey}`

The npubs allowed to mint: a cashier's phone, a second terminal, a partner shop running its own POS.

`GET` → `{ "minters": MinterJson[] }`. It exists for symmetry and for a POS that wants to show the list; the management page gets them from `GET /api/coupons`, in the same round trip.

`POST` accepts **npub, nprofile, hex or a NIP-05 address**:

```json
{ "pubkey": "caja2@lacrypta.ar", "label": "Caja 2" }
```

**`201`** with `{ "minter": MinterJson }`. Only the hex is stored: the address is resolved once, here, and never followed again.

| Error | When |
|---|---|
| `400` | `Ya podés emitir tus propios cupones.` — the owner is never a row on their own list |
| `400` / `404` | The key or the address does not resolve |

`DELETE /api/coupons/minters/{pubkey}` (npub or hex, url-encoded) → `{ "removed": true }`, or `404` if it was not there.

**Revoking does not touch what was already minted.** Those coupons went to customers who had nothing to do with this; revoking stops further issuance, which is what "remove this employee" means.

---

### `PUT /api/coupons/discovery`

Stores the 30078 announcement the merchant signed.

```json
{ "event": { "kind": 30078, "…": "…" } }
```

`200` with `{ "event": SignedEvent }`.

**We store the event, we do not mint it.** The signature is the merchant's and this service could not forge one; all this endpoint does is remember what they already signed, so it can be re-broadcast later without asking them again.

Everything is validated because the caller controls everything, and a bad row here would be re-broadcast to relays under the merchant's name:

| Error | When |
|---|---|
| `400` | `Cuerpo inválido.` — event shape |
| `400` | `Ese evento no es tu anuncio de cupones.` — `d` or `pubkey` do not match |
| `400` | `El evento no tiene una fecha válida.` |
| `400` | `La firma del evento no es válida.` |
| `400` | `El anuncio no se puede leer: <reason>.` |

Reading it back is **not here**: it rides along with `GET /api/coupons`, so the page costs one signature instead of two.

---

### `GET /api/coupons/manager`

The pubkey that signs the vouchers. No auth — it is public information and a POS needs it to verify.

```json
{
  "pubkey": "9f5c4e2ab13d7f60c8a4e9021b6d5f38a7c04e91d2b8635fa0c7e41d9b6532af",
  "npub": "npub1na3388t8384asezn5sgxmd403c47qya36jhp3lgx8usa8dk2v40qx6emh9"
}
```

The only cacheable route: `public, max-age=300`. The key is stable for the life of the deployment; the short TTL only makes setting the variable for the first time show up promptly.

`503` if the server has no `COUPON_MANAGER_NSEC`.

---

## Error catalog

| Code | Means | What to do |
|---|---|---|
| `400` | Invalid body or parameter | Fix the request. The message says what |
| `401` | Invalid auth (see `reason`) | Re-sign. On `session-*`, re-mint the session |
| `403` | Authenticated but not allowed to mint | Ask the owner to authorize you |
| `404` | Does not exist **or belongs to somebody else** | Do not retry |
| `409` | State conflict: exhausted, already claimed, already voided | Do not retry |
| `410` | Terminal: expired or archived | Do not retry |
| `413` | Body over 16 KB | Not our use case |
| `429` | Rate limit | Wait `retryAfter` seconds |
| `503` | No database, no manager, or a database error | Retry with backoff |

`404` for "belongs to somebody else" is deliberate: to a stranger probing UUIDs, "does not exist" and "not yours" have to look the same.

---

## Example client

Node ≥ 20, with `nostr-tools`. Mints a coupon and redeems it, signing NIP-98 by hand.

```js
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"

const BASE = "https://merchant.lacrypta.ar"
const sk = /* your secret key, 32 bytes */

function nip98(url, method, body) {
  const tags = [
    ["u", url],
    ["method", method],
    // Without this, two identical requests in the same second hash to the same
    // id and the second is rejected with reason: "replay".
    ["nonce", Math.random().toString(36).slice(2)],
  ]
  if (body) tags.push(["payload", bytesToHex(sha256(utf8ToBytes(body)))])
  const event = finalizeEvent(
    { kind: 27235, created_at: Math.floor(Date.now() / 1000), content: "", tags },
    sk
  )
  return `Nostr ${Buffer.from(JSON.stringify(event)).toString("base64")}`
}

async function call(path, method = "GET", payload) {
  const url = `${BASE}${path}`
  const body = payload === undefined ? undefined : JSON.stringify(payload)
  const res = await fetch(url, {
    method,
    headers: {
      authorization: nip98(url, method, body),
      ...(body ? { "content-type": "application/json" } : {}),
    },
    body,
  })
  const json = await res.json()
  if (!res.ok) throw new Error(`${method} ${path} → ${res.status} ${json.error}`)
  return json
}

// 1. Create a definition.
const { coupon } = await call("/api/coupons", "POST", {
  name: "20% de verano",
  description: "No acumulable.",
  image: null,
  benefit: { type: "percent", percent: 20, cap: { amount: 5000, currency: "ARS" } },
  maxUses: 100,
  expiresAt: null,
})

// 2. Mint one instance. The nonce is what goes in the QR.
const minted = await call("/api/coupons/mint", "POST", { couponId: coupon.id })
console.log(minted.nonce, minted.voucher.pubkey)

// 3. Check without consuming — no auth.
const check = await (await fetch(`${BASE}/api/coupons/claim?nonce=${minted.nonce}`)).json()
console.log(check.status)        // "minted"

// 4. Redeem. No auth: the nonce IS the credential.
const claimed = await (
  await fetch(`${BASE}/api/coupons/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce: minted.nonce }),
  })
).json()
console.log(claimed.status)      // "success"
```

To trade the signature for a session, replace the header in `call`:

```js
const { token } = await call("/api/auth/session", "POST")
// then: headers: { authorization: `Bearer ${token}` }
```
