# Cupones

Este servidor **emite y canjea cupones a nombre de un comerciante**, y el comerciante lo autoriza firmando un evento de nostr que dice dónde está el servicio. Cualquier punto de venta que lea ese evento puede emitir y canjear sin haber hablado nunca con nosotros.

## Los documentos

| Documento | Qué contesta |
|---|---|
| **Este** | Por qué hay una base de datos, cómo se configura, quién es quién |
| [Descuentos](./cupones-descuentos.md) | Qué descuenta cada tipo de cupón, con qué reglas de aritmética |
| [API](./cupones-api.md) | Cada endpoint, con su cuerpo, su respuesta y sus errores |
| [Eventos de nostr](./cupones-nostr.md) | El anuncio (30078) y el voucher (20402), y cómo verificarlos |
| [Flujos](./cupones-flujos.md) | Cómo se encadena todo, y qué decisiones no conviene revertir |
| [Datos](./cupones-datos.md) | Las tablas, sus columnas y qué garantiza cada una |

Si estás integrando un POS, alcanza con [API](./cupones-api.md) y [Eventos](./cupones-nostr.md).

---

## Quién es quién

| Rol | Qué hace | Con qué clave |
|---|---|---|
| **Comerciante** (owner) | Crea cupones, autoriza emisores, firma el anuncio | La suya (NIP-07 / NIP-46) |
| **Emisor** (minter) | Emite cupones de un comerciante que lo autorizó | La suya |
| **Manager** | Firma los vouchers. Es este servidor | `COUPON_MANAGER_NSEC` |
| **Portador** | Tiene el nonce y lo canjea. No necesita clave | Ninguna — el nonce es la credencial |

Un despliegue sirve a **muchos comerciantes** a la vez. Todo lo que devuelve la API está acotado por el pubkey que firmó el pedido: un cupón de otro es indistinguible de uno que no existe, que es la respuesta correcta para alguien probando UUIDs.

---

## Por qué hay una base de datos

Es la única parte de la app con Postgres. El resto vive en relays y en `localStorage`, y eso es deliberado.

El motivo es corto: *"¿este cupón ya se usó?"* tiene que tener **una sola respuesta** en el instante en que dos cajas la preguntan. Los relays son consistentes-eventualmente por diseño — perfecto para un catálogo, inservible para decidir quién se queda con el único descuento que quedaba.

Todo lo que necesita esa garantía está en Postgres. Todo lo que necesita ser descubierto por terceros está en nostr.

La consecuencia práctica: **no hay tabla de órdenes**, pero sí hay órdenes guardadas. Una compra pagada se reconstruye de su zap receipt en los relays; una que un cupón dejó en cero nunca genera factura ni receipt, así que se archiva en la fila del canje. Ver [Datos § la orden cuelga del canje](./cupones-datos.md#la-orden-cuelga-del-canje).

---

## Configuración

```bash
DATABASE_URL=postgres://merchant:merchant@localhost:55432/merchant
COUPON_MANAGER_NSEC=nsec1…       # la identidad que firma los vouchers
NEXT_PUBLIC_APP_URL=http://localhost:4321
SESSION_JWT_SECRET=…             # firma los JWT de sesión
```

Sin `DATABASE_URL` o sin `COUPON_MANAGER_NSEC` los endpoints de cupones responden `503` y el resto de la app funciona igual: **no tener base es un estado soportado**.

Tres variables firman cosas y cada una falla distinto, a propósito:

- **`COUPON_MANAGER_NSEC` no tiene fallback**: firma artefactos publicados y longevos —vouchers, el anuncio— y una clave que rota en silencio los invalida meses después, sin aviso. Que falte es un 503.
- **`SESSION_JWT_SECRET` sí tiene fallback aleatorio por proceso**, como `LN_PROXY_SECRET`: lo peor que pasa es una firma de más. **Pero con más de una instancia hay que setearla**, o un token emitido por A lo rechaza B y el cliente re-emite en request por medio — peor que no tener sesión.
- **`NEXT_PUBLIC_APP_URL`**, si está seteada, es el **único** origen que NIP-98 acepta, y los headers `x-forwarded-*` se ignoran. Ver [API § NIP-98](./cupones-api.md#nip-98).

### Migraciones

```bash
npm run db:generate   # después de tocar el schema
npm run db:migrate    # a mano; el build ya lo hace solo
```

**Las migraciones corren en el build**, no en runtime: `npm run build` ejecuta `drizzle-kit migrate` antes de compilar si hay `DATABASE_URL` (o `DATABASE_POOL_URL`), y falla el build si no aplican. Un migrador en runtime correría en carrera con varias instancias; dejarlo sólo en manos de quien despliega ya se probó y termina en una tabla que no existe.

Si el proveedor da dos URLs —una directa y un pooler— la app y las migraciones usan **el pooler**. Lo de libro es migrar por la conexión directa, pero esto corre adentro del deploy: si el build no la alcanza, no hay migración.

---

## Mapa del código

| Qué | Dónde |
|---|---|
| Tipos, validación y aritmética | [`src/lib/domain/coupon.ts`](../src/lib/domain/coupon.ts) |
| Formulario del wizard | [`src/lib/domain/coupon-schema.ts`](../src/lib/domain/coupon-schema.ts) |
| El anuncio 30078 | [`src/lib/domain/coupon-discovery.ts`](../src/lib/domain/coupon-discovery.ts) |
| SQL | [`src/lib/server/coupon-store.ts`](../src/lib/server/coupon-store.ts) |
| Helpers compartidos por las rutas | [`src/lib/server/coupon-api.ts`](../src/lib/server/coupon-api.ts) |
| Tablas | [`src/lib/server/db/schema.ts`](../src/lib/server/db/schema.ts) |
| Endpoints | [`src/app/api/coupons/`](../src/app/api/coupons/) |
