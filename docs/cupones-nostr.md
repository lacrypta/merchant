# Nostr events

Two. One is signed by the merchant and published; the other is signed by this server and **never** published.

| Kind | Who signs it | Published | What for |
|---|---|---|---|
| `30078` | The merchant | Yes | Saying where the coupon service lives, and naming its key |
| `20402` | This server (manager) | No | Proving a coupon came from that service |

---

## Discovery announcement — kind `30078`

Signed by **the merchant, with their own key**. It is the only thing that lets somebody else's till find this service.

```jsonc
{
  "kind": 30078,                          // NIP-78 (app data)
  "pubkey": "2ad91f1dca2dcd5fc89e7208d1e5059f0bac0870d63fc3bac21c7a9388fa18fd",
  "created_at": 1762041600,
  "tags": [
    ["d", "lacrypta.merchant/coupons"],   // the `d` is the whole fence
    ["p", "9f5c4e2ab13d7f60c8a4e9021b6d5f38a7c04e91d2b8635fa0c7e41d9b6532af"],
    ["client", "merchant-manager"]
  ],
  "content": "{\"v\":2,\"mintUrl\":\"https://merchant.lacrypta.ar/api/coupons/mint\",\"claimUrl\":\"https://merchant.lacrypta.ar/api/coupons/claim\"}",
  "id": "…", "sig": "…"
}
```

The parsed `content`:

```json
{
  "v": 2,
  "mintUrl": "https://merchant.lacrypta.ar/api/coupons/mint",
  "claimUrl": "https://merchant.lacrypta.ar/api/coupons/claim"
}
```

**The announcement is half content and half tag.** `CouponDiscovery` in the domain layer carries all four fields together; only `couponDiscoveryEventBody` and `parseCouponDiscovery` know where each half lives on the wire.

| Where | Field | What it is |
|---|---|---|
| content | `v` | `2`. Any other version is **discarded**, never half-migrated |
| tag | `p` | Hex of the key that signs vouchers. They are verified against this |
| content | `mintUrl` | Absolute. POST, NIP-98, authorized npubs only |
| content | `claimUrl` | Absolute. GET to check, POST to redeem |

**Why the manager key is a tag and not a field.** A relay indexes tags; it cannot index a field inside a content string. With `p` on the outside, *"which merchants named this service?"* is a filter anybody can run — `{"kinds":[30078],"#d":["lacrypta.merchant/coupons"],"#p":["<manager>"]}` — instead of downloading every announcement in existence and parsing them one by one.

> **How to read it correctly, if you are writing a client.** Always fetch the **newest** by author + `d`, and only then look at the `p`. **Never subscribe filtering by `#p`**: the event is addressable, and asking for "the announcement that names me" can hand back an **older** version while the current one names somebody else. A POS reading that would believe it is still responsible for coupons that are no longer its own. The order matters: newest first, whose second.

**`v1` announcements are dead.** The previous version carried `managerPubkey` inside the `content` and had no `p` tag; half-parsing an announcement means sending a till to a URL whose meaning we guessed, so they are discarded whole. Every merchant has to **re-sign**: the dashboard asks for it on its own — "No pudimos leer el anuncio publicado (formato viejo, v1). Reactivalo para reemplazarlo" — and until they do, they can neither create coupons nor show the redemption box in their storefront.

**The `content` is plaintext.** Every other 30078 in this app is NIP-44 encrypted to the merchant themselves because it carries credentials; this one is the opposite: it is an announcement, and somebody else's POS has to be able to read it. There is nothing secret inside — the mint endpoint is protected by NIP-98 and a list of authorized npubs, not by the URL being hard to find.

The URLs must be `https`, with an exception for `localhost`/`127.0.0.1` so the whole flow can be exercised against `npm run dev` without a tunnel.

Kind 30078 is *addressable*, so **moving hosts is editing one event**, not a migration nobody can coordinate.

### Where it lives

On the relays **and** in our database (`coupon_discovery`, one row per merchant, the signed event as-is).

Relays are not storage we control: they drop events, they go away, and a read can miss one that is genuinely published. The local copy is what answers when the page loads; the relays are checked against it, and if one is missing the event is **re-broadcast on its own** — with no signature prompt, because the bytes are already signed.

On load, **each relay is asked separately** whether it has the event (one request per relay, filtering by id). The catalog's merged read is no good for this: "we have it" and "one out of five has it" look identical. The ones missing it get a publish **addressed only to them**, once per event per session.

---

## Voucher — kind `20402`

Signed by **this server** with `COUPON_MANAGER_NSEC`, and it travels in the JSON response of mint and claim. It is never published to a relay.

```jsonc
{
  "kind": 20402,
  "pubkey": "9f5c4e2ab13d7f60c8a4e9021b6d5f38a7c04e91d2b8635fa0c7e41d9b6532af",
  "created_at": 1762045200,
  "tags": [
    ["nonce", "hcLPDzERvvHzS4Vn0OLbAQ"],
    ["p", "2ad91f1dca2dcd5fc89e7208d1e5059f0bac0870d63fc3bac21c7a9388fa18fd"],
    ["coupon", "55b5ee4f-4dcc-4a6a-a58e-6d1d94d811a3"],
    ["phase", "claimed"],                 // or "minted"
    ["expiration", "1764633600"]          // NIP-40, only if it expires
  ],
  "content": "{…}",
  "id": "…", "sig": "…"
}
```

The parsed `content` (`VoucherPayload`):

```jsonc
{
  "v": 1,
  "nonce": "hcLPDzERvvHzS4Vn0OLbAQ",
  "owner": "2ad91f1dca2dcd5fc89e7208d1e5059f0bac0870d63fc3bac21c7a9388fa18fd",
  "name": "20% de verano",
  "description": "No acumulable.",
  "image": "https://blossom.example/9f3c.webp",  // absent when it has none
  "coupon": { "type": "percent", "percent": 20,
              "cap": { "amount": 5000, "currency": "ARS" } },
  "phase": "claimed",                            // "minted" | "claimed"
  "claimedAt": 1762045200,                       // only in the claimed phase
  "expiresAt": 1764633600                        // absent when it never expires
}
```

Optional keys are **omitted**, not sent as `null`. `parseVoucherContent` discards any `v` other than `1` rather than half-migrating it — the same rule as the cart.

**Why 20402:** it sits in the ephemeral range (20000–29999), so if it ever leaks to a relay, one that follows the spec relays it but does not store it — which is right for an event whose content carries a bearer nonce. It is free in the NIP registry, and it is the ephemeral mirror of 30402, the listing kind this app is built on.

**What it is for:** the API responses are JSON over HTTPS, which proves the coupon came from whoever holds the TLS certificate. The manager's signature proves it came from the service **the merchant named in their announcement**, which is what a cashier actually needs to know.

### How to verify it, without calling us

```js
import { verifyEvent } from "nostr-tools/pure"

// 1. Read the merchant's NEWEST 30078 (by author + `d`) → its `p` tag
const managerPubkey = announcement.tags.find((t) => t[0] === "p")?.[1]

// 2. The voucher has to come from that key
if (voucher.pubkey !== managerPubkey) throw new Error("different issuer")

// 3. Valid signature — re-deriving the id, not trusting library memos
if (!verifyEvent(voucher)) throw new Error("invalid signature")

// 4. The content has to say the same thing as the JSON response
const payload = JSON.parse(voucher.content)
if (payload.nonce !== response.nonce) throw new Error("different nonce")
if (payload.owner !== expectedOwnerHex) throw new Error("different merchant")
```

Step 3 matters more than it looks: `nostr-tools` marks events it has already verified with a symbol **that survives a spread**, so `{...event, tags: [...]}` drags a stale "already verified" flag onto a mutated object. Our `verifySignedEvent` rebuilds the seven canonical fields precisely to drop that memo.
