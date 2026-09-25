# Diseño: búsqueda con el mejor precio de los tres mayoristas

**Fecha:** 2026-09-25

## Problema

La búsqueda (`GET /search` de la `pricing-api`, alias histórico de
`/intcomex/search`) solo mira el catálogo y los precios de **Intcomex**. La
tienda y el bot la usan para mostrar productos y precios. Pero al cotizar, los
dos usan `/mejor-precio` (vía `generar-cotizacion-v2`), que elige entre
Intcomex, Ingram y Tecnoglobal con `pickBest`
(`packages/providers/src/comparator.ts`).

Consecuencias medidas el 2026-09-25:

- En 28 de 40 productos presentes en más de un catálogo, Intcomex no era el más
  barato. La diferencia típica es 1–5 %, con casos de −30 % a −50 %.
- Todos los casos extremos tenían **stock 0 en Intcomex**: para productos sin
  stock Intcomex entrega precios que parecen de lista o desactualizados (un
  Intel Core i5 BX8071514100F a US$169 contra US$93 en Ingram con stock).
- El cliente ve un precio de catálogo y, al confirmar, otro (el aviso "el
  precio cambió"). El bot cita precios que después no coinciden con la
  cotización.

## Decisión

`GET /search` pasa a buscar en los tres catálogos y a mostrar, por producto,
el mismo ganador que elegiría la cotización. Las rutas por mayorista
(`/{proveedor}/search`) no cambian. Tienda y bot no cambian de código.

Descartados: llamar `/mejor-precio` por cada resultado (24 cotizaciones en vivo
por búsqueda, agota la cuota de Ingram de 60 llamadas por minuto) y precalcular
una tabla de mejores precios (precios viejos, más infraestructura).

Fuera de alcance: productos que solo existen en un mayorista y sin stock (el
ejemplo del Lenovo 10NQ0017CS sigue con el precio de Intcomex).

## Diseño

### Candidatos

1. Por cada mayorista con catálogo cargado se corre `search()` con los mismos
   filtros de texto (`q`, `marca`, `categoria`, `subcategoria`).
2. Los resultados se agrupan por `unionKey` (MPN compactado + marca canónica),
   la misma clave que usa `/mejor-precio`. Un grupo guarda, por mayorista, los
   productos que calzan y el mejor puntaje del grupo.
3. Los productos **sin clave** (sin MPN o sin marca) solo entran si son de
   Intcomex, como hoy: la cotización necesita el MPN para elegir mayorista, y
   su respaldo por SKU es de Intcomex.
4. Los grupos se ordenan por puntaje descendente. Las facetas se calculan sobre
   un producto representante por grupo (el de Intcomex si existe; si no, el de
   mayor puntaje).
5. El umbral de "demasiado amplio" (más de 25 grupos sin filtros) y los topes
   de candidatos (50 sin filtros, 300 con filtros) se aplican sobre grupos.
6. Si ningún mayorista tiene catálogo cargado: 503 `catalogo_no_disponible`.

### Precios

- Por mayorista se cotizan en lote los SKU de los candidatos que le
  pertenecen, con una función común `cotizarLote(provider, skus, limite)`:
  primero el caché fresco (15 min); lo que falta, en vivo en lotes de
  `maxSkusPerBatch` **en paralelo**; si un lote falla o no alcanza a responder
  antes del límite, se rescata del caché utilizable (24 h) y lo que ni ahí
  está queda sin precio y marca la búsqueda como `parcial`.
- Los tres mayoristas se cotizan en paralelo con un solo límite de reloj:
  20 s desde que empezó la cotización (el mismo presupuesto de hoy).
- Tecnoglobal no gasta llamadas (su `getPrices` usa el volcado local); Ingram
  gasta una llamada por cada 50 SKU.

### Ganador por producto

- Por mayorista, la oferta es su SKU más barato del grupo con precio (misma
  regla que `cheapest` del comparador).
- Entre mayoristas gana `pickBest` (se exporta del comparador): más barato con
  stock; si ninguno tiene stock informado, el más barato con stock
  desconocido; si todos tienen stock 0, el más barato.
- El producto devuelto usa el SKU, precio, moneda y stock del ganador, y suma
  el campo `proveedor`. Nombre, marca y categoría salen del producto del
  mayorista ganador; `foto` se resuelve por la clave como hoy.
- Los filtros `precio_max` y `solo_con_stock` se aplican al ganador, igual que
  hoy se aplican al precio de Intcomex.

### Respuesta

Mismo contrato de `/search` de hoy: `total` (grupos), `evaluados`,
`productos`, `facetas` (con `precio` min/max de lo devuelto), `parcial`,
`sin_resultados`, `precios_de_hace_min`, y el 409 `demasiado_amplio`. Cada
producto suma `proveedor`. Los errores de entrada (400/401/405) son los mismos.
Si ningún mayorista pudo cotizar nada (ni en vivo ni desde caché) y no hay
nada que mostrar, 502 `upstream`, como hoy.

## Pruebas

- `cotizarLote`: caché fresco sin llamada, lotes en paralelo, lote fallido
  rescatado del caché utilizable, lote lento cortado por el límite → sin
  precio y `incompleto`.
- Agrupación: mismo producto en dos catálogos (MPN escrito distinto) queda en
  un grupo; sin clave solo entra desde Intcomex; orden por puntaje.
- Ganador: más barato con stock gana a uno más barato sin stock (el caso real
  BX8071514100F); con igual stock gana el más barato; un mayorista sin precio
  no participa.
- Handler: contrato completo (400/401/405/409/503/502), `proveedor` en cada
  producto, filtros sobre el ganador, `parcial` si un mayorista no alcanza.
- Verificación real: la `pricing-api` local contra los mayoristas reales para
  los productos del análisis (BX8071514100F, E551755, DP2VGAMM6B) y la tienda
  local mostrando el precio de Ingram.
