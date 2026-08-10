# Discounts

What each coupon type takes off, and under which rules. All of this lives in [`src/lib/domain/coupon.ts`](../src/lib/domain/coupon.ts) and is **pure** — no React, no network, no clock. The server stores these shapes in Postgres and the storefront prices them; both go through the same module, so a discount cannot mean one thing at the till and another in the database.

See also: [the exact JSON shape of each type](./cupones-api.md#benefit), with copy-paste examples.

---

## The five types

`Benefit` is a discriminated union, not a bag of optional fields: "a 2-for-1 with a percentage" is not a thing, and the type system says so once here instead of every caller re-checking.

| Type | Shape | Example |
|---|---|---|
| `percent` | `{ type, percent, productDs? }` | 10% off |
| `fixed` | `{ type, amount, currency, productDs? }` | ARS 500 off |
| `multibuy` | `{ type, buyQty, payQty, productDs? }` | 2-for-1, 3-for-2 |
| `buyXgetY` | `{ type, buyProductD, giftProductD }` | Buy A, get B free |
| `freeItems` | `{ type, items: [{ d, qty }] }` | 2 free coffees |

All five also accept an optional **`cap`**. See [Discount cap](#discount-cap).

`currency` is `ARS`, `USD` or `SAT`. In sats the amount has to be a **whole number**: half a satoshi cannot be charged, and rounding it silently would make the coupon worth something other than what it says.

### Limits

| Constant | Value | What it bounds |
|---|---|---|
| `MAX_COUPON_NAME` | 80 | Characters in the name |
| `MAX_COUPON_DESCRIPTION` | 500 | Characters in the description |
| `MAX_COUPON_IMAGE_URL` | 500 | Length of the image URL |
| `MAX_MULTIBUY_QTY` | 100 | `buyQty` and `payQty` |
| `MAX_FREE_QTY` | 100 | Units of one product in `freeItems` |
| `MAX_COUPON_PRODUCTS` | 50 | Products a single coupon may name |
| `MAX_COUPON_USES` | 1,000,000 | Mints per definition |

---

## What each one discounts

Against a basket of **2 empanadas at ARS 100** and **1 coffee at ARS 250** (gross: ARS 450):

| Coupon | Takes off | Why |
|---|---|---|
| `percent` 10% | ARS 45 | 10% of each currency's subtotal |
| `percent` 10%, `cap` ARS 20 | ARS 20 | The cap cuts in first |
| `fixed` ARS 500 | ARS 450 | Capped at the basket's value |
| `fixed` ARS 500 on coffee | ARS 250 | Capped at what the coffee is worth in the basket |
| `multibuy` 2-for-1 on empanada | ARS 100 | One complete group of 2 ⇒ 1 free |
| `buyXgetY` empanada → coffee | ARS 250 | One gift, always one |
| `freeItems` 1 empanada + 1 coffee | ARS 350 | The gifted units, at their line price |
| `freeItems` 3 empanadas | ARS 200 | There are only 2 in the basket: 2 are given away |

---

## Product scope

The first three accept `productDs`: a list of product `d`s (the UUIDs this app generates for each NIP-99 listing).

**Absent means everything.** That default is the important half: somebody offering "10% off" means the whole shop, and making them tick every product to say so would be a worse coupon system. An empty list is normalized to absent — whoever cleared the picker meant "all", not "none".

With a list:

- **`percent`** is computed over those lines only.
- **`fixed`** is capped at what those lines are worth *in the coupon's currency*. "ARS 500 off coffee" against a basket holding ARS 200 of coffee and ARS 5000 of everything else takes off 200. Without that cap, a narrowed coupon would quietly discount the rest of the basket.
- **`multibuy`** is counted per line: with several products, each one adds up on its own. "2-for-1 on any of these three" is three independent promos, not one shared between them.

`buyXgetY` carries no `productDs` because it already names its two products. `A === B` is legal and equals a 2-for-1.

> **Compatibility:** `parseBenefit` still accepts a singular `productD`. Minted coupons store their benefit as a frozen snapshot, and rows written before the scope was a list have to keep parsing — otherwise a 2-for-1 sitting in somebody's phone would stop working.

---

## Discount cap

Any of the five accepts an optional **`cap`**:

```jsonc
{ "type": "percent", "percent": 20, "cap": { "amount": 5000, "currency": "ARS" } }
```

It is "20% off, up to ARS 5,000", and it is what makes a percentage safe to hand out — without it, one unusually large basket eats the whole promo budget.

It applies to **every** type on purpose: a 2-for-1 on a case of wine and an expensive free product need the same brake, and having it only on `percent` would be an arbitrary hole. It is intersected onto the union rather than repeated in each member — writing it five times is how the sixth type ends up without it.

Rules:

- **It clamps the entries in its own currency and leaves the other currencies untouched.** The same rule `fixed` already follows, and for the same reason: converting would need the rate table that layer deliberately does not take, and guessing at a number is worse than applying the ceiling where it was authored. On a single-currency basket — the common case — that is exactly "up to ARS 5,000". On a mixed one, an ARS ceiling bounds the ARS share and the USD lines keep whatever the terms gave them.
- **In the order book it is spread proportionally** across the lines (`discountByLine`), not cut off the first one: the ceiling is a property of the whole discount, and taking it out of one product would report that product as having absorbed a cut it never had.
- **An absent `cap` — or a `null` one — means no ceiling. `0` is rejected**, not treated as absent: a ceiling of zero would be a coupon that discounts nothing, so `parseBenefit` answers `el tope tiene que ser mayor a 0` rather than silently ignoring it.
- In sats it has to be a **whole number**, same as `fixed`.

An example of the proportional spread: a 50% off with a cap of ARS 500, against two lines of ARS 3,000 and ARS 1,000, would give 1,500 and 500 uncapped; with the cap it gives **375 and 125** — the same proportion over 500.

---

## Free product (`freeItems`)

The only benefit with **no purchase condition**: the coupon *is* the product. You pick a list of products with a quantity each — `[{ d, qty }]` — and those units come off the total.

It is the exception to the "absent means everything" rule, and deliberately so: **here an empty list does not mean "all"**, it means the coupon is invalid. In the other types "all" is a discount over the shop; in this one it would be giving away the catalog, which is not something anybody means by accident.

`parseBenefit` rejects:

- the empty list (`elegí al menos un producto`),
- a repeated product — two entries of the same coffee could be 2 or 5, and guessing which is worse than asking for it once,
- quantities outside 1..`MAX_FREE_QTY`.

Two rules that fall out of still needing the product in the basket:

- **It is capped against the basket.** A coupon for 3 coffees against a basket holding 1 gives 1. It never discounts units that are not there.
- **It applies product by product.** If the coupon gives 1 empanada and 2 coffees, and the basket only holds empanada, the empanada comes out free anyway. That is why `unmet.anyOf` is `true`: any one of the products is enough for the coupon to do something, and the storefront says "add one of these" instead of demanding the full list.

The difference with `buyXgetY` is the condition: that one requires the paid product to be in the basket and gives away **one**; this one requires nothing and gives away **the quantities it names**.

---

## Arithmetic rules

They live in `priceCart()` and they are what keeps the charge honest:

- **Rounding happens exactly once, over the already-discounted basket.** That is the rule from [`rates.ts`](../src/lib/domain/rates.ts): a total is the ceiling of the sum, never the sum of the ceilings. That is why the discount is applied by **scaling** every subtotal by the same factor instead of subtracting from one currency — in a mixed basket, subtracting from the ARS row would leave the breakdown not adding up to the sat total.
- **The cap is applied before anything else.** `discountEntries` already returns the clamped entry, so the conversion to sats and the clamp against the basket's value both work on the number the coupon actually promises.
- **Zero is reachable.** `MIN_CHARGE_SATS` is 0. A zero-sat invoice is still unpayable — wallets reject it and LNURL declares a `minSendable` of at least 1 — so a zero total **produces no invoice**: the checkout swaps "Generar factura" for **"Reclamar"** and the coupon redemption becomes the record of the order. See [Flows § 3](./cupones-flujos.md#3-redeeming-in-this-apps-own-storefront).
- **A discount that cannot be converted is not guessed at.** If a currency's rate is missing, the coupon does not apply and it says why.

### When the coupon does not apply

`priceCart` returns `unmet` with the reason:

| `unmet.kind` | Means | What the storefront says |
|---|---|---|
| `empty-cart` | Nothing in the basket | "Agregá productos para usar el cupón" |
| `unquotable` | A currency's rate is missing | "No pudimos convertir USD a sats todavía" |
| `needs-products` | The products the coupon names are missing | "Te falta agregar 2 × Café" |

`needs-products` also carries `anyOf`, which distinguishes "any one of these is enough" (scoped percentage or fixed amount, and `freeItems`) from "you need both" (`buyXgetY`). Joining the first with "and" would silently turn it into the second.

### Per-line attribution

`discountEntries` answers *how much, per currency* — which is all the checkout needs, because it charges one total. The order book needs the other half: `discountByLine` splits that same discount across **the lines it actually came off**.

A free-beer coupon took the price of one beer, not a slice of every line. Spreading it proportionally leaves every product in the basket with revenue it never had — and the "Reporte por producto" on `/admin/orders` comes out wrong for all of them.

| Type | How it is split |
|---|---|
| `multibuy`, `buyXgetY`, `freeItems` | Whole units of the named product. The only honest split |
| `percent` | The percentage over each line in scope |
| `fixed` | Proportionally, and **only** over the lines in its scope and its currency — a lump sum genuinely has no line of its own |
