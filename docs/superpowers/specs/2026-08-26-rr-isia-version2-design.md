# Diseño: workflow `rr-isia-version2`

**Fecha:** 2026-08-26
**Estado:** Aprobado

## Problema

El workflow de WhatsApp que hoy corre en Kapso (`Rayo Perez`, id `155d9b86-f1f6-42cb-b40e-e623321d7a58`) cotiza **solo contra Intcomex**: `buscar-productos` pega a `/search` y `generar-cotizacion` a `/price?provider=intcomex`. La API de este repositorio ya expone `/mejor-precio`, que compara los tres mayoristas (Intcomex, Tecnoglobal, Ingram) y devuelve quién vende más barato.

Además, hoy el flujo termina en un correo interno con la cotización. No emite órdenes de compra, y por lo tanto nadie sabe —sin recalcularlo a mano— a qué mayorista hay que comprarle cada producto.

`rr-isia-version2` rehace el flujo completo aprovechando `/mejor-precio` y cierra el ciclo emitiendo **una orden de compra por mayorista**.

## Alcance

**Incluido:**

- Workflow nuevo en Kapso llamado `rr-isia-version2`, independiente de `Rayo Perez` (que queda intacto y activo).
- Cuatro nodos de agente: descubrimiento, presentación, facturación, cierre.
- Functions nuevas: `buscar-productos-v2`, `generar-cotizacion-v2`, `check-quote-validity-v2`, `route-quote-decision-v2`, `route-rut-v2`, `emitir-ordenes-compra`.
- Margen de venta **13%** (`MARGEN=0.13` en los secretos de las functions nuevas).
- Emisión de órdenes de compra agrupadas por mayorista, por correo interno, idempotentes.
- Prompts versionados en el repositorio, con el mismo formato que los de v1.

**Fuera de alcance:**

- Método de pago y crédito. Se asume **contado up front**, no se pregunta ni se registra.
- Recuperación de rechazo (el `agent_n4` de v1 y su `route-rejection` de siete salidas).
- Rama "lo estoy pensando" (`notify-pending-quote`).
- Enviar las órdenes de compra a los mayoristas. Van a la casilla interna; el humano las cursa.
- Búsqueda federada en los tres catálogos. El descubrimiento usa Intcomex como índice.
- Tipo de cambio en vivo. Sigue siendo una variable de entorno.

## Decisiones tomadas

### El descubrimiento usa Intcomex como índice

`/search` (texto libre) es por catálogo, y `/mejor-precio` necesita un MPN. El agente busca en Intcomex —el catálogo más completo y el único con facetas cargadas— y de ahí saca `mpn` + `marca`, que son la llave para comparar.

Consecuencia aceptada: **el precio que el cliente ve durante la búsqueda puede bajar en la cotización final**, si Ingram o Tecnoglobal tienen ese MPN más barato. Nunca sube: el ganador es por definición el más barato de los tres. Un producto que Intcomex no lista es invisible en el descubrimiento, aunque otro mayorista lo tenga.

La alternativa (fan-out a los tres `/{proveedor}/search` y fusionar por MPN) triplica la latencia de cada búsqueda y obliga a deduplicar en la function; se descartó por ahora.

### El mayorista ganador se congela en la cotización

`generar-cotizacion-v2` estampa en cada línea el `proveedor` ganador y el `sku` con que **ese** proveedor identifica el producto. La orden de compra después es un `group by proveedor` sobre las líneas: no vuelve a consultar precios.

Esto garantiza que lo que se compra es exactamente lo que el cliente aceptó. El riesgo —que el precio del mayorista se mueva entre la aceptación y la compra— lo acota `check-quote-validity-v2`: pasadas 3 horas la cotización se recalcula antes de emitir nada.

### Los costos nunca entran en una variable del workflow

En v1 el LLM nunca recibe el costo, y eso se mantiene. `quote_result` lleva solo precios de **venta**. `emitir-ordenes-compra` reconstruye el costo dividiendo por `(1 + MARGEN)`, con los mismos secretos que lo calcularon. Así el costo no vive en ninguna variable que un `get_variable` pueda leer.

El `proveedor` sí queda en `quote_result` (la function lo necesita aguas abajo). Los prompts prohíben explícitamente nombrarle el mayorista al cliente.

### El cierre va antes de la emisión

En v1 `send-quote-request-email` corre **antes** de `agent_main`, así que el correo sale antes de que el cliente confirme y antes de que el agente escriba `quote_summary`. En v2 el orden es el correcto: `agente_cierre` confirma, y recién entonces `emitir-ordenes-compra`.

## Arquitectura

```
Cliente (WhatsApp)
   ↓
Agente LLM en Kapso            ← nunca ve costos ni márgenes
   ↓ tool call
Kapso Function                 ← el margen de 13% vive aquí
   ↓ HTTP + x-api-key
https://api.pyxis-latam.cl/rr/captador-precios
   ├ GET /search                  descubrimiento (Intcomex)
   └ GET /mejor-precio?mpn&marca  cotización (3 mayoristas)
```

### El grafo

```
start
  └→ agente_descubrimiento ──→ fn_cotizar ──→ agente_presentacion ──→ route_decision
                                   ↑                                      │
                                   │                          ┌───────────┴───────────┐
                                   │                    rejected                  accepted
                                   │                          │                       │
                                   │                          └──→ agente_descubrimiento
                                   │                                                  │
                                   │                                        agente_facturacion ←──┐
                                   │                                                  │           │
                                   │                                          fn_validar_rut      │
                                   │                                                  │           │
                                   │                                             route_rut ───────┘
                                   │                                                  │  invalid
                                   │                                                  │ valid
                                   │                                        fn_check_validity
                                   │                                         │              │
                                   └───────────────── expired ───────────────┘            valid
                                                                                            │
                                                                                     agente_cierre
                                                                                            │
                                                                                   fn_emitir_ordenes
                                                                                            │
                                                                                    send_confirmacion
                                                                                            │
                                                                                       handoff_fin
```

13 nodos. Identificadores tal como van en la API (`^[A-Za-z][A-Za-z0-9_-]*$`):

| id | node_type | Rol |
|---|---|---|
| `start` | start | Entrada |
| `agente_descubrimiento` | agent | Entiende la necesidad, busca, arma el carro |
| `fn_cotizar` | function | `generar-cotizacion-v2` |
| `agente_presentacion` | agent | Presenta la cotización, captura la decisión |
| `route_decision` | decide | `route-quote-decision-v2`: `accepted` / `rejected` |
| `agente_facturacion` | agent | RUT y datos tributarios. Sin método de pago |
| `fn_validar_rut` | function | `validar-rut` (reutilizada de v1) |
| `route_rut` | decide | `route-rut-v2`: `valid` / `invalid` |
| `fn_check_validity` | decide | `check-quote-validity-v2`: `valid` / `expired` |
| `agente_cierre` | agent | Resumen final y confirmación explícita |
| `fn_emitir_ordenes` | function | `emitir-ordenes-compra` |
| `send_confirmacion` | send_text | Mensaje fijo de cierre |
| `handoff_fin` | handoff | Deriva al equipo comercial |

Aristas (15):

```
start                → agente_descubrimiento        [next]
agente_descubrimiento→ fn_cotizar                   [next]
fn_cotizar           → agente_presentacion          [next]
agente_presentacion  → route_decision               [next]
route_decision       → agente_facturacion           [accepted]
route_decision       → agente_descubrimiento        [rejected]
agente_facturacion   → fn_validar_rut               [next]
fn_validar_rut       → route_rut                    [next]
route_rut            → fn_check_validity            [valid]
route_rut            → agente_facturacion           [invalid]
fn_check_validity    → agente_cierre                [valid]
fn_check_validity    → fn_cotizar                   [expired]
agente_cierre        → fn_emitir_ordenes            [next]
fn_emitir_ordenes    → send_confirmacion            [next]
send_confirmacion    → handoff_fin                  [next]
```

## Componentes

### `buscar-productos-v2`

Igual a `buscar-productos` de v1 salvo dos cosas: `MARGEN=0.13`, y **devuelve `mpn` y `marca`** en cada producto. La v1 los descarta, y sin ellos no se puede llamar a `/mejor-precio`.

Entrada (tool schema del agente): `q` (requerido), `marca`, `categoria`, `precio_max`, `limite` (1-8, default 5).

Salida: `{ estado, total, mostrados, productos: [{ sku, mpn, marca, nombre, categoria, precio, moneda, disponible }], rango_precio? }`. `precio` es venta (costo × 1.13) e **indicativo**: sale de Intcomex.

Estados heredados de v1: `demasiado_amplio` (409, con `opciones.marcas` y `opciones.categorias`), `no_disponible` (503), `error`.

### `generar-cotizacion-v2`

Lee `cart_items` del contexto de ejecución. Cada ítem: `{ mpn, marca, sku, nombre, cantidad }`.

Por cada línea:

1. `GET /mejor-precio?mpn=<mpn>&marca=<marca>`.
2. **409 `ambiguo`** → reintenta una vez con la primera marca de `marcas`. Si vuelve a fallar, cae al paso 4.
3. **200** → toma `mejor`: `proveedor`, `sku`, `precio` (costo USD), `stock`, y `criterio`.
4. **404 / 502 / 503, o sin `mpn` en el ítem** → *fallback*: `GET /mejor-precio?proveedor=intcomex&sku=<sku>`. La línea queda marcada `comparacion: "fallback_intcomex"`.
5. Si el fallback también falla → la cotización entera responde `{ estado: "producto_no_disponible", sku }` y no se emite. Es el mismo comportamiento de v1: mejor no cotizar que cotizar mal.

Cálculo por línea, idéntico a v1 salvo el origen del costo:

```
precio_unitario_usd = round(costo × 1.13, 2)
precio_unitario_clp = round(precio_unitario_usd × TIPO_CAMBIO_CLP_USD)
subtotal_neto_clp   = precio_unitario_clp × cantidad
```

Totales: `neto_clp` = suma de subtotales, `iva_clp` = `round(neto × 0.19)`, `total_clp` = neto + IVA.

Forma de cada línea en `quote_result`:

```json
{
  "mpn": "ERC-38B",
  "marca": "Epson",
  "nombre": "Cinta Epson ERC-38B",
  "cantidad": 2,
  "proveedor": "ingram",
  "sku_proveedor": "AR155EPS14",
  "precio_unitario_usd": 12.43,
  "precio_unitario_clp": 11809,
  "subtotal_neto_clp": 23618,
  "disponible": true,
  "abastecimiento": "stock_inmediato",
  "comparacion": "completa",
  "ofertas_consideradas": 3,
  "ahorro_vs_peor_clp": 4300
}
```

`ofertas_consideradas` es el largo de `ofertas` que devolvió la API. `ahorro_vs_peor_clp` es la diferencia entre la oferta más cara y la ganadora, ya con margen aplicado, convertida a CLP y multiplicada por la cantidad: `round((peor − mejor) × 1.13 × TIPO_CAMBIO) × cantidad`. Es cero cuando participó un solo proveedor. `ahorro_total_clp` de la cabecera es la suma de las líneas.

`comparacion` es `"completa"` (participaron todos los proveedores registrados), `"parcial"` (`incompleta` de la API trae entradas) o `"fallback_intcomex"`. **No hay ningún campo de costo.**

Cabecera de la cotización: `quote_id` (uuid), `version`, `moneda: "CLP"`, `tipo_cambio_clp_usd`, `iva_rate`, `lineas`, `neto_clp`, `iva_clp`, `total_clp`, `ahorro_total_clp`, `proveedores_incompletos` (lista de nombres, vacía en el caso normal), `created_at`, `valid_until`.

Escribe: `quote_result`, `quote_id`, `quote_version`, `quote_total_clp`, `quote_valid_until`.

### `check-quote-validity-v2`

Decide sobre `quote_result.valid_until`: `valid` si `Date.now() < valid_until`, `expired` si no. Clon del de v1 para no acoplar los dos workflows.

### `route-quote-decision-v2`

Decide sobre `quote_decision`: `accepted` / `rejected`. Cualquier otro valor rutea a `rejected` (volver a descubrimiento es recuperable; emitir órdenes no).

### `route-rut-v2`

Decide sobre `rut_valid` (la escribe `validar-rut`): `valid` solo si es exactamente `true`, `invalid` en cualquier otro caso, incluido que no exista.

**No se puede reutilizar el `route-rut` de v1.** Ese devuelve `valid` salvo que `factura === true` *y* `rut_valid !== true`; como v2 nunca setea `factura`, dejaría pasar cualquier RUT inválido. `validar-rut` sí se reutiliza tal cual: es pura y ya está desplegada.

### `emitir-ordenes-compra`

El componente nuevo. Lee `quote_result` y los datos de facturación.

1. **Agrupa** `quote_result.lineas` por `proveedor`. N proveedores distintos → N órdenes.
2. Para cada grupo, reconstruye el costo: `costo_unitario_usd = round(precio_unitario_usd / 1.13, 2)`, y el total de la orden en USD.
3. **Idempotencia**: `CREATE TABLE IF NOT EXISTS purchase_orders (order_key TEXT PRIMARY KEY, po_id TEXT, quote_id TEXT, quote_version TEXT, proveedor TEXT, status TEXT, email_id TEXT, error TEXT, created_at TEXT, updated_at TEXT)` en D1. La clave es `${quote_id}:${version}:${proveedor}`, y el `INSERT` que choca contra la primary key es la señal de duplicado (mismo patrón que `send-quote-request-email`).
4. **Envía un correo por proveedor** vía Resend a la casilla interna, con asunto `OC <po_id> · <PROVEEDOR> · cotización <quote_id>`. Cuerpo: líneas con SKU **de ese proveedor**, MPN, cantidad, costo unitario y total USD; más el cliente, su RUT y razón social, y la nota de que el pago es contado.
5. **Fallo parcial**: si un correo falla, esa fila queda `failed` y las demás igual se envían. La function responde `ok: true` con el detalle por proveedor. Un reintento (misma cotización y versión) reenvía solo las `failed`.

Escribe: `purchase_orders_result` (resumen por proveedor: `proveedor`, `po_id`, `status`, `lineas`), `purchase_orders_count`, `purchase_orders_ok` (booleano: todas enviadas).

> **Corrección posterior (revisión final, 2026-08-26).** El borrador de esta sección incluía `total_usd` en `purchase_orders_result`, y eso contradice la invariante de más arriba: `total_usd` es la suma de los costos reconstruidos, y `purchase_orders_result` es una variable del workflow que cualquier agente puede leer con `get_variable`. Se sacó del resumen —y del cuerpo de la respuesta, porque el nodo lo guarda entero en `purchase_orders_response`— y se quedó donde corresponde, en el correo de la orden de compra.

Si `quote_result` no existe, o `quote_confirmed` no es `true` (se acepta el booleano `true` y la cadena `"true"`, porque esa variable la escribe el LLM), responde 400 sin emitir nada. Y si la cotización ya expiró, responde 409: `fn_check_validity` corre **antes** de `agente_cierre`, que es una conversación sin límite de tiempo, así que la vigencia se vuelve a revisar aquí, que es el último punto antes de emitir.

### Los cuatro agentes

Prompts nuevos, versionados en `docs/kapso/prompts-v2/<agente>/v-01.md` con el mismo formato que v1 (cabecera con nodo/estado/fecha, texto desplegable entre `<!-- PROMPT:INICIO -->` y `<!-- PROMPT:FIN -->`). El estilo —silencio operativo, WhatsApp chileno, nunca inventar precios— se hereda de los prompts vigentes de v1.

| Agente | Lee | Escribe | Tools |
|---|---|---|---|
| `agente_descubrimiento` | `cart_items` | `cart_items` | `buscar-productos-v2`, `save_variable`, `complete_task`, `handoff_to_human` |
| `agente_presentacion` | `quote_result` | `quote_decision` | `save_variable`, `complete_task`, `handoff_to_human` |
| `agente_facturacion` | `quote_result`, `rut_validation_response` | `billing_rut`, `billing_razon_social`, `billing_giro`, `billing_direccion`, `billing_comuna`, `billing_ciudad`, `billing_email` | `save_variable`, `complete_task`, `handoff_to_human` |
| `agente_cierre` | todo el contexto | `quote_summary`, `quote_customer_name`, `quote_customer_phone`, `quote_confirmed` | `save_variable`, `get_whatsapp_context`, `complete_task`, `handoff_to_human` |

Reglas específicas de v2 que van en los prompts:

- **`agente_descubrimiento`** debe guardar `mpn` y `marca` en cada ítem de `cart_items`, no solo el `sku`. Sin eso no hay comparación entre mayoristas. Y nunca menciona al mayorista.
- **`agente_presentacion`** presenta el total en CLP con IVA. Si `ahorro_total_clp > 0`, puede decir que se buscó el mejor precio disponible, **sin nombrar mayoristas ni montos de costo**. Si `comparacion` de alguna línea es `parcial` o `fallback_intcomex`, no lo menciona: es ruido interno.
- **`agente_facturacion`** pregunta los siete campos **en bloque**, no de a uno (la lección de v1). No pregunta forma de pago.
- **`agente_cierre`** muestra el resumen y pide una confirmación explícita. Solo escribe `quote_confirmed: true` con un sí inequívoco: es el último punto reversible antes de emitir órdenes de compra.

### Secretos de las functions

`API_PRECIOS_KEY`, `MARGEN=0.13`, `TIPO_CAMBIO_CLP_USD`, `IVA_RATE=0.19`, `COTIZACION_VALID_HOURS=3`, `RESEND_API_KEY`, `RESEND_FROM_EMAIL`, y el binding D1 (`env.DB`) para `emitir-ordenes-compra`.

`MARGEN` es **por function**: las de v1 siguen en `0.30` y no se tocan.

## Manejo de errores

| Situación | Comportamiento |
|---|---|
| `/mejor-precio` 409 `ambiguo` | Un reintento con `marca` de la respuesta. |
| `/mejor-precio` 404 / 502 / 503 | Fallback a `proveedor=intcomex&sku=`. Línea marcada `fallback_intcomex`. |
| Fallback también falla | `estado: producto_no_disponible`; no se cotiza. |
| `incompleta` no vacío | Se cotiza igual. `proveedores_incompletos` viaja a la cotización y aparece en el correo de la OC. |
| Cotización expirada al emitir | `fn_check_validity` rutea a `fn_cotizar`; el cliente vuelve a ver y aceptar. |
| Un correo de OC falla | Fila `failed`, el resto se envía, respuesta con el detalle. Reintento reenvía solo esa. |
| Reejecución de `fn_emitir_ordenes` | Idempotente por `quote_id:version:proveedor`; responde `duplicate: true`. |
| `quote_confirmed` distinto de `true` | 400, no se emite nada. |

## Testing

Vitest, como el resto del repositorio. Las functions son `handler(request, env)`, así que se prueban inyectando un `env` falso y un `fetch` stub.

- **`generar-cotizacion-v2`**: elige `mejor` y no la primera oferta; aplica 13% y no 30%; reintenta ante 409 con la marca; cae al fallback ante 404; propaga `incompleta` a `proveedores_incompletos`; no filtra ningún campo de costo a `quote_result` (aserción explícita sobre las claves de cada línea).
- **`emitir-ordenes-compra`**: tres líneas de dos proveedores producen exactamente dos órdenes con las líneas correctas; el costo reconstruido coincide con el original dentro de un centavo de dólar; la segunda ejecución con la misma clave no manda correos; un fallo de Resend en un proveedor no impide el otro; sin `quote_confirmed` no emite.
- **`buscar-productos-v2`**: propaga `mpn` y `marca`; convierte `precio_max` de venta a costo dividiendo por 1.13.
- **Formato de prompts**: `tests/prompts.test.ts` hoy tiene `docs/kapso/prompts` hardcodeado. Hay que parametrizarlo sobre las dos raíces para que `prompts-v2/` también quede cubierto.

Las fixtures de respuestas de `/mejor-precio` van en `tests/fixtures/`, como las de Ingram y Tecnoglobal que ya existen.

## Riesgos conocidos

- **El precio baja entre la búsqueda y la cotización.** Es consecuencia directa de usar Intcomex como índice. Baja, nunca sube, así que es una sorpresa agradable; pero si el agente ya prometió un precio y el final es otro, el prompt debe presentarlo como el precio final sin dramatizar la diferencia.
- **Tipo de cambio fijo.** Heredado de v1. Con el dólar moviéndose, un valor viejo en `TIPO_CAMBIO_CLP_USD` se traduce directo en margen real distinto del 13%. Vale la pena un endpoint de tipo de cambio más adelante; no es parte de esta fase.
- **La OC no reserva stock.** Entre que el cliente acepta y el humano cursa la orden, el mayorista puede quedarse sin unidades. `abastecimiento` por línea deja ver cuáles eran stock inmediato.
