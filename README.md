# Merchant Manager

Panel para que un comercio administre su catálogo y lo publique en **nostr**, firmado con su propia clave. Cualquier punto de venta lo lee en vivo.

Hecho por [La Crypta](https://lacrypta.ar).

## El problema que resuelve

Hoy el catálogo de La Crypta es **un archivo JSON copiado a mano entre tres repos**:

- `lawalletio/mobile-pos` (LaPOS, el POS que se usa en los eventos) lo tiene hardcodeado en `src/constants/menus/*.json`
- `lawalletio/flutter-pos` replica el mismo esquema en `assets/menus/`
- `lacrypta/menu-lacrypta` tiene una tercera copia, y su README documenta el procedimiento: *"Si el menú cambia en `mobile-pos`, volvé a copiar esos archivos a `data/`"*

Acá el catálogo pasa a ser **datos del comerciante, portables, en nostr** — no un archivo en el git de alguien.

## Stack

Next.js 16 (App Router) · React 19 · TypeScript · Tailwind v4 · shadcn/ui · applesauce + nostr-tools

Requiere **Node 22** (ver `.nvmrc`): abajo de esa versión el `WebSocket` global no es estable y el lector de relays del servidor no arranca.

```bash
nvm use
npm install
npm run dev
```

### Variables de entorno

Todas opcionales: sin ninguna, el catálogo y la tienda funcionan igual. Van en `.env.local`.

| Variable | Para qué |
|---|---|
| `DATABASE_URL` | Postgres, **sólo** para cupones. Sin esto, `/api/coupons/*` responde 503 y el resto de la app anda igual. Es la conexión directa: con ella corren las migraciones. |
| `DATABASE_POOL_URL` | El pooler del mismo Postgres, si el proveedor da uno. La app lo prefiere para consultar: en serverless cada instancia abre su pool, y contra la conexión directa eso agota el límite (o ni conecta — en Supabase el host directo es sólo IPv6). |
| `COUPON_MANAGER_NSEC` | La identidad nostr de este servicio: firma los cupones que emite. Sin esto no se puede emitir ni canjear. |
| `NEXT_PUBLIC_APP_URL` | El origen público. En producción **conviene setearlo**: es lo único que hace que la validación NIP-98 ignore los headers `x-forwarded-*`, que cualquiera puede falsificar. |
| `SESSION_JWT_SECRET` | Firma los JWT de sesión, así el comerciante firma con nostr una vez por turno en vez de una vez por click. Sin esto se usa una clave por proceso: aceptable en una sola instancia, **hay que setearla con más de una** o los tokens de una los rechaza la otra. |
| `LN_PROXY_SECRET` | Firma los tokens del proxy LNURL. Sin esto se usa una clave por proceso y los pagos en vuelo se cortan en cada deploy. |

## Cómo se modela en nostr

| Kind | Uso |
|---|---|
| `30402` | Producto publicado ([NIP-99](https://github.com/nostr-protocol/nips/blob/master/99.md)) |
| `30403` | Lápida al borrar un producto. **No hay borradores**: todo lo que se publica es un 30402 vivo. |
| `30405` | Categoría ([GammaMarkets](https://github.com/GammaMarkets/market-spec/blob/main/spec.md), la extensión de e-commerce que el propio NIP-99 enlaza) |
| `5` | Borrado (NIP-09) |
| `0` · `10002` · `10063` | Perfil · relays NIP-65 · servidores Blossom |
| `30078` | Datos de la app (NIP-78): config de WooCommerce (cifrada) y endpoints de cupones (en claro) |
| `27235` | Autenticación HTTP (NIP-98). Se firma una vez por sesión y después va un JWT |
| `20402` | Cupón firmado por este servicio. Nunca se publica: viaja en la respuesta HTTP. |

Decisiones que no son obvias y conviene no revertir sin leer el porqué:

- **`d` es un uuid**, nunca derivado del título. Shopstr usa `sha256(nombre)` y renombrar huerfaniza el listing.
- **`t` manda sobre la pertenencia**, `a` sólo ordena dentro de la categoría. Así una colección perdida cuesta orden, nunca membresía.
- **`created_at` es estrictamente creciente por dirección.** NIP-01 desempata por id más bajo, y lo llama una convención que "las implementaciones pueden variar" — dos guardados en el mismo segundo pueden descartar tu edición sin avisar.
- **Al borrar va primero el kind 5 y después la lápida**, en `t+1`. NIP-09 borra todo hasta *e incluyendo* el `created_at` del kind 5, así que el orden intuitivo se come la lápida.
- **Las escrituras van a una cola en background.** Una vuelta NIP-46 tarda 3–15s; bloquear la UI haría que cargar cinco productos sea mirar una pantalla cinco minutos. Se firma de a uno: varios firmantes remotos descartan un `signEvent` concurrente.
- **`purplepag.es` entra sólo como lectura.** Rechaza los productos con `blocked: kind 30402 is not allowed`, y dejarlo en escritura haría que toda publicación se vea parcial.

## Cupones

Cinco tipos: **porcentaje**, **monto fijo** (ARS/USD/SAT), **NxM** (2x1, 3x2…), **comprá A, llevate B gratis**, y **producto gratis** (los productos y cantidades que elijas, sin comprar nada a cambio). Los tres primeros pueden limitarse a productos puntuales; sin productos elegidos valen para toda la compra.

El comerciante **activa el servicio** firmando un kind-30078 que dice dónde emitir y canjear. Ese evento es lo único que hace que una caja ajena pueda encontrar este servidor, y hasta que exista no se pueden crear cupones.

Es la única parte de la app con base de datos, y el motivo es corto: *"¿este cupón ya se usó?"* tiene que tener una sola respuesta en el instante en que dos cajas la preguntan, y los relays son consistentes-eventualmente por diseño.

📄 **[Documentación completa: `docs/cupones.md`](docs/cupones.md)** — los cuatro tipos y su aritmética, los dos eventos de nostr (anuncio y voucher), todos los endpoints con sus formas, NIP-98, y los flujos de punta a punta.

```bash
docker run -d --name merchant-pg -p 55432:5432 \
  -e POSTGRES_USER=merchant -e POSTGRES_PASSWORD=merchant -e POSTGRES_DB=merchant \
  postgres:17-alpine
```

```bash
DATABASE_URL=postgres://merchant:merchant@localhost:55432/merchant
COUPON_MANAGER_NSEC=nsec1…       # la identidad que firma los vouchers
NEXT_PUBLIC_APP_URL=http://localhost:4321
SESSION_JWT_SECRET=…             # opcional en una sola instancia
```

```bash
npm run db:generate   # después de tocar el schema
npm run db:migrate    # a mano; el deploy ya lo hace solo
```

`npm run build` corre las migraciones antes de compilar **si hay `DATABASE_URL`**, y
falla el build si no aplican: un deploy contra un esquema viejo rompe más callado.
Sin `DATABASE_URL` no migra nada y compila igual.

Sin esas variables la app arranca igual y los endpoints de cupones responden `503`: no tener base es un estado soportado.

## Interoperabilidad con el POS

`GET /api/pos/[handle]/{products,categories}` emite exactamente la forma que consume LaPOS.

**No es drop-in**: hay que tocar `mobile-pos`. `categories.json` es un import estático y los menús son un import dinámico con template literal — dos cambios distintos.

## Estado

El sitio son dos mitades: **`/admin/*` es el panel privado** —todo detrás del login— y el resto es público (`/` y la tienda en `/s/<npub o nip05>`).

Funciona: login (NIP-07 · bunker · QR), catálogo con categorías y productos anidados, alta/edición/borrado, ajustes de relays NIP-65 con sugerencias, tienda pública, avatares nostr y verificación NIP-05.

Falta: subida de imágenes con recorte a Blossom (hoy se pega una URL), tests del dominio, y el endpoint de cotizaciones ARS/USD/SAT.

## Licencia

MIT. La tipografía Standerd viene de [`lacrypta/branding`](https://github.com/lacrypta/branding) (MIT, © Peronio.AR).
