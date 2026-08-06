# Flujos

Cómo se encadena todo, de punta a punta, y qué decisiones conviene no revertir sin leer el porqué.

---

## 1. Activar el servicio

```
Comerciante            Esta app                    Base            Relays
    │                     │                          │               │
    │ "Activar servicio"  │                          │               │
    ├────────────────────►│ GET /api/coupons/manager │               │
    │                     │◄─── managerPubkey ───────┤               │
    │  firma el 30078     │                          │               │
    │◄────────────────────┤                          │               │
    ├────────────────────►│ PUT /discovery ─────────►│ guarda        │
    │                     ├─────────── publica ──────────────────────►│
```

Se guarda **apenas se firma**, antes de que los relays contesten: perder esa copia porque un relay tardó era el bug que este mecanismo existe para arreglar.

Hasta que esté activado **no se pueden crear cupones**. Un cupón que nadie puede descubrir es una fila en una base que nadie alcanza. La puerta está en la UI, no en la API: un POS que ya sabe lo que hace puede seguir usando `/api/coupons`, y no gana nada porque nadie más puede descubrirlo.

---

## 2. Emitir y canjear en un POS ajeno

```
POS                        Relays              Este servicio
 │  lee el 30078 del npub    │                      │
 ├──────────────────────────►│                      │
 │◄── mintUrl, claimUrl ─────┤                      │
 │                                                  │
 │  POST mintUrl  (NIP-98, npub autorizado)         │
 ├─────────────────────────────────────────────────►│
 │◄── coupon, name, npub, nonce, voucher ───────────┤
 │                                                  │
 │  verifica voucher.pubkey === managerPubkey       │
 │  muestra el QR con el nonce                      │
 │                                                  │
 │  POST claimUrl { nonce }                         │
 ├─────────────────────────────────────────────────►│
 │◄── status: success | claimed ────────────────────┤
```

El POS no necesita saber nada de nosotros de antemano: el anuncio le dice a dónde pegarle, y el voucher le dice que la respuesta vino de quien el comerciante nombró. Ver [Eventos § cómo verificarlo](./cupones-nostr.md#cómo-verificarlo-sin-llamarnos).

---

## 3. Canje en la tienda de esta misma app

El checkout no necesita el anuncio: llama a sus propios endpoints.

1. El comprador pega el nonce en el carrito (o llega con `?coupon=<nonce>`).
2. **`GET claim`** valida sin consumir. Se chequea que el cupón sea **de esta tienda** — un despliegue sirve a muchos comercios y el endpoint responde por cualquier nonce que conozca; sin ese chequeo alguien podría llevar un 50% de un local a otro.
3. El descuento se muestra en el total. Todavía no se consumió nada.
4. Al tocar **"Generar factura"**, se firma el zap request (es local, no toca la red) y **`POST claim`** consume el cupón *antes* de pedir la factura, llevándose la orden firmada. Si otro lo usó en el medio, se avisa y se saca del carrito.
5. El cupón queda en la orden como tags del zap request: `["coupon", id, tipo, nombre]` y un `["discount", monto, moneda]` por moneda. Los tags `total` siguen siendo **brutos**: bruto − descuento = pagado.

**Si el total queda en cero**, el botón dice **"Reclamar"** y no hay factura, ni pago, ni recibo que esperar: el canje se hace igual (con `amountMsat: 0`) y la orden queda en estado `claimed`. Esa fila es el único registro del pedido, y es lo que hace que aparezca en `/admin/orders` con el badge *Reclamada* y en la pestaña **Canjeados** de `/admin/coupons`. Sin cupón aplicado el botón queda deshabilitado: no habría nonce contra el cual registrar nada.

Si el comprador canjea y después abandona sin pagar, el cupón se quemó. Es un trade-off aceptado: canjear antes de facturar es mejor que facturar un descuento que después no se puede cobrar. El comerciante emite otro.

Una vez **pagada** la orden, se borra del `localStorage`. El recibo sigue en pantalla para quien pagó, pero el próximo que entre al checkout lo encuentra vacío en vez de encontrarse el comprobante de otro.

### Los tres estados de una orden con cupón

Lo que ve el comerciante en `/admin` depende de qué pasó con la plata:

| Estado | De dónde sale | Qué muestra |
|---|---|---|
| **Cobrada** | Hay un zap receipt en los relays | El importe cobrado |
| **Reclamada** | `amount_msat = 0` en el canje | "Sin cargo — cubierta por el cupón" |
| **Con cupón** | Canje con importe, sin receipt todavía | "A cobrar N sat — importe facturado al canjear" |

El tercero no se lista en `/admin/orders`: pertenece al receipt que va a llegar por él, y ponerlo ahí sería postear una orden que el comerciante no cobró, y después postearla dos veces.

---

## 4. Decisiones que conviene no revertir sin leer el porqué

**Del canje**

- **`GET` valida y `POST` consume.** Si aplicar un cupón lo canjeara, quien pega un código y cierra la pestaña lo perdió.
- **Se canjea ANTES de pedir la factura.** Al revés, dos cajas podrían honrar el mismo nonce; así el peor caso es un cupón quemado que el comercio reemite en dos toques.
- **"Ya canjeado" es `200`, no un error.** Un POS que perdió la respuesta reintenta, y comparando `claimedAt` con su propio reloj sabe si el canje fue suyo.
- **Un `zapRequest` inválido no cancela el canje.** Se pierde el registro, no el cupón del cliente.

**De lo que promete un cupón**

- **El `benefit` se congela al emitir.** El voucher ya se firmó sobre esas condiciones: editar el cupón después no puede cambiar lo que promete uno que ya está en el celular de alguien.
- **Archivar frena la emisión, no el canje.** Los que ya se entregaron eran una promesa del comercio. Para cortarlos, fecha de vencimiento pasada.
- **Anular conserva la fila.** Borrarla haría que una caja lea "no existe" en lugar de "fue anulado".

**Del registro de la venta**

- **La orden se archiva en el canje, no después.** No hay tabla de órdenes: una orden pagada se reconstruye del zap receipt, y una reclamada no tiene receipt porque nadie la pagó. Si el `POST claim` no se la lleva, no existe en ningún lado.
- **`amount_msat = 0` es lo que marca una orden reclamada.** Es lo que distingue "nunca va a tener recibo" de "todavía no llegó", y sin eso el libro de órdenes mostraría como cobrada una compra que el comprador abandonó.
- **Los tags `total` del pedido van BRUTOS**, con el descuento aparte en `["coupon", …]` y `["discount", …]`. Así el libro de órdenes se lee como un ticket: ítems, menos cupón, igual lo cobrado.

**De la aritmética**

- **El libro de órdenes imputa el descuento a la línea que lo recibió**, aunque el checkout cobre un solo total. Un cupón de una cerveza gratis se lleva el precio de una cerveza, no una tajada de cada ítem: repartirlo proporcionalmente deja a cada producto con una facturación que nunca tuvo. `discountByLine` hace ese reparto y `allocateOrderLineSats` pondera por el neto.
- **El descuento escala cada subtotal por el mismo factor** en lugar de restarse de una moneda. En un carrito de una sola moneda es resta exacta; en uno mixto es lo único que deja el desglose en pesos sumando al total en sats.
- **El tope acota en su propia moneda.** Convertir necesitaría una tabla de cotizaciones que esa capa no toma, y adivinar un número es peor que aplicar el techo donde fue escrito.
