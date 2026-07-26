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

## Cómo se modela en nostr

| Kind | Uso |
|---|---|
| `30402` | Producto publicado ([NIP-99](https://github.com/nostr-protocol/nips/blob/master/99.md)) |
| `30403` | Borrador, y lápida al borrar |
| `30405` | Categoría ([GammaMarkets](https://github.com/GammaMarkets/market-spec/blob/main/spec.md), la extensión de e-commerce que el propio NIP-99 enlaza) |
| `5` | Borrado (NIP-09) |
| `0` · `10002` · `10063` | Perfil · relays NIP-65 · servidores Blossom |

Decisiones que no son obvias y conviene no revertir sin leer el porqué:

- **`d` es un uuid**, nunca derivado del título. Shopstr usa `sha256(nombre)` y renombrar huerfaniza el listing.
- **`t` manda sobre la pertenencia**, `a` sólo ordena dentro de la categoría. Así una colección perdida cuesta orden, nunca membresía.
- **`created_at` es estrictamente creciente por dirección.** NIP-01 desempata por id más bajo, y lo llama una convención que "las implementaciones pueden variar" — dos guardados en el mismo segundo pueden descartar tu edición sin avisar.
- **Al borrar va primero el kind 5 y después la lápida**, en `t+1`. NIP-09 borra todo hasta *e incluyendo* el `created_at` del kind 5, así que el orden intuitivo se come la lápida.
- **Las escrituras van a una cola en background.** Una vuelta NIP-46 tarda 3–15s; bloquear la UI haría que cargar cinco productos sea mirar una pantalla cinco minutos. Se firma de a uno: varios firmantes remotos descartan un `signEvent` concurrente.
- **`purplepag.es` entra sólo como lectura.** Rechaza los productos con `blocked: kind 30402 is not allowed`, y dejarlo en escritura haría que toda publicación se vea parcial.

## Interoperabilidad con el POS

`GET /api/pos/[handle]/{products,categories}` emite exactamente la forma que consume LaPOS.

**No es drop-in**: hay que tocar `mobile-pos`. `categories.json` es un import estático y los menús son un import dinámico con template literal — dos cambios distintos.

## Estado

Funciona: login (NIP-07 · bunker · QR), catálogo con categorías y productos anidados, alta/edición/borrado, ajustes de relays NIP-65 con sugerencias, tienda pública en `/s/<npub o nip05>`, avatares nostr y verificación NIP-05.

Falta: subida de imágenes con recorte a Blossom (hoy se pega una URL), tests del dominio, y el endpoint de cotizaciones ARS/USD/SAT.

## Licencia

MIT. La tipografía Standerd viene de [`lacrypta/branding`](https://github.com/lacrypta/branding) (MIT, © Peronio.AR).
