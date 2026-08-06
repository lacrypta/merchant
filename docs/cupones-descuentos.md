# Descuentos

Qué descuenta cada tipo de cupón y con qué reglas. Todo esto vive en [`src/lib/domain/coupon.ts`](../src/lib/domain/coupon.ts) y es **puro** — sin React, sin red, sin reloj. El servidor guarda estas formas en Postgres y la tienda las cotiza; los dos pasan por el mismo módulo, así que un descuento no puede significar una cosa en la caja y otra en la base.

Ver también: [la forma JSON exacta de cada tipo](./cupones-api.md#benefit), con ejemplos listos para copiar.

---

## Los cinco tipos

`Benefit` es una unión discriminada, no una bolsa de campos opcionales: "un 2x1 con porcentaje" no existe, y el sistema de tipos lo dice una vez acá en lugar de que cada llamador lo re-chequee.

| Tipo | Forma | Ejemplo |
|---|---|---|
| `percent` | `{ type, percent, productDs? }` | 10% de descuento |
| `fixed` | `{ type, amount, currency, productDs? }` | ARS 500 menos |
| `multibuy` | `{ type, buyQty, payQty, productDs? }` | 2x1, 3x2 |
| `buyXgetY` | `{ type, buyProductD, giftProductD }` | Comprá A, llevate B gratis |
| `freeItems` | `{ type, items: [{ d, qty }] }` | 2 cafés gratis |

Los cinco aceptan además un **`cap`** opcional. Ver [Tope de descuento](#tope-de-descuento).

`currency` es `ARS`, `USD` o `SAT`. En sats el monto tiene que ser **entero**: no se puede cobrar medio satoshi, y redondearlo en silencio haría que el cupón valga algo distinto de lo que dice.

### Límites

| Constante | Valor | Qué acota |
|---|---|---|
| `MAX_COUPON_NAME` | 80 | Caracteres del nombre |
| `MAX_COUPON_DESCRIPTION` | 500 | Caracteres de la descripción |
| `MAX_COUPON_IMAGE_URL` | 500 | Largo de la URL de imagen |
| `MAX_MULTIBUY_QTY` | 100 | `buyQty` y `payQty` |
| `MAX_FREE_QTY` | 100 | Unidades de un producto en `freeItems` |
| `MAX_COUPON_PRODUCTS` | 50 | Productos que un cupón puede nombrar |
| `MAX_COUPON_USES` | 1.000.000 | Emisiones por definición |

---

## Cuánto descuenta cada uno

Contra un carrito de **2 empanadas a ARS 100** y **1 café a ARS 250** (bruto: ARS 450):

| Cupón | Descuenta | Por qué |
|---|---|---|
| `percent` 10% | ARS 45 | 10% del subtotal de cada moneda |
| `percent` 10%, `cap` ARS 20 | ARS 20 | El tope corta antes |
| `fixed` ARS 500 | ARS 450 | Topeado al valor del carrito |
| `fixed` ARS 500 en café | ARS 250 | Topeado a lo que vale el café en el carrito |
| `multibuy` 2x1 en empanada | ARS 100 | Un grupo completo de 2 ⇒ 1 gratis |
| `buyXgetY` empanada → café | ARS 250 | Un regalo, siempre uno |
| `freeItems` 1 empanada + 1 café | ARS 350 | Las unidades regaladas, a su precio de línea |
| `freeItems` 3 empanadas | ARS 200 | Sólo hay 2 en el carrito: se regalan 2 |

---

## Alcance por producto

Los tres primeros aceptan `productDs`: una lista de `d` de productos (los UUID que esta app genera para cada NIP-99).

**Ausente significa todos.** Ese default es la mitad importante: alguien que ofrece "10% off" quiere decir la tienda entera, y obligarlo a tildar el catálogo completo para decirlo sería un peor sistema de cupones. Una lista vacía se normaliza a ausente — quien limpió el picker quiso decir "todos", no "ninguno".

Con lista:

- **`percent`** se calcula sólo sobre esas líneas.
- **`fixed`** se topea en lo que valen esas líneas *en la moneda del cupón*. "ARS 500 en café" contra un carrito con ARS 200 de café y ARS 5000 de otras cosas descuenta 200. Sin ese tope, un cupón acotado terminaría descontando el resto del carrito.
- **`multibuy`** se cuenta por línea: con varios productos, cada uno suma por su cuenta. "2x1 en cualquiera de estos tres" son tres promos independientes, no una compartida.

`buyXgetY` no lleva `productDs` porque ya nombra sus dos productos. `A === B` es legal y equivale a un 2x1.

> **Compatibilidad:** `parseBenefit` todavía acepta `productD` en singular. Los cupones emitidos guardan su beneficio como snapshot congelado, y las filas escritas antes de que el alcance fuera una lista tienen que seguir parseando — si no, un 2x1 que alguien tiene en el teléfono dejaría de funcionar.

---

## Tope de descuento

Cualquiera de los cinco acepta un **`cap`** opcional:

```jsonc
{ "type": "percent", "percent": 20, "cap": { "amount": 5000, "currency": "ARS" } }
```

Es "20% de descuento, hasta ARS 5.000", y es lo que hace que un porcentaje se pueda repartir sin miedo — sin tope, un solo carrito grande se lleva puesto todo el presupuesto de la promo.

Va en **todos** los tipos a propósito: un 2x1 sobre un cajón de vino y un producto gratis caro necesitan el mismo freno, y tenerlo sólo en `percent` sería un agujero arbitrario. Se intersecta sobre la unión en vez de repetirse en cada miembro — escribirlo cinco veces es cómo el sexto tipo termina sin él.

Reglas:

- **Acota la entrada de su propia moneda y deja el resto.** La misma regla que ya sigue `fixed`, y por el mismo motivo: convertir necesitaría la tabla de cotizaciones que esa capa deliberadamente no toma, y adivinar un número es peor que aplicar el techo donde fue escrito. Todo carrito real es de una sola moneda, donde esto es exactamente "hasta ARS 5.000".
- **En el libro de órdenes se reparte escalado** entre las líneas (`discountByLine`), no cortado de la primera: el techo es una propiedad del descuento entero, y descontárselo a un producto en particular reportaría que ese producto absorbió un recorte que no tuvo.
- **`0` no es un tope**, es "sin tope". Un techo en cero sería un cupón que no descuenta nada, que nadie escribe a propósito.
- En sats tiene que ser **entero**, igual que `fixed`.

Ejemplo del reparto escalado: un 50% con tope de ARS 500 contra dos líneas de ARS 3.000 y ARS 1.000 daría 1.500 y 500 sin tope; con tope da **375 y 125** — la misma proporción sobre 500.

---

## Producto gratis (`freeItems`)

El único beneficio **sin condición de compra**: el cupón *es* el producto. Se elige una lista de productos con su cantidad — `[{ d, qty }]` — y esas unidades salen del total.

Es la excepción a la regla de "ausente significa todos", y a propósito: **acá la lista vacía no significa "todos"**, significa que el cupón es inválido. En los otros tipos "todos" es un descuento sobre la tienda; en este sería regalar el catálogo, que no es algo que alguien quiera decir sin querer.

`parseBenefit` rechaza:

- la lista vacía (`elegí al menos un producto`),
- un producto repetido — dos entradas del mismo café podrían ser 2 o 5, y adivinar cuál es peor que pedir que lo escriban una vez,
- cantidades fuera de 1..`MAX_FREE_QTY`.

Dos reglas que caen de que igual hay que tener el producto en el carrito:

- **Se topea contra el carrito.** Un cupón por 3 cafés contra un carrito con 1 regala 1. Nunca descuenta unidades que no están.
- **Se aplica producto por producto.** Si el cupón da 1 empanada y 2 cafés, y en el carrito hay sólo empanada, la empanada sale gratis igual. Por eso `unmet.anyOf` es `true`: alcanza con cualquiera de los productos para que el cupón haga algo, y la tienda dice "agregá alguno de estos" en vez de exigir la lista completa.

La diferencia con `buyXgetY` es la condición: aquel exige que el producto pagado esté en el carrito y regala **uno**; este no exige nada y regala **las cantidades que dice**.

---

## Reglas de la aritmética

Viven en `priceCart()` y son las que evitan cobrar mal:

- **El redondeo pasa una sola vez, sobre el carrito ya descontado.** Es la regla de [`rates.ts`](../src/lib/domain/rates.ts): un total es el techo de la suma, nunca la suma de los techos. Por eso el descuento se aplica **escalando** cada subtotal por el mismo factor en vez de restar de una moneda — en un carrito mixto, restar de la fila en ARS dejaría el desglose sin sumar al total en sats.
- **El tope se aplica antes que todo lo demás.** `discountEntries` ya devuelve la entrada acotada, así que la conversión a sats y el clamp contra el valor del carrito trabajan sobre el número que el cupón realmente promete.
- **Se puede llegar a cero.** `MIN_CHARGE_SATS` es 0. Una factura de cero sats sigue sin ser pagable — las billeteras la rechazan y LNURL declara un `minSendable` de al menos 1 — así que un total en cero **no genera factura**: el checkout cambia "Generar factura" por **"Reclamar"** y el canje del cupón pasa a ser el registro del pedido. Ver [Flujos § 3](./cupones-flujos.md#3-canje-en-la-tienda-de-esta-misma-app).
- **Un descuento que no se puede convertir no se adivina.** Si falta la cotización de una moneda, el cupón no aplica y se dice por qué.

### Cuando el cupón no aplica

`priceCart` devuelve `unmet` con el motivo:

| `unmet.kind` | Significa | Qué dice la tienda |
|---|---|---|
| `empty-cart` | No hay nada en el carrito | "Agregá productos para usar el cupón" |
| `unquotable` | Falta la cotización de una moneda | "No pudimos convertir USD a sats todavía" |
| `needs-products` | Faltan los productos que el cupón nombra | "Te falta agregar 2 × Café" |

`needs-products` trae además `anyOf`, que distingue "alcanza con uno de estos" (porcentaje o monto acotados, y `freeItems`) de "hacen falta los dos" (`buyXgetY`). Unir las dos con "y" convertiría en silencio la primera en la segunda.

### Imputación por línea

`discountEntries` contesta *cuánto, por moneda* — que es todo lo que el checkout necesita, porque cobra un solo total. El libro de órdenes necesita la otra mitad: `discountByLine` reparte ese mismo descuento entre **las líneas de las que realmente salió**.

Un cupón de una cerveza gratis se llevó el precio de una cerveza, no una tajada de cada línea. Repartirlo proporcionalmente deja a cada producto del carrito con una facturación que nunca tuvo — y el "Reporte por producto" de `/admin/orders` sale mal para todos.

| Tipo | Cómo se reparte |
|---|---|
| `multibuy`, `buyXgetY`, `freeItems` | Unidades enteras del producto nombrado. El único reparto honesto |
| `percent` | El porcentaje sobre cada línea alcanzada |
| `fixed` | Proporcional, y **sólo** sobre las líneas de su alcance y su moneda — una suma global genuinamente no tiene línea dueña |
