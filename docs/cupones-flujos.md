# Flows

How it all chains together, end to end, and which decisions not to revert without reading why.

---

## 1. Activating the service

```text
Merchant               This app                    Database        Relays
    │                     │                          │               │
    │ "Activar servicio"  │                          │               │
    ├────────────────────►│ GET /api/coupons/manager │               │
    │                     │◄─── managerPubkey ───────┤               │
    │  signs the 30078    │                          │               │
    │  (p tag = manager)  │                          │               │
    │◄────────────────────┤                          │               │
    ├────────────────────►│ PUT /discovery ─────────►│ stores        │
    │                     ├─────────── publishes ────────────────────►│
```text

It is stored **the moment it is signed**, before the relays answer: losing that copy because a relay was slow is the bug this mechanism exists to fix.

Until it is activated **no coupons can be created**. A coupon nobody can discover is a row in a database nobody can reach. The gate is in the UI, not in the API: a POS that already knows what it is doing can keep using `/api/coupons`, and gains nothing because nobody else can discover it.

---

## 2. Minting and redeeming on somebody else's POS

```
POS                        Relays              This service
 │  reads the npub's 30078   │                      │
 ├──────────────────────────►│                      │
 │◄── mintUrl, claimUrl ─────┤                      │
 │                                                  │
 │  POST mintUrl  (NIP-98, authorized npub)         │
 ├─────────────────────────────────────────────────►│
 │◄── coupon, name, npub, nonce, voucher ───────────┤
 │                                                  │
 │  checks voucher.pubkey === the `p` tag           │
 │  shows the QR with the nonce                     │
 │                                                  │
 │  POST claimUrl { nonce }                         │
 ├─────────────────────────────────────────────────►│
 │◄── status: success | claimed ────────────────────┤
```

The POS needs to know nothing about us beforehand: the announcement tells it where to knock, and the voucher tells it the response came from whoever the merchant named. See [Nostr events § how to verify it](./cupones-nostr.md#how-to-verify-it-without-calling-us).

---

## 3. Redeeming in this app's own storefront

The checkout does not need the announcement: it calls its own endpoints.

1. The shopper pastes the nonce in the cart (or arrives with `?coupon=<nonce>` from a minted QR — see the nonce-hygiene note in [API](./cupones-api.md#get-apicouponsclaimnonce)).
2. **`GET claim`** validates without consuming. It is checked that the coupon belongs to **this shop** — one deployment serves many merchants and the endpoint answers for any nonce it knows; without that check somebody could carry a 50%-off from one shop to another.
3. The discount is shown in the total. Nothing has been consumed yet.
4. On tapping **"Generar factura"**, the zap request is signed (locally, no network) and **`POST claim`** consumes the coupon *before* asking for the invoice, carrying the signed order with it. If somebody else used it in between, the shopper is told and it comes off the cart.
5. The coupon stays on the order as zap request tags: `["coupon", id, type, name]` and one `["discount", amount, currency]` per currency. The `total` tags stay **gross**: gross − discount = charged.

**If the total lands at zero**, the button reads **"Reclamar"** and there is no invoice, no payment and no receipt to wait for: the redemption happens anyway (with `amountMsat: 0`) and the order ends in the `claimed` state. That row is the order's only record, and it is what makes it show up in `/admin/orders` with the *Reclamada* badge and in the **Canjeados** tab of `/admin/coupons`. With no coupon applied the button stays disabled: there would be no nonce to file anything against.

If the shopper redeems and then abandons without paying, the coupon is burned. That is an accepted trade-off: redeeming before invoicing beats invoicing a discount that cannot then be charged. The merchant issues another.

Once the order is **paid**, it is cleared from `localStorage`. The receipt stays on screen for whoever paid, but the next person to open the checkout finds it empty instead of finding somebody else's receipt.

### The three states of an order with a coupon

What the merchant sees in `/admin` depends on what happened to the money:

| State | Where it comes from | What it shows |
|---|---|---|
| **Cobrada** | There is a zap receipt on the relays | The amount charged |
| **Reclamada** | `amount_msat = 0` on the redemption | "Sin cargo — cubierta por el cupón" |
| **Con cupón** | Redemption with an amount, no receipt yet | "A cobrar N sat — importe facturado al canjear" |

The third is not listed in `/admin/orders`: it belongs to the receipt that will arrive for it, and putting it there would post an order the merchant has not been paid for, and then post it twice.

---

## 4. Decisions worth not reverting without reading why

**About redemption**

- **`GET` validates and `POST` consumes.** If applying a coupon redeemed it, whoever pastes a code and closes the tab has lost it.
- **The redemption happens BEFORE asking for the invoice.** The other way round, two tills could honour the same nonce; this way the worst case is a burned coupon the merchant re-issues in two taps.
- **"Already redeemed" is `200`, not an error.** A POS that lost the response retries and still gets the terms and the original `claimedAt` back. That timestamp is a heuristic, not an idempotency key — it has one-second resolution and names no caller — so a till that needs certainty keeps its own record of the nonces it sent.
- **An invalid `zapRequest` does not cancel the redemption.** What is lost is the record, not the customer's coupon.

**About what a coupon promises**

- **The `benefit` is frozen at mint time.** The voucher was already signed over those terms: editing the coupon afterwards cannot change what one already sitting in somebody's phone promises.
- **Archiving stops minting, not redeeming.** The ones already handed out were a promise the merchant made. To cut those, use a past expiry date.
- **Voiding keeps the row.** Deleting it would make a till read "does not exist" instead of "it was cancelled".

**About the record of the sale**

- **The order is filed at redemption time, not later.** There is no orders table: a paid order is reconstructed from the zap receipt, and a reclaimed one has no receipt because nobody paid it. If `POST claim` does not carry it, it exists nowhere.
- **`amount_msat = 0` is what marks a reclaimed order.** It distinguishes "will never have a receipt" from "has not arrived yet", and without it the order book would show as charged a purchase the shopper abandoned.
- **The order's `total` tags are GROSS**, with the discount separate in `["coupon", …]` and `["discount", …]`. That way the order book reads like a receipt: items, less coupon, equals charged.

**About the arithmetic**

- **The order book attributes the discount to the line that got it**, even though the checkout charges one total. A free-beer coupon takes the price of one beer, not a slice of every item: spreading it proportionally leaves every product with revenue it never had. `discountByLine` does that split and `allocateOrderLineSats` weights by the net.
- **The discount scales every subtotal by the same factor** instead of subtracting from one currency. In a single-currency basket that is exact subtraction; in a mixed one it is the only thing that leaves the peso breakdown adding up to the sat total.
- **The cap clamps in its own currency.** Converting would need a rate table that layer does not take, and guessing at a number is worse than applying the ceiling where it was authored.
