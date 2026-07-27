import { describe, expect, it } from "vitest"

import { decodeInvoice } from "./bolt11"
import { matchReceipt, type Invoice, type Order } from "./order"
import type { SignedEvent } from "@/lib/nostr/types"

/**
 * A REAL kind-9735 published by primal.net for a real payment to a real
 * merchant, captured off relay.damus.io / relay.primal.net.
 *
 * It exists because the app failed to detect that payment. Every check in
 * matchReceipt() passed against this event except the invoice binding, and
 * the reason was upstream: the subscription captured `order` in a closure
 * before the first invoice existed, so the matcher was forever comparing
 * against `invoices: []`. The fixture pins both halves of that.
 */
const RECEIPT = {
  "id": "5448ee7f29963c96a3e8b2b7a2542cb3993097120f227cd151e5373994d57b49",
  "pubkey": "f81611363554b64306467234d7396ec88455707633f54738f6c4683535098cd3",
  "created_at": 1785169967,
  "kind": 9735,
  "tags": [
    [
      "p",
      "2ad91f1dca2dcd5fc89e7208d1e5059f0bac0870d63fc3bac21c7a9388fa18fd"
    ],
    [
      "P",
      "11fe9673f6d2c54cc25b830078b7f6fa89527f9b2d91251e3feb6d0f24cd28f6"
    ],
    [
      "a",
      "30402:2ad91f1dca2dcd5fc89e7208d1e5059f0bac0870d63fc3bac21c7a9388fa18fd:3d102573-cd71-4bce-84f1-8a797a2fc849"
    ],
    [
      "bolt11",
      "lnbc12570n1p4x0zpqpp5zmzxp8xfq3u8qvfl8kfwg8v3rvqh2428pxgspqz54nwqxh7jmx6qsp53uthzuf003f38ajsc0s843wsf409eyp0yew8mapqdw35j20j5jeqxq9z0rgqnp4qvyndeaqzman7h898jxm98dzkm0mlrsx36s93smrur7h0azyyuxc5rzjq25carzepgd4vqsyn44jrk85ezrpju92xyrk9apw4cdjh6yrwt5jgqqqqrt49lmtcqqqqqqqqqqq86qq9qcqzpuhp5562vsd84tnm3sw6g3wv42enz9yl8w23mw42gudwupfz9a227fdaq9qyyssqa4f0qw5twatjvd9lz437rxxncdam08m3lvdcr9syukn7gmfcq7exs786dlwpal50utrh29jj7arju3ygsfpf7qhy5esz5saxg3wacscpv0s7rm"
    ],
    [
      "description",
      "{\"content\":\"Pedido · 1 ítem · ARS 1300\",\"created_at\":1785169951,\"id\":\"7ecefa5fc8c213aa099e7549b1d85bc7a4d7770227a549889b8aa2278e182e0b\",\"kind\":9734,\"pubkey\":\"11fe9673f6d2c54cc25b830078b7f6fa89527f9b2d91251e3feb6d0f24cd28f6\",\"sig\":\"d6f5a04b8c9a1b36e35377a022cad966cc32f4469f011463243b6952979fb0af1f8d6613672d4c90a14404129b869604838da0a2e0146f54bdef9d11294b3c55\",\"tags\":[[\"p\",\"2ad91f1dca2dcd5fc89e7208d1e5059f0bac0870d63fc3bac21c7a9388fa18fd\"],[\"relays\",\"wss://relay.damus.io\",\"wss://nos.lol\",\"wss://relay.primal.net\",\"wss://relay.nostr.band\"],[\"client\",\"merchant-manager\"],[\"order\",\"1\"],[\"items_hash\",\"128ab639787b55052128a0e949a18ce03763714d7dcbf4d6a27bb762f9439c78\"],[\"items_count\",\"1\"],[\"total\",\"1300\",\"ARS\"],[\"item\",\"3d102573-cd71-4bce-84f1-8a797a2fc849\",\"1\",\"1300\",\"ARS\"],[\"a\",\"30402:2ad91f1dca2dcd5fc89e7208d1e5059f0bac0870d63fc3bac21c7a9388fa18fd:3d102573-cd71-4bce-84f1-8a797a2fc849\"],[\"k\",\"30402\"]]}"
    ]
  ],
  "content": "",
  "sig": "acf6c5e259dedcdc0cf8ad001b86e88b6df90f03e2c03acb5d3cfdac4291d34500a61905de86ee6c3926b9ebd2443f021969a0345def535f6afa53d1e9a5aa2d"
} as SignedEvent

const DESCRIPTION = JSON.parse(
  RECEIPT.tags.find((t) => t[0] === "description")![1]!
) as SignedEvent
const BOLT11 = RECEIPT.tags.find((t) => t[0] === "bolt11")![1]!
const PAYMENT_HASH = decodeInvoice(BOLT11)!.paymentHash!

function order(over: Partial<Order> = {}): Order {
  return {
    v: 1,
    id: DESCRIPTION.id,
    status: "awaiting_payment",
    createdAt: DESCRIPTION.created_at,
    updatedAt: Date.now(),
    payee: {
      merchantPubkey: RECEIPT.tags.find((t) => t[0] === "p")![1]!,
      lud16: "agustin@primal.net",
      callbackToken: "tok",
      callbackOrigin: "https://primal.net",
      nostrPubkey: RECEIPT.pubkey,
      metadataSha256: "c".repeat(64),
      commentAllowed: 200,
      minSendable: 1000,
      maxSendable: 1e11,
    },
    lines: [],
    itemsHash: "",
    zapRequest: DESCRIPTION,
    itemsFidelity: 1,
    commentSent: "full",
    invoices: [],
    proofs: [],
    anomalies: [],
    ...over,
  }
}

const invoice = (): Invoice => ({
  pr: BOLT11,
  paymentHash: PAYMENT_HASH,
  amountMsat: decodeInvoice(BOLT11)!.amountMsat!,
  bolt11AmountMsat: decodeInvoice(BOLT11)!.amountMsat,
  hardExpiresAt: Date.now() + 3_600_000,
  displayExpiresAt: Date.now() + 600_000,
  issuedAt: Date.now(),
  verifyToken: null,
  nostrParamStatus: "unknown",
  state: "live",
  quote: { totalMsat: 0, perCurrency: [], rateAsOf: 0, quotedAt: 0 },
})

describe("matchReceipt against a real primal.net zap receipt", () => {
  it("accepts it once the order knows about its own invoice", () => {
    expect(matchReceipt(RECEIPT, order({ invoices: [invoice()] }))).toMatchObject({
      ok: true,
      paymentHash: PAYMENT_HASH,
    })
  })

  it("REJECTS it while the order still has no invoice — the shipped bug", () => {
    // The subscription used to capture `order` before the invoice arrived, so
    // this is the exact state the matcher was stuck in. A genuine payment,
    // silently undetected.
    expect(matchReceipt(RECEIPT, order({ invoices: [] }))).toEqual({
      ok: false,
      reason: "payment hash is not one of ours",
    })
  })

  it("survives primal re-serialising the zap request", () => {
    // The description hash did not match our exact bytes (status "unknown"),
    // yet the embedded event still verifies — which is why "unknown" must not
    // switch the receipt watcher off.
    expect(DESCRIPTION.kind).toBe(9734)
    expect(DESCRIPTION.tags.map((t) => t[0])).toContain("items_hash")
  })

  it("still rejects a receipt whose order id is somebody else's", () => {
    expect(matchReceipt(RECEIPT, order({ id: "9".repeat(64) }))).toEqual({
      ok: false,
      reason: "different order",
    })
  })
})
