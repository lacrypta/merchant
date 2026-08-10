# Data

Four tables, in [`src/lib/server/db/schema.ts`](../src/lib/server/db/schema.ts). It is the only part of the app with Postgres, and the [why](./cupones.md#why-there-is-a-database) is on the front page.

Pubkeys are always stored as **lowercase 64-character hex**. `npub` is a display encoding and never a key here, same as in `nip05.ts`.

---

## `coupon_definitions`

What the merchant authored: a coupon that can be minted N times.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `owner_pubkey` | `varchar(64)` | Indexed. The owner |
| `name` | `varchar(80)` | |
| `description` | `varchar(500)` | `''` when it has none |
| `image_url` | `varchar(500)` | https, or null |
| `type` | `coupon_type` | `percent \| fixed \| multibuy \| buy_x_get_y \| free_items` |
| `percent` | `integer` | 1..100. `percent` only |
| `amount` | `numeric(14,2)` | `fixed` only. **pg returns it as a string** |
| `currency` | `varchar(3)` | `fixed` only |
| `buy_qty` / `pay_qty` | `integer` | `multibuy` only |
| `product_ds` | `jsonb` | The scope. Null ⇒ every product |
| `buy_product_d` / `gift_product_d` | `uuid` | `buy_x_get_y` only |
| `free_items` | `jsonb` | `[{ d, qty }]`. Never null for that type |
| `cap_amount` / `cap_currency` | `numeric(14,2)` / `varchar(3)` | The ceiling. **Both null, or both set** |
| `max_uses` | `integer` | Null ⇒ unlimited |
| `minted_count` | `integer` | See below |
| `expires_at` | `timestamptz` | Stops minting **and** redeeming |
| `archived_at` | `timestamptz` | Stops **only** minting |
| `created_at` / `updated_at` | `timestamptz` | |

One row, as `psql` reads it:

```text
id            | 55b5ee4f-4dcc-4a6a-a58e-6d1d94d811a3
owner_pubkey  | 2ad91f1dca2dcd5fc89e7208d1e5059f0bac0870d63fc3bac21c7a9388fa18fd
name          | 20% de verano
description   | No acumulable.
image_url     | https://blossom.example/9f3c.webp
type          | percent
percent       | 20
amount        |
currency      |
buy_qty       |
pay_qty       |
product_ds    |
cap_amount    | 5000.00
cap_currency  | ARS
max_uses      | 100
minted_count  | 12
expires_at    | 2025-12-02 00:00:00+00
archived_at   |
```

That row is the `DefinitionJson` from the [API example](./cupones-api.md#definitionjson).

### Why typed columns and not one jsonb

The benefit lives in **typed, nullable columns** rather than a single blob: that way the table can be read, indexed and corrected with plain SQL when something breaks at 3am. `parseBenefit` in the domain layer is what guarantees the right subset is populated for each `type`.

The two exceptions are lists, which is why they are jsonb: `product_ds` (the scope) and `free_items` (the `{ d, qty }` pairs handed over). They are separate columns on purpose — one **narrows** a discount and the other **is** the discount, and sharing them would force every reader to check `type` before knowing which of the two things they are looking at.

### `minted_count`

It is incremented **inside the guarded UPDATE that mints**, which is what makes the cap hold under concurrency. Counting rows in `coupon_mints` would be a race.

Voiding an issuance **decrements** it: the slot goes back to the cap, because "this issuance never happened" is exactly what voiding means.

### `expires_at` vs `archived_at`

`archived_at` stops **only new mints**; what is already out in the world stays claimable, because it was a promise the merchant made. To cut those off, `expires_at` goes into the past — which is why `PATCH` accepts a past date and `POST` does not.

---

## `coupon_mints`

One issuance each. The nonce is the bearer credential.

| Column | Type | Notes |
|---|---|---|
| `id` | `uuid` PK | |
| `definition_id` | `uuid` FK | `ON DELETE RESTRICT` |
| `nonce` | `varchar(32)` | **Unique**. 22 chars base64url |
| `benefit` | `jsonb` | The **frozen snapshot** taken at mint time |
| `minted_by_pubkey` | `varchar(64)` | Who issued it |
| `minted_at` | `timestamptz` | |
| `status` | `coupon_mint_status` | `minted \| claimed \| voided` |
| `claimed_at` / `voided_at` | `timestamptz` | |
| `order_event` | `jsonb` | The signed kind-9734, verbatim |
| `order_id` | `varchar(64)` | **Indexed.** `order_event.id` |
| `amount_msat` | `integer` | What was going to be charged. `0` ⇒ reclaimed |

Indexes: `nonce` unique, `(definition_id, status)` for the dialog's list, `order_id` to answer "which coupon paid for order X?" without scanning jsonb.

### Why the benefit is frozen

Editing a coupon changes the definition, but the voucher the manager already signed says something else. Redemption serves the snapshot, so **a coupon in somebody's phone is worth what it said when they were given it**.

### The order hangs off the redemption

Because there is no other table to put it in. Everything else lives on relays, and a paid order is reconstructed from its zap receipt — but a coupon that takes the total to zero produces no invoice, and therefore no receipt either.

The three columns are nullable: a coupon redeemed at a counter never went through a checkout, and neither did anything redeemed before the app started filing them.

They are written **in the same UPDATE that claims**, so a row cannot end up claimed without the order that claimed it, and the second caller — who by definition lost the race — cannot overwrite the first one's order.

### `RESTRICT`, not `CASCADE`

The delete route archives a definition that has issuances and hard-deletes only a pristine one. With `RESTRICT`, "the definition vanished between the mint and the claim" is impossible by construction rather than by convention.

---

## `coupon_minters`

Who may mint on whose behalf.

| Column | Type | Notes |
|---|---|---|
| `owner_pubkey` | `varchar(64)` | Composite PK |
| `minter_pubkey` | `varchar(64)` | Composite PK |
| `label` | `varchar(80)` | "Caja 2". Optional |
| `created_at` | `timestamptz` | |

An extra index on `minter_pubkey`: it is the lookup behind `GET /api/coupons/mintable` — *"which owners let ME mint?"*.

**The owner is never a row here.** Their right to mint their own coupons is implicit, and storing it would leave the UI showing the merchant to themselves as one of their own employees.

---

## `coupon_discovery`

The merchant's signed announcement, as-is.

| Column | Type | Notes |
|---|---|---|
| `owner_pubkey` | `varchar(64)` PK | One row per merchant |
| `event` | `jsonb` | The full `SignedEvent` |
| `event_created_at` | `integer` | The event's own `created_at` |
| `updated_at` | `timestamptz` | |

Keeping the **signed** event gives two things a relay round trip cannot: the page knows it is activated the instant it loads, and a re-broadcast needs no new signature, because the bytes we would publish are the bytes we already have.

`event_created_at` is separate so a stale copy can never overwrite a newer one. Kind 30078 is addressable, so there is only ever one current announcement per `d`.

---

## Migrations

In [`drizzle/`](../drizzle/), applied at build time. The ones for this subsystem:

| Migration | What it added |
|---|---|
| `0000` | `coupon_definitions`, `coupon_mints`, `coupon_minters` |
| `0001` | `coupon_discovery` |
| `0002`–`0005` | List-based scope (`product_ds`), `voided_at`, `free_items` |
| `0006` | `order_event`, `order_id`, `amount_msat` on `coupon_mints` |
| `0007` | `cap_amount`, `cap_currency` on `coupon_definitions` |

The last two are nullable `ADD COLUMN`s: they rewrite no rows and break nothing already issued.
