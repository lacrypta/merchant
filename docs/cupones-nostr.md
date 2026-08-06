# Eventos de nostr

Dos. Uno lo firma el comerciante y se publica; el otro lo firma este servidor y **nunca** se publica.

| Kind | Quién firma | Se publica | Para qué |
|---|---|---|---|
| `30078` | El comerciante | Sí | Decir dónde está el servicio de cupones |
| `20402` | Este servidor (manager) | No | Probar que un cupón salió de ese servicio |

---

## Anuncio de descubrimiento — kind `30078`

Lo firma **el comerciante con su propia clave**. Es lo único que hace que una caja ajena pueda encontrar este servicio.

```jsonc
{
  "kind": 30078,                          // NIP-78 (app data)
  "pubkey": "2ad91f1dca2dcd5fc89e7208d1e5059f0bac0870d63fc3bac21c7a9388fa18fd",
  "created_at": 1762041600,
  "tags": [
    ["d", "lacrypta.merchant/coupons"],   // el `d` es toda la cerca
    ["client", "merchant-manager"]
  ],
  "content": "{\"v\":1,\"managerPubkey\":\"9f5c…32af\",\"mintUrl\":\"https://merchant.lacrypta.ar/api/coupons/mint\",\"claimUrl\":\"https://merchant.lacrypta.ar/api/coupons/claim\"}",
  "id": "…", "sig": "…"
}
```

El `content` parseado:

```json
{
  "v": 1,
  "managerPubkey": "9f5c4e2ab13d7f60c8a4e9021b6d5f38a7c04e91d2b8635fa0c7e41d9b6532af",
  "mintUrl": "https://merchant.lacrypta.ar/api/coupons/mint",
  "claimUrl": "https://merchant.lacrypta.ar/api/coupons/claim"
}
```

| Campo | Qué es |
|---|---|
| `v` | `1`. Otra versión se **descarta**, nunca se migra a medias |
| `managerPubkey` | Hex de la clave que firma los vouchers. Contra esta se verifican |
| `mintUrl` | Absoluta. POST, NIP-98, sólo npubs autorizados |
| `claimUrl` | Absoluta. GET para consultar, POST para canjear |

**El `content` es texto plano.** Todos los demás 30078 de esta app van cifrados con NIP-44 hacia el propio comerciante porque llevan credenciales; este es lo contrario: es un anuncio, y un POS de otra persona tiene que poder leerlo. No hay nada secreto adentro — el endpoint de emisión está protegido por NIP-98 y una lista de npubs autorizados, no porque la URL sea difícil de encontrar.

Las URLs tienen que ser `https`, con la excepción de `localhost`/`127.0.0.1` para poder ejercitar el flujo completo contra `npm run dev` sin un túnel.

Kind 30078 es *addressable*, así que **mudarse de host es editar un evento**, no una migración que nadie puede coordinar.

### Dónde vive

En los relays **y** en nuestra base (`coupon_discovery`, una fila por comerciante, el evento firmado tal cual).

Los relays no son almacenamiento que controlemos: pierden eventos, se caen, y una lectura puede no traer uno que sí está publicado. La copia local es la que responde al cargar la página; los relays se verifican contra ella, y si falta se **reenvía solo** — sin pedir firma, porque los bytes ya están firmados.

Al cargar se le pregunta **a cada relay por separado** si tiene el evento (un pedido por relay, filtrando por id). La lectura mezclada del catálogo no sirve para esto: "lo tenemos" y "lo tiene uno de cinco" se ven igual. A los que les falta se les publica **sólo a ellos**, una vez por evento por sesión.

---

## Voucher — kind `20402`

Lo firma **este servidor** con `COUPON_MANAGER_NSEC`, y viaja en la respuesta JSON de emisión y canje. Nunca se publica a un relay.

```jsonc
{
  "kind": 20402,
  "pubkey": "9f5c4e2ab13d7f60c8a4e9021b6d5f38a7c04e91d2b8635fa0c7e41d9b6532af",
  "created_at": 1762045200,
  "tags": [
    ["nonce", "hcLPDzERvvHzS4Vn0OLbAQ"],
    ["p", "2ad91f1dca2dcd5fc89e7208d1e5059f0bac0870d63fc3bac21c7a9388fa18fd"],
    ["coupon", "55b5ee4f-4dcc-4a6a-a58e-6d1d94d811a3"],
    ["phase", "claimed"],                 // o "minted"
    ["expiration", "1764633600"]          // NIP-40, sólo si vence
  ],
  "content": "{…}",
  "id": "…", "sig": "…"
}
```

El `content` parseado (`VoucherPayload`):

```jsonc
{
  "v": 1,
  "nonce": "hcLPDzERvvHzS4Vn0OLbAQ",
  "owner": "2ad91f1dca2dcd5fc89e7208d1e5059f0bac0870d63fc3bac21c7a9388fa18fd",
  "name": "20% de verano",
  "description": "No acumulable.",
  "image": "https://blossom.example/9f3c.webp",  // ausente si no tiene
  "coupon": { "type": "percent", "percent": 20,
              "cap": { "amount": 5000, "currency": "ARS" } },
  "phase": "claimed",                            // "minted" | "claimed"
  "claimedAt": 1762045200,                       // sólo en fase claimed
  "expiresAt": 1764633600                        // ausente si no vence
}
```

Las claves opcionales se **omiten**, no se mandan como `null`. `parseVoucherContent` descarta cualquier `v` distinto de `1` en vez de migrarlo a medias — la misma regla que el carrito.

**Por qué 20402:** está en el rango efímero (20000–29999), así que si alguna vez se filtra a un relay, uno que cumpla la spec lo reenvía pero no lo guarda — lo correcto para un evento cuyo contenido lleva un nonce al portador. Está libre en el registro de NIPs, y es el espejo efímero de 30402, el kind de listing sobre el que está construida esta app.

**Para qué sirve:** las respuestas de la API son JSON sobre HTTPS, lo que prueba que el cupón vino de quien tenga el certificado TLS. La firma del manager prueba que vino del servicio que **el comerciante nombró en su anuncio**, que es lo que un cajero necesita saber.

### Cómo verificarlo, sin llamarnos

```js
import { verifyEvent } from "nostr-tools/pure"

// 1. Leer el anuncio 30078 del comerciante → managerPubkey
const discovery = JSON.parse(announcement.content)

// 2. El voucher tiene que venir de esa clave
if (voucher.pubkey !== discovery.managerPubkey) throw new Error("otro emisor")

// 3. Firma válida — re-derivando el id, sin confiar en memos de la librería
if (!verifyEvent(voucher)) throw new Error("firma inválida")

// 4. El contenido tiene que decir lo mismo que la respuesta JSON
const payload = JSON.parse(voucher.content)
if (payload.nonce !== respuesta.nonce) throw new Error("nonce distinto")
if (payload.owner !== esperadoOwnerHex) throw new Error("otro comercio")
```

El paso 3 importa más de lo que parece: `nostr-tools` marca los eventos que ya verificó con un símbolo **que se copia con el spread**, así que `{...evento, tags: [...]}` arrastra un "ya verificado" viejo sobre un objeto mutado. Nuestro `verifySignedEvent` reconstruye los siete campos canónicos justamente para tirar ese memo.
