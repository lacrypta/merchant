# Cupones

Cómo funciona el sistema de cupones: qué descuenta cada tipo, qué eventos de nostr se firman, qué endpoints existen y cómo se encadena todo.

El resumen para quien viene de afuera: **este servidor emite y canjea cupones a nombre de un comerciante, y el comerciante lo autoriza firmando un evento de nostr que dice dónde está el servicio.** Cualquier punto de venta que lea ese evento puede emitir y canjear sin haber hablado nunca con nosotros.

---

## 1. Por qué hay una base de datos

Es la única parte de la app con Postgres. El resto vive en relays y en `localStorage`, y eso es deliberado.

El motivo es corto: *"¿este cupón ya se usó?"* tiene que tener **una sola respuesta** en el instante en que dos cajas la preguntan. Los relays son consistentes-eventualmente por diseño — perfecto para un catálogo, inservible para decidir quién se queda con el único descuento que quedaba.

Todo lo que necesita esa garantía está en Postgres. Todo lo que necesita ser descubierto por terceros está en nostr.

---

## 2. Tipos de descuento

Cinco, como unión discriminada (`Benefit` en [`src/lib/domain/coupon.ts`](../src/lib/domain/coupon.ts)):

| Tipo | Forma | Ejemplo |
|---|---|---|
| `percent` | `{ type, percent, productDs? }` | 10% de descuento |
| `fixed` | `{ type, amount, currency, productDs? }` | ARS 500 menos |
| `multibuy` | `{ type, buyQty, payQty, productDs? }` | 2x1, 3x2 |
| `buyXgetY` | `{ type, buyProductD, giftProductD }` | Comprá A, llevate B gratis |
| `freeItems` | `{ type, items: [{ d, qty }] }` | 2 cafés gratis |

`currency` es `ARS`, `USD` o `SAT`. En sats el monto tiene que ser entero: no se puede cobrar medio satoshi, y redondearlo en silencio haría que el cupón valga algo distinto de lo que dice.

### Cuánto descuenta cada uno

Contra un carrito de **2 empanadas a ARS 100** y **1 café a ARS 250** (bruto: ARS 450):

| Cupón | Descuenta | Por qué |
|---|---|---|
| `percent` 10% | ARS 45 | 10% del subtotal de cada moneda |
| `fixed` ARS 500 | ARS 449 | Se topea: nunca llega a cero, queda 1 sat |
| `fixed` ARS 500 en café | ARS 250 | Topeado a lo que vale el café en el carrito |
| `multibuy` 2x1 en empanada | ARS 100 | Un grupo completo de 2 ⇒ 1 gratis |
| `buyXgetY` empanada → café | ARS 250 | Un regalo, siempre uno |
| `freeItems` 1 empanada + 1 café | ARS 350 | Las unidades regaladas, a su precio de línea |
| `freeItems` 3 empanadas | ARS 200 | Sólo hay 2 en el carrito: se regalan 2 |

### Alcance por producto

Los tres primeros aceptan `productDs`: una lista de `d` de productos (los UUID que este app genera para cada NIP-99).

**Ausente significa todos.** Ese default es la mitad importante: alguien que ofrece "10% off" quiere decir la tienda entera, y obligarlo a tildar el catálogo completo para decirlo sería un peor sistema de cupones.

Con lista:

- **`percent`** se calcula sólo sobre esas líneas.
- **`fixed`** se topea en lo que valen esas líneas *en la moneda del cupón*. "ARS 500 en café" contra un carrito con ARS 200 de café y ARS 5000 de otras cosas descuenta 200. Sin ese tope, un cupón acotado terminaría descontando el resto del carrito.
- **`multibuy`** se cuenta por línea: con varios productos, cada uno suma por su cuenta.

`buyXgetY` no lleva `productDs` porque ya nombra sus dos productos.

### Producto gratis (`freeItems`)

El único beneficio **sin condición de compra**: el cupón *es* el producto. Se elige una lista de productos con su cantidad — `[{ d, qty }]` — y esas unidades salen del total.

Es la excepción a la regla de arriba, y a propósito: **acá la lista vacía no significa "todos"**, significa que el cupón es inválido. En los otros tipos "todos" es un descuento sobre la tienda; en este sería regalar el catálogo, que no es algo que alguien quiera decir sin querer. `parseBenefit` rechaza la lista vacía, y rechaza un producto repetido en vez de sumarlo: dos entradas del mismo café podrían ser 2 o 5, y adivinar cuál es peor que pedir que lo escriban una sola vez. Las cantidades van de 1 a `MAX_FREE_QTY` (100), hasta `MAX_COUPON_PRODUCTS` (50) productos.

Dos reglas que caen de que igual hay que tener el producto en el carrito:

- **Se topea contra el carrito.** Un cupón por 3 cafés contra un carrito con 1 regala 1. Nunca descuenta unidades que no están.
- **Se aplica producto por producto.** Si el cupón da 1 empanada y 2 cafés, y en el carrito hay sólo empanada, la empanada sale gratis igual. Por eso `unmet.anyOf` es `true`: alcanza con cualquiera de los productos para que el cupón haga algo, y la tienda dice "agregá alguno de estos" en vez de exigir la lista completa.

La diferencia con `buyXgetY` es la condición: aquel exige que el producto pagado esté en el carrito y regala **uno**; este no exige nada y regala **las cantidades que dice**.

### Reglas de la aritmética

Viven en `priceCart()` y son las que evitan cobrar mal:

- **El redondeo pasa una sola vez, sobre el carrito ya descontado.** Es la regla de [`rates.ts`](../src/lib/domain/rates.ts): un total es el techo de la suma, nunca la suma de los techos. Por eso el descuento se aplica **escalando** cada subtotal por el mismo factor en vez de restar de una moneda — en un carrito mixto, restar de la fila en ARS dejaría el desglose sin sumar al total en sats.
- **Nunca se llega a cero.** Queda `MIN_CHARGE_SATS` (1 sat) en la factura: una factura de cero sats no es pagable, las billeteras la rechazan y LNURL declara un `minSendable` de al menos 1.
- **Un descuento que no se puede convertir no se adivina.** Si falta la cotización de una moneda, el cupón no aplica y se dice por qué.

Cuando el cupón no aplica, `unmet` explica el motivo: `empty-cart`, `unquotable` o `needs-products`. Este último trae `anyOf`, que distingue "alcanza con uno de estos" (porcentaje o monto acotados) de "hacen falta los dos" (`buyXgetY`).

---

## 3. Eventos de nostr

Dos. Uno lo firma el comerciante y se publica; el otro lo firma este servidor y **nunca** se publica.

### 3.1 Anuncio de descubrimiento — kind `30078`

Lo firma **el comerciante con su propia clave**. Es lo único que hace que una caja ajena pueda encontrar este servicio.

```jsonc
{
  "kind": 30078,                          // NIP-78 (app data)
  "pubkey": "<hex del comerciante>",
  "tags": [
    ["d", "lacrypta.merchant/coupons"],   // el `d` es toda la cerca
    ["p", "<hex del manager>"],           // quién firma los vouchers, indexable
    ["client", "merchant-manager"]
  ],
  "content": "{\"v\":2,\"mintUrl\":\"…\",\"claimUrl\":\"…\"}"
}
```

El `content` es **texto plano**. Todos los demás 30078 de esta app van cifrados con NIP-44 hacia el propio comerciante porque llevan credenciales; este es lo contrario: es un anuncio, y un POS de otra persona tiene que poder leerlo. No hay nada secreto adentro — el endpoint de emisión está protegido por NIP-98 y una lista de npubs autorizados, no porque la URL sea difícil de encontrar.

| Dónde | Campo | Qué es |
|---|---|---|
| tag | `p` | Hex de la clave que firma los vouchers. Contra esta se verifican |
| content | `v` | `2`. Otra versión se **descarta**, nunca se migra a medias |
| content | `mintUrl` | Absoluta. POST, NIP-98, sólo npubs autorizados |
| content | `claimUrl` | Absoluta. GET para consultar, POST para canjear |

Las URLs tienen que ser `https`, con la excepción de `localhost`/`127.0.0.1` para poder ejercitar el flujo completo contra `npm run dev` sin un túnel.

Kind 30078 es *addressable*, así que mudarse de host es editar un evento y no una migración que nadie puede coordinar.

**Por qué la clave del manager es un tag y no un campo.** Un relay indexa tags; no puede indexar un campo adentro de un string. Con `p` afuera, *"¿qué comercios nombraron a este servicio?"* es un filtro que cualquiera puede correr —`{"kinds":[30078],"#d":["lacrypta.merchant/coupons"],"#p":["<manager>"]}`— en vez de bajarse todos los anuncios del mundo y parsearlos de a uno.

> **Cómo leerlo bien, si estás escribiendo un cliente.** Pedí siempre el **más nuevo** por autor + `d`, y recién ahí mirá el `p`. **Nunca te suscribas filtrando por `#p`**: el evento es addressable, y preguntar "dame el anuncio que me nombra" puede devolver una versión **anterior** mientras la vigente nombra a otro servicio. Un POS que lea eso va a creer que sigue siendo el responsable de cupones que ya no le corresponden. El orden importa: primero el último, después de quién es.

**Los anuncios `v1` ya no valen.** La versión anterior llevaba `managerPubkey` adentro del `content` y no tenía tag `p`; parsear a medias un anuncio significa mandar una caja a una URL cuyo significado adivinamos, así que se descartan enteros. Cada comerciante tiene que **volver a firmar**: el panel se lo pide solo —"No pudimos leer el anuncio publicado (formato viejo, v1). Reactivalo para reemplazarlo"— y hasta que lo haga no puede crear cupones ni su tienda muestra la caja de canje.

**Dónde vive.** En los relays *y* en nuestra base (`coupon_discovery`, una fila por comerciante, el evento firmado tal cual). Los relays no son almacenamiento que controlemos: pierden eventos, se caen, y una lectura puede no traer uno que sí está publicado. La copia local es la que responde al cargar la página; los relays se verifican contra ella, y si falta se **reenvía solo** — sin pedir firma, porque los bytes ya están firmados.

### 3.2 Voucher — kind `20402`

Lo firma **este servidor** con `COUPON_MANAGER_NSEC`, y viaja en la respuesta JSON de emisión y canje. Nunca se publica a un relay.

```jsonc
{
  "kind": 20402,
  "pubkey": "<hex del manager>",
  "tags": [
    ["nonce", "hcLPDzERvvHzS4Vn0OLbAQ"],
    ["p", "<hex del comerciante dueño>"],
    ["coupon", "<uuid de la definición>"],
    ["phase", "minted"],                  // o "claimed"
    ["expiration", "1764633600"]          // NIP-40, sólo si vence
  ],
  "content": "{\"v\":1,\"nonce\":\"…\",\"owner\":\"…\",\"coupon\":{…},\"phase\":\"minted\",…}"
}
```

**Por qué 20402:** está en el rango efímero (20000–29999), así que si alguna vez se filtra a un relay, uno que cumpla la spec lo reenvía pero no lo guarda — lo correcto para un evento cuyo contenido lleva un nonce al portador. Está libre en el registro de NIPs, y es el espejo efímero de 30402, el kind de listing sobre el que está construida esta app.

**Para qué sirve:** las respuestas son JSON sobre HTTPS, lo que prueba que el cupón vino de quien tenga el certificado TLS. La firma del manager prueba que vino del servicio que **el comerciante nombró en su anuncio**, que es lo que un cajero necesita saber.

Cómo verificarlo, sin llamarnos:

1. Leer el anuncio 30078 **más nuevo** del comerciante → el tag `p`.
2. `voucher.pubkey === p`.
3. Verificar la firma del evento (re-derivando el id, sin confiar en memos de la librería).
4. Parsear el `content` y comparar `nonce` y `coupon` con lo que se recibió.

---

## 4. Endpoints

Todos con CORS abierto (`Authorization` incluido en el preflight, que no es un header safelisted), `Cache-Control: no-store`, y errores en castellano dentro de `{ "error": "…" }`.

**Auth** dice qué acepta cada ruta. Donde dice *NIP-98 o Bearer*, las dos formas son equivalentes y dan el mismo tenant: firmá un evento por request, o cambiá una firma por una sesión (§4.1). Un POS que ya anda no necesita cambiar nada.

| Método y ruta | Auth | Para qué |
|---|---|---|
| `POST /api/auth/session` | NIP-98 | Cambiar una firma por un JWT de 12 h |
| `GET /api/coupons` | NIP-98 o Bearer | Cupones + emisores + anuncio guardado, en una sola llamada |
| `POST /api/coupons` | NIP-98 o Bearer | Crear |
| `PATCH /api/coupons/{id}` | NIP-98 o Bearer | Editar |
| `DELETE /api/coupons/{id}` | NIP-98 o Bearer | Borra si nunca se emitió; si no, archiva |
| `GET /api/coupons/{id}/mints` | NIP-98 o Bearer | Las emisiones de ese cupón |
| `DELETE /api/coupons/{id}/mints/{nonce}` | NIP-98 o Bearer | Anular una emisión sin canjear |
| `POST /api/coupons/minters` | NIP-98 o Bearer | Autorizar un npub, nprofile, hex o NIP-05 |
| `DELETE /api/coupons/minters/{pubkey}` | NIP-98 o Bearer | Revocar |
| `PUT /api/coupons/discovery` | NIP-98 o Bearer | Guardar el anuncio firmado |
| `GET /api/coupons/mintable` | NIP-98 o Bearer | Qué puede emitir el npub que pregunta |
| **`POST /api/coupons/mint`** | NIP-98 o Bearer, + autorizado | **Emitir**. La `mintUrl` del anuncio |
| **`GET/POST /api/coupons/claim`** | sólo el nonce | **Consultar / canjear**. La `claimUrl` |
| `GET /api/coupons/manager` | — | El pubkey que firma los vouchers |

Una sola llamada devuelve cupones + emisores + anuncio: es un viaje de red menos, y sin sesión era además una firma menos.

### 4.1 Sesión — `POST /api/auth/session`

Firmás un NIP-98 una vez y recibís un bearer que vale para todo lo demás:

```jsonc
// POST /api/auth/session   ·   Authorization: Nostr <base64>   ·   sin cuerpo
{ "token": "eyJhbGciOi…", "pubkey": "<hex>", "expiresAt": 1785000000 }
```

Después: `Authorization: Bearer <token>`. Es un JWT HS256 con tres claims — `sub` (el pubkey), `iat`, `exp` — firmado con `SESSION_JWT_SECRET`.

**No es una mejora de seguridad, es un intercambio.** NIP-98 ata cada token a un pubkey, una URL, un método, un hash de cuerpo, sesenta segundos y un solo uso. El bearer ata un pubkey y un vencimiento: robarlo da todo lo que ese pubkey puede hacer hasta que caduque. Lo que se compra a cambio es no pagar una firma por request, que en un bunker NIP-46 es un viaje al teléfono del comerciante por cada click.

Consecuencias que conviene saber:

- **12 horas**, un turno. El navegador lo guarda en `sessionStorage`, así que además muere al cerrar la pestaña.
- **Todas las rutas lo aceptan, emisión incluida.** Dejar `mint` sólo con NIP-98 no protegería nada: con el mismo bearer se llama a `POST /api/coupons/minters`, uno se agrega como emisor autorizado, y emite con su propia firma.
- **No hay endpoint para cerrar sesión.** El token no tiene estado del lado del servidor, así que no hay nada que revocar: salir es soltarlo. Si necesitás invalidar todo ya, rotá `SESSION_JWT_SECRET`.
- **Errores**: `401` con `reason: "session-expired"` o `reason: "session-invalid"`. **Re-emití ante cualquiera de los dos.** Sin `SESSION_JWT_SECRET` la clave es aleatoria por proceso, así que un reinicio hace que los tokens vivos fallen como *invalid* y no como *expired*.

### 4.2 NIP-98

Kind `27235` en el header `Authorization: Nostr <base64>`. Se verifica en este orden — barato primero, y la firma antes de confiar en cualquier tag:

1. Forma del evento
2. `kind === 27235`
3. **Firma válida**
4. `|ahora − created_at| ≤ 60s`
5. Tag `method` coincide
6. Tag `u` coincide con la URL externa (origen + path + query exactos)
7. Tag `payload` = sha256 del cuerpo, cuando hay cuerpo

Con `NEXT_PUBLIC_APP_URL` seteada, ese es el **único** origen aceptado y los headers `x-forwarded-*` se ignoran, así que falsificarlos no sirve para ampliar la audiencia del token.

Hay una caché de ids vistos en proceso (150s) contra replay. Es honesta sobre lo que es: mismo alcance que el rate limit — sube el costo, no lo hace imposible, y no se comparte entre instancias.

> **Si estás implementando un cliente:** el token tiene que llevar **algo que lo haga único**. Todo lo demás es determinístico y `created_at` tiene resolución de un segundo, así que dos emisiones del mismo cupón en el mismo segundo hashean al mismo id y la segunda se rechaza con `reason: "replay"`. Nuestro cliente agrega un tag `nonce` aleatorio; una caja que emite varios cupones por segundo tiene que hacer lo mismo.

### 4.3 Emisión

`POST /api/coupons/mint` con `{ "couponId": "<uuid>" }`. El que firma tiene que ser el dueño o estar en la lista de emisores.

```jsonc
{
  "coupon":      { "type": "percent", "percent": 10 },
  "name":        "Promo de verano",
  "description": "10% en toda la tienda",
  "npub":        "npub1…",              // el DUEÑO
  "image":       "https://…",           // o null
  "nonce":       "hcLPDzERvvHzS4Vn0OLbAQ",
  "expiresAt":   1764633600,            // o null
  "voucher":     { /* kind 20402 firmado */ }
}
```

Errores: `403` no autorizado · `404` no existe · `409` se agotaron · `410` archivado o vencido.

El nonce son 16 bytes al azar en base64url (22 caracteres): imposible de adivinar y entra en cualquier QR. **Es un token al portador** — quien lo tiene puede canjear.

### 4.4 Canje

**`GET /api/coupons/claim?nonce=…`** consulta sin consumir. Siempre `200` para un nonce conocido, con el motivo en `status`: `minted`, `claimed`, `expired` o `voided`. Es un endpoint de previsualización: un error HTTP haría que todos esos casos parezcan una falla de red.

**`POST /api/coupons/claim`** con `{ "nonce": "…" }` consume:

- `200` `status: "success"` — recién canjeado, con `voucher` en fase `claimed`
- `200` `status: "claimed"` — ya estaba canjeado, con el `claimedAt` **original**
- `404` no existe · `410` vencido o anulado

Que "ya canjeado" sea 200 y no un error es a propósito: un POS que perdió la respuesta reintenta, y comparando `claimedAt` con su propio reloj sabe si el canje fue suyo.

La concurrencia la decide la base, no este proceso:

```sql
UPDATE coupon_mints SET status='claimed', claimed_at=now()
 WHERE nonce = $1 AND status = 'minted' AND EXISTS (… no vencido …)
RETURNING *;
```

Dos cajas escaneando el mismo QR en el mismo instante producen un UPDATE que devuelve fila y otro que no. El segundo se reporta como ya canjeado. Un read-then-write sería una carrera con plata del otro lado.

### 4.5 Anulación

`DELETE /api/coupons/{id}/mints/{nonce}` revoca una emisión que nunca se canjeó.

La **fila sobrevive**: una caja que escanea un QR anulado tiene que enterarse de que fue anulado, y una fila borrada sólo podría contestar "no existe", que manda al cajero a buscar un error de tipeo que no existe.

Está guardado con `status = 'minted'`, así que un cupón ya canjeado no se puede deshacer — el cliente ya recibió lo que se le prometió (`409`).

**Devuelve el lugar al máximo.** Quien se equivoca y toca "Emitir" en un cupón de un solo uso tendría que ir a editar el cupón para poder volver a emitirlo, y "esta emisión nunca pasó" es exactamente lo que significa anular.

---

## 5. Flujos

### 5.1 Activar el servicio

```
Comerciante            Esta app                    Base            Relays
    │                     │                          │               │
    │ "Activar servicio"  │                          │               │
    ├────────────────────►│ GET /api/coupons/manager │               │
    │                     │◄─── managerPubkey ───────┤               │
    │  firma el 30078     │                          │               │
    │  (con `p` = manager)│                          │               │
    │◄────────────────────┤                          │               │
    ├────────────────────►│ PUT /discovery ─────────►│ guarda        │
    │                     ├─────────── publica ──────────────────────►│
```

Se guarda **apenas se firma**, antes de que los relays contesten: perder esa copia porque un relay tardó era el bug que este mecanismo existe para arreglar.

Hasta que esté activado **no se pueden crear cupones**. Un cupón que nadie puede descubrir es una fila en una base que nadie alcanza. La puerta está en la UI, no en la API: un POS que ya sabe lo que hace puede seguir usando `/api/coupons`, y no gana nada porque nadie más puede descubrirlo.

Al cargar la página se le pregunta **a cada relay por separado** si tiene el evento (un pedido por relay, filtrando por id). La lectura mezclada del catálogo no sirve para esto: "lo tenemos" y "lo tiene uno de cinco" se ven igual. A los que les falta, se les publica **sólo a ellos**, una vez por evento por sesión.

### 5.2 Emitir y canjear en un POS ajeno

```
POS                        Relays              Este servicio
 │  lee el 30078 del npub    │                      │
 ├──────────────────────────►│   (el más nuevo,     │
 │◄── p, mintUrl, claimUrl ──┤    sin filtrar #p)   │
 │                                                  │
 │  POST mintUrl  (NIP-98, npub autorizado)         │
 ├─────────────────────────────────────────────────►│
 │◄── coupon, name, npub, nonce, voucher ───────────┤
 │                                                  │
 │  verifica voucher.pubkey === tag `p`             │
 │  muestra el QR con el nonce                      │
 │                                                  │
 │  POST claimUrl { nonce }                         │
 ├─────────────────────────────────────────────────►│
 │◄── status: success | claimed ────────────────────┤
```

### 5.3 Canje en la tienda de esta misma app

El checkout no necesita el anuncio: llama a sus propios endpoints.

1. El comprador pega el nonce (o llega con `?coupon=<nonce>`).
2. **`GET claim`** valida sin consumir. Se chequea que el cupón sea **de esta tienda** — un despliegue sirve a muchos comercios y el endpoint responde por cualquier nonce que conozca; sin ese chequeo alguien podría llevar un 50% de un local a otro.
3. El descuento se muestra en el total. Todavía no se consumió nada.
4. Al tocar "Generar factura", **`POST claim`** lo consume *antes* de pedir la factura. Si otro lo usó en el medio, se avisa y se saca del carrito.
5. El cupón queda en la orden como tags del zap request: `["coupon", id, tipo, nombre]` y un `["discount", monto, moneda]` por moneda. Los tags `total` siguen siendo **brutos**: bruto − descuento = pagado.

Si el comprador canjea y después abandona sin pagar, el cupón se quemó. Es un trade-off aceptado: canjear antes de facturar es mejor que facturar un descuento que después no se puede cobrar. El comerciante emite otro.

Una vez **pagada** la orden, se borra del `localStorage`. El recibo sigue en pantalla para quien pagó, pero el próximo que entre al checkout lo encuentra vacío en vez de encontrarse el comprobante de otro.

---

## 5.4 Decisiones que conviene no revertir sin leer el porqué

- **`GET` valida y `POST` consume.** Si aplicar un cupón lo canjeara, quien pega un código y cierra la pestaña lo perdió.
- **Se canjea ANTES de pedir la factura.** Al revés, dos cajas podrían honrar el mismo nonce; así el peor caso es un cupón quemado que el comercio reemite en dos toques.
- **El `benefit` se congela al emitir.** El voucher ya se firmó sobre esas condiciones: editar el cupón después no puede cambiar lo que promete uno que ya está en el celular de alguien.
- **Archivar frena la emisión, no el canje.** Los que ya se entregaron eran una promesa del comercio. Para cortarlos, fecha de vencimiento pasada.
- **Anular conserva la fila.** Borrarla haría que una caja lea "no existe" en lugar de "fue anulado".
- **Los tags `total` del pedido van BRUTOS**, con el descuento aparte en `["coupon", …]` y `["discount", …]`. Así el libro de órdenes se lee como un ticket: ítems, menos cupón, igual lo cobrado.
- **El descuento escala cada subtotal por el mismo factor** en lugar de restarse de una moneda. En un carrito de una sola moneda es resta exacta; en uno mixto es lo único que deja el desglose en pesos sumando al total en sats.

---

## 6. Datos

Cuatro tablas ([`src/lib/server/db/schema.ts`](../src/lib/server/db/schema.ts)):

- **`coupon_definitions`** — el cupón: dueño, nombre, descripción, imagen, tipo y sus columnas, `product_ds`, `free_items`, `max_uses`, `minted_count`, `expires_at`, `archived_at`.
- **`coupon_mints`** — cada emisión: `nonce` único, **`benefit` congelado en jsonb**, quién emitió, estado (`minted` | `claimed` | `voided`) y sus timestamps.
- **`coupon_minters`** — qué npubs pueden emitir los cupones de cada dueño.
- **`coupon_discovery`** — el anuncio firmado, una fila por comerciante.

El beneficio vive en **columnas tipadas y anulables**, no en un jsonb único: así la tabla se lee, se indexa y se corrige con SQL a mano cuando algo se rompe a las 3 de la mañana. `parseBenefit` es lo que garantiza que para cada `type` esté poblado el subconjunto correcto. Las dos excepciones son listas y por eso son jsonb: `product_ds` (el alcance) y `free_items` (los `{ d, qty }` que se regalan). Son columnas distintas a propósito — una **acota** un descuento y la otra **es** el descuento, y compartirlas obligaría a mirar `type` antes de saber cuál de las dos cosas estás leyendo.

**Por qué el beneficio se congela en la emisión:** editar un cupón cambia la definición, pero el voucher que el manager ya firmó dice otra cosa. El canje sirve el snapshot, así que un cupón en el teléfono de alguien vale lo que decía cuando se lo dieron.

`archived_at` frena **sólo las emisiones nuevas**; lo que ya está en la calle se sigue canjeando, porque fue una promesa que el comerciante hizo. Para cortar lo que está afuera, se pone `expiresAt` en el pasado. La FK de `coupon_mints` es `ON DELETE RESTRICT`, así que un cupón con emisiones no se puede borrar: se archiva.

---

## 7. Configuración

```bash
DATABASE_URL=postgres://merchant:merchant@localhost:55432/merchant
COUPON_MANAGER_NSEC=nsec1…       # la identidad que firma los vouchers
NEXT_PUBLIC_APP_URL=http://localhost:4321
SESSION_JWT_SECRET=…             # firma los JWT de sesión (§4.1)
```

Sin `DATABASE_URL` o sin `COUPON_MANAGER_NSEC` los endpoints de cupones responden `503` y el resto de la app funciona igual: no tener base es un estado soportado.

Tres variables firman cosas y cada una falla distinto, a propósito:

- **`COUPON_MANAGER_NSEC` no tiene fallback**: firma artefactos publicados y longevos —vouchers, el anuncio— y una clave que rota en silencio los invalida meses después, sin aviso. Que falte es un 503.
- **`SESSION_JWT_SECRET` sí tiene fallback aleatorio por proceso**, como `LN_PROXY_SECRET`: lo peor que pasa es una firma de más. **Pero con más de una instancia hay que setearla**, o un token emitido por A lo rechaza B y el cliente re-emite en request por medio — peor que no tener sesión.

```bash
npm run db:generate   # después de tocar el schema
npm run db:migrate    # a mano; el build ya lo hace solo
```

**Las migraciones corren en el build**, no en runtime: `npm run build` ejecuta `drizzle-kit migrate` antes de compilar si hay `DATABASE_URL` (o `DATABASE_POOL_URL`), y falla el build si no aplican. Un migrador en runtime correría en carrera con varias instancias; dejarlo sólo en manos de quien despliega ya se probó y termina en una tabla que no existe.

Si el proveedor da dos URLs —una directa y un pooler— la app y las migraciones usan **el pooler**. Lo de libro es migrar por la conexión directa, pero esto corre adentro del deploy: si el build no la alcanza, no hay migración.
