# Datos

Cuatro tablas, en [`src/lib/server/db/schema.ts`](../src/lib/server/db/schema.ts). Es la única parte de la app con Postgres, y el [por qué](./cupones.md#por-qué-hay-una-base-de-datos) está en la portada.

Los pubkeys se guardan siempre como **hex de 64 caracteres en minúscula**. `npub` es una codificación de display y nunca una clave acá, igual que en `nip05.ts`.

---

## `coupon_definitions`

Lo que el comerciante escribió: un cupón que se puede emitir N veces.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `owner_pubkey` | `varchar(64)` | Indexado. El dueño |
| `name` | `varchar(80)` | |
| `description` | `varchar(500)` | `''` cuando no tiene |
| `image_url` | `varchar(500)` | https, o null |
| `type` | `coupon_type` | `percent \| fixed \| multibuy \| buy_x_get_y \| free_items` |
| `percent` | `integer` | 1..100. Sólo `percent` |
| `amount` | `numeric(14,2)` | Sólo `fixed`. **pg lo devuelve como string** |
| `currency` | `varchar(3)` | Sólo `fixed` |
| `buy_qty` / `pay_qty` | `integer` | Sólo `multibuy` |
| `product_ds` | `jsonb` | El alcance. Null ⇒ todos los productos |
| `buy_product_d` / `gift_product_d` | `uuid` | Sólo `buy_x_get_y` |
| `free_items` | `jsonb` | `[{ d, qty }]`. Nunca null para ese tipo |
| `cap_amount` / `cap_currency` | `numeric(14,2)` / `varchar(3)` | El tope. **Ambas nulas o ambas puestas** |
| `max_uses` | `integer` | Null ⇒ ilimitado |
| `minted_count` | `integer` | Ver abajo |
| `expires_at` | `timestamptz` | Frena emisión **y** canje |
| `archived_at` | `timestamptz` | Frena **sólo** la emisión |
| `created_at` / `updated_at` | `timestamptz` | |

Una fila, como la lee `psql`:

```
id            | 55b5ee4f-4dcc-4a6a-a58e-6d1d94d811a3
owner_pubkey  | 2ad91f1dca2dcd5fc89e7208d1e5059f0bac0870d63fc3bac21c7a9388fa18fd
name          | 20% de verano
description   | No acumulable.
image_url     | https://blossom.example/9f3c.webp
type          | percent
percent       | 20
amount        |
currency      |
buy_qty       |
pay_qty       |
product_ds    |
cap_amount    | 5000.00
cap_currency  | ARS
max_uses      | 100
minted_count  | 12
expires_at    | 2025-12-02 00:00:00+00
archived_at   |
```

Esa fila es el `DefinitionJson` del [ejemplo de la API](./cupones-api.md#definitionjson).

### Por qué columnas tipadas y no un jsonb

El beneficio vive en **columnas tipadas y anulables**, no en un blob único: así la tabla se lee, se indexa y se corrige con SQL a mano cuando algo se rompe a las 3 de la mañana. `parseBenefit` en la capa de dominio es lo que garantiza que para cada `type` esté poblado el subconjunto correcto.

Las dos excepciones son listas, y por eso son jsonb: `product_ds` (el alcance) y `free_items` (los `{ d, qty }` que se regalan). Son columnas distintas a propósito — una **acota** un descuento y la otra **es** el descuento, y compartirlas obligaría a mirar `type` antes de saber cuál de las dos cosas estás leyendo.

### `minted_count`

Se incrementa **adentro del UPDATE guardado que emite**, que es lo que hace que el tope se sostenga bajo concurrencia. Contar filas en `coupon_mints` sería una carrera.

Anular una emisión lo **decrementa**: el lugar vuelve al máximo, porque "esta emisión nunca pasó" es exactamente lo que significa anular.

### `expires_at` vs `archived_at`

`archived_at` frena **sólo las emisiones nuevas**; lo que ya está en la calle se sigue canjeando, porque fue una promesa que el comerciante hizo. Para cortar lo que está afuera se pone `expires_at` en el pasado — por eso `PATCH` acepta una fecha pasada y `POST` no.

---

## `coupon_mints`

Cada emisión. El nonce es la credencial al portador.

| Columna | Tipo | Notas |
|---|---|---|
| `id` | `uuid` PK | |
| `definition_id` | `uuid` FK | `ON DELETE RESTRICT` |
| `nonce` | `varchar(32)` | **Único**. 22 chars base64url |
| `benefit` | `jsonb` | El **snapshot congelado** al emitir |
| `minted_by_pubkey` | `varchar(64)` | Quién la emitió |
| `minted_at` | `timestamptz` | |
| `status` | `coupon_mint_status` | `minted \| claimed \| voided` |
| `claimed_at` / `voided_at` | `timestamptz` | |
| `order_event` | `jsonb` | El kind-9734 firmado, verbatim |
| `order_id` | `varchar(64)` | **Indexado.** `order_event.id` |
| `amount_msat` | `integer` | Lo que se iba a cobrar. `0` ⇒ reclamada |

Índices: `nonce` único, `(definition_id, status)` para la lista del modal, `order_id` para responder "¿qué cupón pagó la orden X?" sin escanear jsonb.

### Por qué el beneficio se congela

Editar un cupón cambia la definición, pero el voucher que el manager ya firmó dice otra cosa. El canje sirve el snapshot, así que **un cupón en el teléfono de alguien vale lo que decía cuando se lo dieron**.

### La orden cuelga del canje

Porque no hay otra tabla donde ponerla. Todo lo demás vive en relays, y una orden pagada se reconstruye de su zap receipt — pero un cupón que lleva el total a cero no produce factura y por lo tanto tampoco recibo.

Las tres columnas son anulables: un cupón canjeado en el mostrador no pasó por ningún checkout, y tampoco lo hizo nada canjeado antes de que la app empezara a archivarlas.

Se escriben **en el mismo UPDATE que canjea**, así que una fila no puede quedar canjeada sin la orden que la canjeó, y el segundo llamador —que por definición perdió la carrera— no puede pisar la orden del primero.

### `RESTRICT`, no `CASCADE`

La ruta de borrado archiva una definición que tiene emisiones y borra en duro sólo una intacta. Con `RESTRICT`, "la definición desapareció entre la emisión y el canje" es imposible por construcción y no por convención.

---

## `coupon_minters`

Quién puede emitir a nombre de quién.

| Columna | Tipo | Notas |
|---|---|---|
| `owner_pubkey` | `varchar(64)` | PK compuesta |
| `minter_pubkey` | `varchar(64)` | PK compuesta |
| `label` | `varchar(80)` | "Caja 2". Opcional |
| `created_at` | `timestamptz` | |

Índice extra por `minter_pubkey`: es la búsqueda de `GET /api/coupons/mintable` — *"¿qué dueños me dejan emitir a mí?"*.

**El dueño nunca es una fila acá.** Su derecho a emitir sus propios cupones es implícito, y guardarlo dejaría la UI mostrándole al comerciante como uno de sus propios empleados.

---

## `coupon_discovery`

El anuncio firmado del comerciante, tal cual.

| Columna | Tipo | Notas |
|---|---|---|
| `owner_pubkey` | `varchar(64)` PK | Una fila por comerciante |
| `event` | `jsonb` | El `SignedEvent` completo |
| `event_created_at` | `integer` | El `created_at` propio del evento |
| `updated_at` | `timestamptz` | |

Guardar el evento **firmado** da dos cosas que un viaje a los relays no puede: la página sabe que está activada apenas carga, y re-publicarlo no necesita una firma nueva, porque los bytes que publicaríamos son los que ya tenemos.

`event_created_at` está aparte para que una copia vieja no pueda pisar una más nueva. Kind 30078 es addressable, así que sólo hay un anuncio vigente por `d`.

---

## Migraciones

En [`drizzle/`](../drizzle/), aplicadas en el build. Las de este subsistema:

| Migración | Qué agregó |
|---|---|
| `0000` | `coupon_definitions`, `coupon_mints`, `coupon_minters` |
| `0001` | `coupon_discovery` |
| `0002`–`0005` | El alcance por lista (`product_ds`), `voided_at`, `free_items` |
| `0006` | `order_event`, `order_id`, `amount_msat` en `coupon_mints` |
| `0007` | `cap_amount`, `cap_currency` en `coupon_definitions` |

Las dos últimas son `ADD COLUMN` anulables: no reescriben filas y no rompen nada de lo que ya estaba emitido.
