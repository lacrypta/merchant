# API de cupones

Referencia completa: cada endpoint con su cuerpo, su respuesta y sus errores, y el esquema de cada tipo que devuelve.

Los ejemplos son reales — copiados de una corrida contra `npm run dev` — con los identificadores cambiados.

- [Convenciones](#convenciones)
- [Autenticación](#autenticación)
- [Tipos de retorno](#tipos-de-retorno)
- [Endpoints](#endpoints)
- [Catálogo de errores](#catálogo-de-errores)
- [Cliente de ejemplo](#cliente-de-ejemplo)

---

## Convenciones

**Base URL.** La del despliegue. En este documento, `https://merchant.lacrypta.ar`.

**CORS abierto en todas.** El preflight incluye `Authorization`, que no es un header safelisted y sin declararlo fallaría sólo para clientes cross-origin — es decir, sólo para los POS de terceros, que son justamente los que importan.

```http
Access-Control-Allow-Origin: *
Access-Control-Allow-Methods: <los de la ruta>, OPTIONS
Access-Control-Allow-Headers: Content-Type, Authorization
Access-Control-Max-Age: 86400
```

**`Cache-Control: no-store` en todas menos una.** El estado autenticado es por-llamador. La excepción es `GET /api/coupons/manager`, que es `public, max-age=300` porque la clave es estable durante la vida del despliegue.

**Errores.** Siempre JSON, siempre en castellano, siempre con la misma envoltura:

```json
{ "error": "No estás autorizado a emitir este cupón." }
```

Algunos agregan un campo:

| Campo extra | Cuándo | Para qué |
|---|---|---|
| `retryAfter` | `429` | Segundos hasta que la ventana se libera |
| `reason` | `401` | Máquina-legible: `expired`, `replay`, `url-mismatch`, `session-expired`, `session-invalid`, `malformed`, `missing`, `too-large` |

**Límites de tamaño.** Cuerpo: 16 KB (`413`). Header `Authorization`: 8 KB (`401` con `reason: "too-large"`). Un evento firmado en base64 pesa ~700 bytes, así que 8 KB es generoso y acotado.

**Rate limits.** Por IP, por proceso, ventana de 60 s. **No autorizan nada** — le suben el costo a quien insista, y no se comparten entre instancias.

| Bucket | Máx/min | Rutas |
|---|---|---|
| `auth-session` | 20 | `POST /api/auth/session` |
| `coupons-mgmt` | 60 | Todo lo de gestión: `/api/coupons`, `{id}`, `mints`, `minters`, `discovery`, `mintable`, `redemptions` |
| `coupon-mint` | 30 | `POST /api/coupons/mint` |
| `coupon-check` | 60 | `GET /api/coupons/claim` |
| `coupon-claim` | 30 | `POST /api/coupons/claim` |

`auth-session` tiene bucket propio a propósito: una página de cupones ocupada no puede agotarle el presupuesto al login, ni al revés.

**Precondiciones.** Sin `DATABASE_URL` toda ruta que toque la base responde `503`. Sin `COUPON_MANAGER_NSEC`, las que firman vouchers (`mint`, `POST claim`) responden `503`.

---

## Autenticación

Dos esquemas, **el mismo tenant**. Se despacha por el prefijo del header, nunca se prueba uno y se cae al otro: los dos leen el cuerpo, y un `Request` se consume una sola vez.

| Ruta | Auth |
|---|---|
| `POST /api/auth/session` | NIP-98 **solamente** |
| Toda la gestión, `mint` incluido | NIP-98 **o** Bearer |
| `GET`/`POST /api/coupons/claim` | Ninguna — el nonce es la credencial |
| `GET /api/coupons/manager` | Ninguna |

### NIP-98

Kind `27235` en `Authorization: Nostr <base64 del evento>`. Se verifica en este orden — barato primero, y la firma antes de confiar en cualquier tag:

1. Forma del evento
2. `kind === 27235`
3. **Firma válida**
4. `|ahora − created_at| ≤ 60s`
5. Tag `method` coincide
6. Tag `u` coincide con la URL externa (origen + path + query exactos)
7. Tag `payload` = sha256 hex del cuerpo, cuando hay cuerpo

```jsonc
{
  "kind": 27235,
  "created_at": 1764630000,
  "content": "",
  "tags": [
    ["u", "https://merchant.lacrypta.ar/api/coupons/mint"],
    ["method", "POST"],
    ["payload", "9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08"],
    ["nonce", "k3f9xq2"]                                    // ver abajo
  ],
  "pubkey": "…", "id": "…", "sig": "…"
}
```

Con `NEXT_PUBLIC_APP_URL` seteada, ese es el **único** origen aceptado y los `x-forwarded-*` se ignoran, así que falsificarlos no sirve para ampliar la audiencia del token.

Hay una caché de ids vistos en proceso (150 s) contra replay. Mismo alcance que el rate limit: sube el costo, no lo hace imposible, no se comparte entre instancias.

> **Si estás implementando un cliente:** el token tiene que llevar **algo que lo haga único**. Todo lo demás es determinístico y `created_at` tiene resolución de un segundo, así que dos emisiones del mismo cupón en el mismo segundo hashean al mismo id y la segunda se rechaza con `reason: "replay"`. Nuestro cliente agrega un tag `nonce` aleatorio; una caja que emite varios cupones por segundo tiene que hacer lo mismo.

### Bearer

Firmás un NIP-98 una vez, recibís un JWT y lo usás para todo lo demás: `Authorization: Bearer <token>`.

**No es una mejora de seguridad, es un intercambio.** NIP-98 ata cada token a un pubkey, una URL, un método, un hash de cuerpo, sesenta segundos y un solo uso. El bearer ata un pubkey y un vencimiento: robarlo da todo lo que ese pubkey puede hacer hasta que caduque. Lo que se compra a cambio es no pagar una firma por request, que en un bunker NIP-46 es un viaje al teléfono del comerciante por cada click.

- **12 horas**, un turno. El navegador lo guarda en `sessionStorage`, así que además muere al cerrar la pestaña.
- **Todas las rutas lo aceptan, emisión incluida.** Dejar `mint` sólo con NIP-98 no protegería nada: con el mismo bearer se llama a `POST /api/coupons/minters`, uno se agrega como emisor autorizado, y emite con su propia firma.
- **No hay logout.** El token no tiene estado del lado del servidor, así que no hay nada que revocar: salir es soltarlo. Para invalidar todo ya, rotá `SESSION_JWT_SECRET`.
- **Re-emitilo ante cualquier `401`.** Sin `SESSION_JWT_SECRET` la clave es aleatoria por proceso, así que un reinicio hace que los tokens vivos fallen como `session-invalid` y no como `session-expired`.

---

## Tipos de retorno

### `Benefit`

Lo que el cupón descuenta. Unión discriminada por `type`; los cinco aceptan `cap` opcional. La semántica está en [Descuentos](./cupones-descuentos.md).

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

Uno de cada uno:

```jsonc
{ "type": "percent", "percent": 10 }
{ "type": "percent", "percent": 20, "cap": { "amount": 5000, "currency": "ARS" } }
{ "type": "fixed", "amount": 500, "currency": "ARS" }
{ "type": "fixed", "amount": 1500, "currency": "SAT", "productDs": ["aab1c0de-7f2c-4b8e-9d31-2c5f6a8b1e40"] }
{ "type": "multibuy", "buyQty": 2, "payQty": 1, "productDs": ["b7e21d94-3a55-4c07-8f6b-9d0e4a1c2b38"] }
{ "type": "buyXgetY", "buyProductD": "b7e21d94-3a55-4c07-8f6b-9d0e4a1c2b38", "giftProductD": "aab1c0de-7f2c-4b8e-9d31-2c5f6a8b1e40" }
{ "type": "freeItems", "items": [{ "d": "aab1c0de-7f2c-4b8e-9d31-2c5f6a8b1e40", "qty": 2 }] }
```

Las claves ausentes son significativas: `productDs` ausente es **todos los productos**, `cap` ausente es **sin tope**. Nunca se mandan como `null`.

### `DefinitionJson`

Un cupón como lo ve la página de gestión. Lo devuelven `GET /api/coupons`, `POST /api/coupons` y `PATCH /api/coupons/{id}`.

```ts
interface DefinitionJson {
  id: string            // uuid
  name: string          // 1..80
  description: string   // "" cuando no tiene
  image: string | null  // https
  benefit: Benefit | null
  maxUses: number | null    // null ⇒ sin límite
  minted: number            // emisiones vigentes; anular una lo baja, y devuelve el lugar
  claimed: number           // canjeados
  expiresAt: number | null  // unix SEGUNDOS
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

> **`benefit: null` no es un error de la API, es un cupón roto.** Una definición cuyas columnas ya no parsean —una base editada a mano, una versión futura que escribió una forma que no conocemos— es una cosa real que puede pasar. Esconderla dejaría al comerciante con un cupón que no puede ver, editar ni borrar; mostrarla rota lo deja arreglarlo. `POST /api/coupons/mint` **no la emite**: responde `503`.

### `MintJson`

Una emisión. La devuelven `GET /api/coupons/{id}/mints` y `DELETE …/mints/{nonce}`.

```ts
interface MintJson {
  nonce: string     // 22 chars base64url — el token al portador
  status: "minted" | "claimed" | "voided"
  mintedBy: string      // hex de quien emitió
  mintedByNpub: string
  mintedAt: number      // unix segundos
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

Un npub autorizado a emitir.

```ts
interface MinterJson {
  pubkey: string        // hex, siempre minúscula
  npub: string
  label: string | null  // hasta 80 chars
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

Un canje, con la orden que pagó. Lo devuelve `GET /api/coupons/redemptions`.

```ts
interface RedemptionJson {
  nonce: string
  claimedAt: number
  couponId: string
  name: string
  benefit: Benefit | null   // el snapshot congelado al emitir
  order: SignedEvent | null // el kind-9734 firmado, verbatim
  orderId: string | null    // order.id, para indexar
  amountMsat: number | null // 0 ⇒ reclamada, nunca va a tener recibo
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

`order: null` es normal, no un error: un cupón escaneado en el mostrador nunca pasó por un checkout, y tampoco lo hizo nada canjeado antes de que la app archivara órdenes.

### `CouponPayloadJson`

Lo que se le entrega a quien tiene el cupón. Es la base de las respuestas de emisión y canje.

```ts
interface CouponPayloadJson {
  couponId: string
  coupon: Benefit    // el snapshot del MINT, no las columnas actuales
  name: string
  description: string
  npub: string       // el DUEÑO — contra este se chequea que el cupón sea de esta tienda
  image: string | null
  nonce: string
  expiresAt: number | null
}
```

### `SignedEvent`

Un evento de nostr, tal cual. Aparece como `voucher`, como `discovery` y como `order`.

```ts
interface SignedEvent {
  id: string; pubkey: string; created_at: number
  kind: number; tags: string[][]; content: string; sig: string
}
```

---

## Endpoints

### `POST /api/auth/session`

Cambia una firma NIP-98 por un bearer de 12 h. **Sin cuerpo** — el evento ya ata `u` y `method`, y hashear un cuerpo no defiende de ningún replay: quien puede repetir el header puede repetir los bytes.

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

`pubkey` y `expiresAt` vienen ecos para que **el cliente nunca decodifique el token**: apenas alguien lee un claim, alguien empieza a confiar en uno, y el browser no puede verificar la firma que lo haría verdad.

`200`, no `201`: después no existe ningún recurso direccionable.

| Error | Cuándo |
|---|---|
| `400` | Mandaste cuerpo |
| `401` + `reason` | NIP-98 inválido |
| `429` | 20/min |

---

### `GET /api/coupons`

Cupones + emisores + anuncio, en una sola llamada. **No es pereza:** cada request cuesta una firma, y en un bunker NIP-46 cada firma es un viaje al teléfono del comerciante. Dos endpoints serían dos toques para abrir una página.

```bash
curl https://merchant.lacrypta.ar/api/coupons -H "Authorization: Bearer $TOKEN"
```

```jsonc
{
  "coupons": [ /* DefinitionJson[], más nuevo primero, archivados incluidos */ ],
  "minters": [ /* MinterJson[] */ ],
  "discovery": { /* SignedEvent kind 30078 */ }   // null si nunca se activó
}
```

Los archivados vienen incluidos: el comerciante necesita ver que un cupón retirado todavía tiene 12 instancias sin canjear en la calle.

---

### `POST /api/coupons`

Crea una definición.

```jsonc
{
  "name": "20% de verano",                    // requerido, 1..80
  "description": "No acumulable.",            // opcional, hasta 500
  "image": "https://blossom.example/9f3c.webp", // opcional, https o null
  "benefit": { "type": "percent", "percent": 20,
               "cap": { "amount": 5000, "currency": "ARS" } },  // requerido
  "maxUses": 100,                             // opcional, null ⇒ sin límite
  "expiresAt": 1764633600                     // opcional, unix SEGUNDOS, futuro
}
```

**`201`** con `{ "coupon": DefinitionJson }`.

| Error | Mensaje |
|---|---|
| `400` | `Poné un nombre de hasta 80 caracteres.` |
| `400` | `La descripción puede tener hasta 500 caracteres.` |
| `400` | `La imagen tiene que ser una URL https.` |
| `400` | `El cupón no es válido: <razón>.` — la razón viene de `parseBenefit` |
| `400` | `El máximo de usos no es válido.` |
| `400` | `La fecha de vencimiento no es válida.` / `…ya pasó.` |

La imagen se valida como en `woo-config.ts`, y por el mismo motivo: esa string termina en el `<img src>` de otra persona. https, sin credenciales embebidas, con hostname real.

**En `POST` la fecha tiene que ser futura; en `PATCH` no.** Una fecha pasada es el matainterruptor de los cupones ya emitidos, y sólo tiene sentido sobre un cupón que existe.

---

### `PATCH /api/coupons/{id}`

Edita. Todos los campos son opcionales; sólo se toca lo que mandás. Un cuerpo vacío es `400` (`No hay nada para cambiar.`).

```jsonc
{
  "name": "20% de verano",
  "description": "…",
  "image": null,              // null borra la imagen
  "benefit": { … },
  "maxUses": null,            // null quita el límite
  "expiresAt": 1735689600,    // una fecha PASADA mata los que están en la calle
  "archived": true            // frena las emisiones nuevas, no los canjes
}
```

`200` con `{ "coupon": DefinitionJson }`, con los contadores re-leídos para que la fila del cliente quede completa y no a medio refrescar.

| Error | Cuándo |
|---|---|
| `404` | No existe **o es de otro** — a un desconocido probando UUIDs se le contesta lo mismo en los dos casos |
| `400` | Igual que `POST`, más `No hay nada para cambiar.` |

Bajar `maxUses` por debajo de lo ya emitido **está permitido**: frena las emisiones nuevas sin tocar los cupones ya entregados.

> Editar la definición **no cambia** lo que promete un cupón ya emitido. El voucher se firmó sobre el snapshot congelado en `coupon_mints.benefit`.

---

### `DELETE /api/coupons/{id}`

Borra si nunca se emitió; si no, archiva. Una definición con cupones en circulación no se puede borrar: los nonces en los teléfonos apuntan a ella y todavía se les debe algo.

```json
{ "deleted": false, "archived": true }
```

---

### `GET /api/coupons/{id}/mints`

Las emisiones de un cupón, más nueva primero.

```json
{ "mints": [ /* MintJson[] */ ] }
```

Endpoint aparte de `GET /api/coupons` a propósito: la lista de definiciones es con lo que abre la página y es chica; esto puede ser cientos de filas para un cupón que se repartió todo el mes, así que carga cuando el comerciante realmente lo pide.

---

### `DELETE /api/coupons/{id}/mints/{nonce}`

Anula una emisión que nunca se canjeó. `200` con `{ "mint": MintJson }` — la fila vuelve con `status: "voided"`.

| Error | Cuándo |
|---|---|
| `404` | No existe esa emisión, o el cupón es de otro |
| `409` | `Ese cupón ya fue canjeado, no se puede anular.` |
| `409` | `Ese cupón ya estaba anulado.` |

Está anidado bajo la definición para que la propiedad venga del path: el nonce solo es un token al portador, y un endpoint que actuara sobre él sin chequear de quién es el cupón dejaría a cualquiera anular emisiones ajenas.

**La fila sobrevive.** Una caja que escanea un QR anulado tiene que enterarse de que fue anulado; una fila borrada sólo podría contestar "no existe", que manda al cajero a buscar un error de tipeo que no existe.

**Devuelve el lugar al máximo.** Quien se equivoca y toca "Emitir" en un cupón de un solo uso tendría que ir a editar el cupón para poder reemitirlo, y "esta emisión nunca pasó" es exactamente lo que significa anular.

---

### `GET /api/coupons/redemptions`

Todos los canjes del comerciante, con la orden que pagó cada uno. Más nuevo primero, **tope de 500**.

```json
{ "redemptions": [ /* RedemptionJson[] */ ] }
```

Es lo más parecido a una tabla de órdenes que hay en la app. Una compra pagada se sigue reconstruyendo de su zap receipt en los relays — pero una que un cupón dejó en cero nunca se factura, nunca se recibe y no existiría en ningún lado. La fila escrita al canjear es su único registro.

Endpoint propio y no un campo de `GET /api/coupons`: esa respuesta es con lo que abre la página, y colgarle un evento firmado por canje la haría crecer con las ventas del comercio.

---

### `POST /api/coupons/mint`

**Emitir.** Es la `mintUrl` del anuncio. Dos puertas: firma válida, y que quien firma sea el dueño o esté en la lista de emisores.

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
  "voucher":     { /* SignedEvent kind 20402, fase "minted" */ }
}
```

| Error | Cuándo |
|---|---|
| `400` | `Falta el cupón.` — `couponId` no es un uuid |
| `403` | `No estás autorizado a emitir este cupón.` |
| `404` | No existe |
| `409` | `Se agotaron los cupones disponibles.` |
| `410` | `El cupón fue archivado.` / `El cupón está vencido.` |
| `503` | Sin base, sin manager, o la definición no parsea |

**El nonce son 16 bytes al azar en base64url (22 caracteres):** imposible de adivinar y entra en cualquier QR. **Es un token al portador** — quien lo tiene puede canjear. Existe sólo en esta respuesta y en la base, no se loguea, y la respuesta no se cachea.

El cap de emisiones se sostiene con el `UPDATE … WHERE minted_count < max_uses` que incrementa el contador. Contar filas en `coupon_mints` sería una carrera.

---

### `GET /api/coupons/claim?nonce=…`

**Consulta sin consumir.** Es la mitad de la `claimUrl`. Nuestra propia tienda la llama apenas alguien pega un código, para mostrar el descuento antes de gastar nada.

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

**Siempre `200` para un nonce que conocemos**, con el motivo en `status`. Es un endpoint de previsualización: un error HTTP haría que "ya usado" y "vencido" se vean igual que una falla de red, y el cajero no sabría cuál de las tres cosas pasó.

`voided` le gana a `expired`: que el comerciante haya anulado una emisión es una decisión, y decir "vencido" lo mandaría a cambiar una fecha que no tiene nada que ver.

| Error | Cuándo |
|---|---|
| `400` | `Falta el cupón.` — sin `nonce` o con formato inválido |
| `404` | `Cupón inexistente.` |

> **Un despliegue sirve a muchos comercios**, y este endpoint contesta por cualquier nonce que conozca — tiene que hacerlo, porque un POS validando no tiene contexto de tienda. Si sos una tienda, **chequeá `npub` contra el comercio que estás cobrando**; sin eso, alguien lleva un 50% de un local a otro.

---

### `POST /api/coupons/claim`

**Canjea.** Consume el nonce, una sola vez.

```jsonc
{
  "nonce": "hcLPDzERvvHzS4Vn0OLbAQ",   // requerido
  "zapRequest": { /* kind 9734 firmado */ },  // opcional
  "amountMsat": 0                             // opcional, entero ≥ 0
}
```

`zapRequest` y `amountMsat` describen **qué se está comprando** y se guardan en la fila del canje. Son el único registro que existe de un pedido reclamado, y lo que hace que la venta aparezca en `/admin/orders`. `amountMsat: 0` es lo que marca "reclamada": distingue *nunca va a tener recibo* de *todavía no llegó*.

Para archivarse, el evento tiene que: verificar su firma, ser `kind 9734`, traer un tag `coupon` y pesar menos de 8000 caracteres. Si no cumple, **el canje se hace igual** y se pierde nada más que el registro: negarle el cupón a alguien parado en el mostrador porque no pudimos archivar el papeleo es el peor resultado posible.

```jsonc
{
  "status": "success",         // o "claimed"
  "claimedAt": 1762045200,
  "couponId": "…", "coupon": { … }, "name": "…", "description": "…",
  "npub": "…", "image": null, "nonce": "…", "expiresAt": null,
  "voucher": { /* SignedEvent kind 20402, fase "claimed" */ }
}
```

| Status | Significa |
|---|---|
| `200` `success` | Recién canjeado |
| `200` `claimed` | Ya estaba canjeado, con el `claimedAt` **original** |

**Que "ya canjeado" sea `200` y no un error es a propósito:** un POS que perdió la respuesta reintenta, y comparando `claimedAt` con su propio reloj sabe si el canje fue suyo. Un error colapsaría "lo canjeé yo" y "me ganaron de mano" en "el request falló".

| Error | Cuándo |
|---|---|
| `400` | `Falta el cupón.` / `Cuerpo inválido.` |
| `404` | `Cupón inexistente.` |
| `410` | `El cupón fue anulado.` / `El cupón está vencido.` |

La concurrencia la decide la base, no este proceso:

```sql
UPDATE coupon_mints SET status='claimed', claimed_at=now(),
       order_event = $2, order_id = $3, amount_msat = $4
 WHERE nonce = $1 AND status = 'minted' AND EXISTS (… no vencido …)
RETURNING *;
```

Dos cajas escaneando el mismo QR en el mismo instante producen un UPDATE que devuelve fila y otro que no; el segundo se reporta como ya canjeado. Un read-then-write sería una carrera con plata del otro lado.

**La orden viaja en ese mismo UPDATE**: una fila no puede quedar canjeada sin la orden que la canjeó, y el segundo llamador —que por definición perdió la carrera— no puede pisar la orden del primero con la suya.

---

### `GET /api/coupons/mintable`

Qué puede emitir el npub que pregunta, de todos los comerciantes que lo autorizaron. Es con lo que un POS dibuja sus botones.

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
      "remaining": 88,        // null ⇒ sin límite
      "expiresAt": 1764633600
    }
  ]
}
```

Los archivados, vencidos y agotados se filtran **del lado del servidor**: una terminal que muestra una opción que siempre falla es peor que una que no la muestra. Los que no parsean también se omiten — de una definición cuyos términos no podemos enunciar no se puede ofrecer nada.

---

### `GET` / `POST /api/coupons/minters`, `DELETE /api/coupons/minters/{pubkey}`

Los npubs autorizados a emitir: el teléfono de un cajero, una segunda terminal, un local socio con su propio POS.

`GET` → `{ "minters": MinterJson[] }`. Existe por simetría y para un POS que quiera mostrar la lista; la página de gestión los recibe en `GET /api/coupons`, en el mismo viaje.

`POST` acepta **npub, nprofile, hex o una dirección NIP-05**:

```json
{ "pubkey": "caja2@lacrypta.ar", "label": "Caja 2" }
```

**`201`** con `{ "minter": MinterJson }`. Sólo se guarda el hex: la dirección se resuelve una vez, acá, y nunca se sigue después.

| Error | Cuándo |
|---|---|
| `400` | `Ya podés emitir tus propios cupones.` — el dueño no es fila de su propia lista |
| `400` / `404` | La clave o la dirección no resuelven |

`DELETE /api/coupons/minters/{pubkey}` (npub o hex, url-encoded) → `{ "removed": true }`, o `404` si no estaba.

**Revocar no toca lo ya emitido.** Esos cupones se entregaron a clientes que no tuvieron nada que ver; revocar frena las emisiones nuevas, que es lo que significa "sacar a este empleado".

---

### `PUT /api/coupons/discovery`

Guarda el anuncio 30078 que el comerciante firmó.

```json
{ "event": { "kind": 30078, "…": "…" } }
```

`200` con `{ "event": SignedEvent }`.

**Guardamos el evento, no lo acuñamos.** La firma es del comerciante y este servicio no podría falsificarla; todo lo que hace este endpoint es recordar lo que ya firmaron, para poder re-publicarlo después sin volver a pedírselo.

Se valida todo porque el llamador controla todo, y una fila mala acá se re-publicaría a los relays a nombre del comerciante:

| Error | Cuándo |
|---|---|
| `400` | `Cuerpo inválido.` — forma del evento |
| `400` | `Ese evento no es tu anuncio de cupones.` — `d` o `pubkey` no coinciden |
| `400` | `El evento no tiene una fecha válida.` |
| `400` | `La firma del evento no es válida.` |
| `400` | `El anuncio no se puede leer: <razón>.` |

Leerlo de vuelta **no está acá**: viaja con `GET /api/coupons`, así que la página cuesta una firma en vez de dos.

---

### `GET /api/coupons/manager`

El pubkey que firma los vouchers. Sin auth — es información pública y un POS la necesita para verificar.

```json
{
  "pubkey": "9f5c4e2ab13d7f60c8a4e9021b6d5f38a7c04e91d2b8635fa0c7e41d9b6532af",
  "npub": "npub1na3388t8384asezn5sgxmd403c47qya36jhp3lgx8usa8dk2v40qx6emh9"
}
```

Única ruta cacheable: `public, max-age=300`. La clave es estable durante la vida del despliegue; el TTL corto es sólo para que setear la variable por primera vez se note pronto.

`503` si el servidor no tiene `COUPON_MANAGER_NSEC`.

---

## Catálogo de errores

| Código | Significa | Qué hacer |
|---|---|---|
| `400` | Cuerpo o parámetro inválido | Arreglar el pedido. El mensaje dice qué |
| `401` | Auth inválida (ver `reason`) | Re-firmar. Con `session-*`, re-emitir la sesión |
| `403` | Autenticado pero sin permiso para emitir | Pedirle al dueño que te autorice |
| `404` | No existe **o es de otro** | No reintentar |
| `409` | Conflicto de estado: agotado, ya canjeado, ya anulado | No reintentar |
| `410` | Terminal: vencido o archivado | No reintentar |
| `413` | Cuerpo > 16 KB | No es nuestro caso de uso |
| `429` | Rate limit | Esperar `retryAfter` segundos |
| `503` | Sin base, sin manager, o error de la base | Reintentar con backoff |

`404` para "es de otro" es deliberado: a un desconocido probando UUIDs, "no existe" y "no es tuyo" tienen que verse igual.

---

## Cliente de ejemplo

Node ≥ 20, con `nostr-tools`. Emite un cupón y lo canjea, firmando NIP-98 a mano.

```js
import { finalizeEvent, generateSecretKey } from "nostr-tools/pure"
import { sha256 } from "@noble/hashes/sha2.js"
import { bytesToHex, utf8ToBytes } from "@noble/hashes/utils.js"

const BASE = "https://merchant.lacrypta.ar"
const sk = /* tu clave secreta, 32 bytes */

function nip98(url, method, body) {
  const tags = [
    ["u", url],
    ["method", method],
    // Sin esto, dos pedidos idénticos en el mismo segundo hashean al mismo
    // id y el segundo se rechaza con reason: "replay".
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

// 1. Crear una definición.
const { coupon } = await call("/api/coupons", "POST", {
  name: "20% de verano",
  description: "No acumulable.",
  image: null,
  benefit: { type: "percent", percent: 20, cap: { amount: 5000, currency: "ARS" } },
  maxUses: 100,
  expiresAt: null,
})

// 2. Emitir una instancia. El nonce es lo que va al QR.
const minted = await call("/api/coupons/mint", "POST", { couponId: coupon.id })
console.log(minted.nonce, minted.voucher.pubkey)

// 3. Consultar sin consumir — sin auth.
const check = await (await fetch(`${BASE}/api/coupons/claim?nonce=${minted.nonce}`)).json()
console.log(check.status)        // "minted"

// 4. Canjear. Sin auth: el nonce ES la credencial.
const claimed = await (
  await fetch(`${BASE}/api/coupons/claim`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ nonce: minted.nonce }),
  })
).json()
console.log(claimed.status)      // "success"
```

Para cambiar la firma por una sesión, reemplazá el header de `call`:

```js
const { token } = await call("/api/auth/session", "POST")
// después: headers: { authorization: `Bearer ${token}` }
```
