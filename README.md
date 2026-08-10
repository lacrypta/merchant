# Merchant Manager

A dashboard for a merchant to manage their catalog and publish it on **nostr**, signed with their own key. Any point of sale reads it live.

Built by [La Crypta](https://lacrypta.ar).

## The problem it solves

Today La Crypta's catalog is **a JSON file copied by hand across three repos**:

- `lawalletio/mobile-pos` (LaPOS, the POS used at events) has it hardcoded in `src/constants/menus/*.json`
- `lawalletio/flutter-pos` mirrors the same schema in `assets/menus/`
- `lacrypta/menu-lacrypta` holds a third copy, and its README documents the procedure: *"If the menu changes in `mobile-pos`, copy those files into `data/` again"*

Here the catalog becomes **the merchant's data, portable, on nostr** — not a file in somebody's git.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 · shadcn/ui · applesauce + nostr-tools

Requires **Node 22** (see `.nvmrc`): below that version the global `WebSocket` is not stable and the server-side relay reader will not start.

```bash
nvm use
npm install
npm run dev
```

### Environment variables

All optional: with none of them, the catalog and the storefront work the same. They go in `.env.local`.

| Variable | What for |
|---|---|
| `DATABASE_URL` | Postgres, **only** for coupons. Without it, `/api/coupons/*` answers 503 and the rest of the app runs fine. The direct connection. When both are set, the app **and** the migrations use `DATABASE_POOL_URL`. |
| `DATABASE_POOL_URL` | The pooler for the same Postgres, if the provider offers one. The app prefers it for queries: on serverless every instance opens its own pool, and against the direct connection that exhausts the limit (or never connects at all — on Supabase the direct host is IPv6-only). |
| `COUPON_MANAGER_NSEC` | This service's nostr identity: it signs the coupons it issues. Without it, nothing can be minted or redeemed. |
| `NEXT_PUBLIC_APP_URL` | The public origin. In production **set it**: it is the only thing that makes NIP-98 validation ignore the `x-forwarded-*` headers, which anyone can forge. |
| `SESSION_JWT_SECRET` | Signs the session JWTs, so the merchant signs with nostr once per shift instead of once per click. Without it a per-process key is used: acceptable on a single instance, **must be set with more than one** or tokens minted by one are rejected by the other. |
| `LN_PROXY_SECRET` | Signs the LNURL proxy tokens. Without it a per-process key is used and in-flight payments break on every deploy. |

## How it is modeled on nostr

| Kind | Use |
|---|---|
| `30402` | Published product ([NIP-99](https://github.com/nostr-protocol/nips/blob/master/99.md)) |
| `30403` | Tombstone when a product is deleted. **There are no drafts**: everything published is a live 30402. |
| `30405` | Category ([GammaMarkets](https://github.com/GammaMarkets/market-spec/blob/main/spec.md), the e-commerce extension NIP-99 itself links to) |
| `5` | Deletion (NIP-09) |
| `0` · `10002` · `10063` | Profile · NIP-65 relays · Blossom servers |
| `30078` | App data (NIP-78): WooCommerce config (encrypted) and coupon endpoints (in the clear, with the service's key in an indexable `p` tag) |
| `27235` | HTTP auth (NIP-98). Signed once per session, then a JWT takes over |
| `20402` | Coupon signed by this service. Never published: it travels in the HTTP response. |

Decisions that are not obvious and should not be reverted without reading why:

- **`d` is a uuid**, never derived from the title. Shopstr uses `sha256(name)` and renaming orphans the listing.
- **`t` decides membership**, `a` only orders within the category. That way a lost collection costs ordering, never membership.
- **`created_at` is strictly increasing per address.** NIP-01 breaks ties by lowest id, and calls it a convention that "implementations may vary" — two saves in the same second can drop your edit without a word.
- **On delete, the kind 5 goes first and the tombstone after**, at `t+1`. NIP-09 deletes everything up to *and including* the kind 5's `created_at`, so the intuitive order eats the tombstone.
- **Writes go to a background queue.** A NIP-46 round trip takes 3–15s; blocking the UI would make loading five products mean staring at a screen for five minutes. They are signed one at a time: several remote signers drop a concurrent `signEvent`.
- **`purplepag.es` is read-only.** It rejects products with `blocked: kind 30402 is not allowed`, and leaving it writable would make every publish look partial.

## Coupons

Five types: **percentage**, **fixed amount** (ARS/USD/SAT), **NxM** (2-for-1, 3-for-2…), **buy A, get B free**, and **free product** (the products and quantities you choose, with nothing to buy in return). The first three can be narrowed to specific products; with no products chosen they apply to the whole basket. Any of the five accepts an optional **discount cap** — "20% off, up to ARS 5,000".

The merchant **activates the service** by signing a kind-30078 that says where to mint and where to redeem, and names the voucher-signing key in a `p` tag. That event is the only thing that lets somebody else's till find this server, and until it exists no coupons can be created.

It is the only part of the app with a database, and the reason is short: *"has this coupon been used?"* has to have exactly one answer at the instant two tills ask it, and relays are eventually-consistent by design.

📄 **Full documentation** — [`docs/cupones.md`](docs/cupones.md) is the front page, and from there:

| | |
|---|---|
| [Discounts](docs/cupones-descuentos.md) | The five types, product scope, the cap and the arithmetic |
| [API](docs/cupones-api.md) | Every endpoint with its body, its response and its errors, plus the schema of every return type |
| [Nostr events](docs/cupones-nostr.md) | The announcement (30078) and the voucher (20402), and how to verify them |
| [Flows](docs/cupones-flujos.md) | End to end, and the decisions worth not reverting |
| [Data](docs/cupones-datos.md) | The four tables and what each column guarantees |

```bash
docker run -d --name merchant-pg -p 55432:5432 \
  -e POSTGRES_USER=merchant -e POSTGRES_PASSWORD=merchant -e POSTGRES_DB=merchant \
  postgres:17-alpine
```

```bash
DATABASE_URL=postgres://merchant:merchant@localhost:55432/merchant
COUPON_MANAGER_NSEC=nsec1…       # the identity that signs the vouchers
NEXT_PUBLIC_APP_URL=http://localhost:4321
SESSION_JWT_SECRET=…             # optional on a single instance
```

```bash
npm run db:generate   # after touching the schema
npm run db:migrate    # by hand; the deploy already does it
```

`npm run build` runs the migrations before compiling **if `DATABASE_URL` or `DATABASE_POOL_URL` is set**, and
fails the build if they do not apply: a deploy against an old schema breaks more quietly.
With neither, nothing migrates and it compiles all the same.

Without those variables the app still starts and the coupon endpoints answer `503`: having no database is a supported state.

## POS interoperability

`GET /api/pos/[handle]/{products,categories}` emits exactly the shape LaPOS consumes.

**It is not drop-in**: `mobile-pos` has to be touched. `categories.json` is a static import and the menus are a dynamic import with a template literal — two different changes.

## Status

The site is two halves: **`/admin/*` is the private dashboard** — everything behind the login — and the rest is public (`/` and the storefront at `/s/<npub or nip05>`).

Working: login (NIP-07 · bunker · QR), catalog with nested categories and products, create/edit/delete, NIP-65 relay settings with suggestions, public storefront, nostr avatars and NIP-05 verification.

Missing: image upload with cropping to Blossom (today you paste a URL), domain tests, and the ARS/USD/SAT rates endpoint.

## License

MIT. The Standerd typeface comes from [`lacrypta/branding`](https://github.com/lacrypta/branding) (MIT, © Peronio.AR).
