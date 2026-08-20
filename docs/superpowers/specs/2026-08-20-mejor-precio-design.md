# Diseño: comparación de precios entre proveedores

**Fecha:** 2026-08-20
**Estado:** Aprobado

## Problema

La API ya consulta a los tres distribuidores, pero por separado: hay que
preguntarle a cada uno y comparar a mano. El objetivo del negocio es que el
agente reciba **el mejor precio** entre los tres y que ese sea el precio oficial
que se le da al cliente.

Este diseño construye esa comparación sobre la base multi-proveedor que ya
existe.

## Hallazgos que fundamentan el diseño

Medidos contra las APIs reales de los tres proveedores entre el 2026-08-18 y el
2026-08-20, no supuestos:

1. **Los tres cotizan en USD.** Intcomex, Tecnoglobal (1.485 productos) e Ingram
   (2.915 productos) devuelven precios en dólares. La conversión de moneda —que
   el spec anterior listaba como riesgo bloqueante— no existe.
2. **El 100% de los productos de Tecnoglobal e Ingram trae MPN**, y el 99,99% de
   los de Intcomex. Casi nada queda fuera de la comparación por falta de clave.
3. **Hay 1.459 productos comparables**: 978 presentes en dos proveedores y 481
   en los tres. No es el catálogo entero, pero es material suficiente para que
   la comparación valga la pena.
4. **El MPN es prácticamente único**: una sola colisión en los 10.411 productos
   de Intcomex (`98PT0G1299`, tres adaptadores de Trendnet, Eufy y MSI). Rara
   pero real, y el diseño tiene que decidir qué hacer cuando ocurre.
5. **Cotizar un solo SKU es barato en los tres.** Tecnoglobal atiende lotes de
   hasta 5 SKUs en vivo por su endpoint por SKU (~1,5 s); Ingram cotiza por
   `priceandavailability` (~1,7 s); Intcomex por `getproducts`. Comparar un
   producto son tres llamadas de un SKU cada una, en paralelo.
6. **Los proveedores fallan de formas distintas y frecuentes.** Tecnoglobal corta
   por cuota, Ingram corta por cuota, Intcomex devolvió HTTP 500 durante horas.
   Una comparación que exija a los tres va a fallar seguido.

## Alcance

**Incluido:**

- `lib/comparador.ts`: resolver, cotizar y elegir, agnóstico de proveedores.
- `GET /api/mejor-precio`, por `mpn` o por `proveedor` + `sku`.
- Respuesta parcial explícita cuando un proveedor no puede responder.
- Códigos de error nuevos: `ambiguo` y `no_comparable`.

**Fuera de alcance:**

- **Comparación por texto libre** (`?q=`). Sería un segundo endpoint por encima
  de este; conviene ver este funcionando antes.
- **Margen.** La respuesta sigue siendo precio de costo. El margen se aplica en
  un nodo determinista fuera del modelo, como ya documenta el README.
- **Conversión de moneda.** Los tres cotizan en USD (hallazgo 1). Si algún día
  un proveedor cotiza en CLP, la tasa es una decisión de negocio, no técnica.
- **Disponibilidad por bodega.** Se compara el stock total que reporta cada uno.
- **Búsqueda por `upc`.** `ProductoNormalizado` no lleva UPC —solo `sku`, `mpn`
  y los descriptivos—, así que no se puede resolver contra los catálogos en
  memoria sin agregarle el campo a los tres proveedores. No hace falta: tanto
  `/search` como `/product` devuelven `mpn`, así que el agente siempre llega
  aquí con el identificador que este endpoint necesita.

## Arquitectura

```
api/mejor-precio.ts ──→ lib/handlers/mejor-precio.ts  (fabrica del handler)
                              │
                              ├─→ lib/comparador.ts   (resolver, cotizar, elegir)
                              │        │
                              │        ├─→ lib/catalog.ts       (catalogo por proveedor)
                              │        └─→ lib/providers/index.ts (PROVEEDORES)
                              │
                              └─→ lib/producto.ts     (claveUnion)
```

`lib/comparador.ts` no menciona a ningún proveedor por nombre. Recibe el
registro como parámetro, con `PROVEEDORES` por defecto:

```ts
export interface Oferta {
  proveedor: string;
  sku: string;
  precio: number;
  moneda: string;
  stock: number | null;
}

export interface ProveedorAusente {
  proveedor: string;
  error: 'catalogo_no_disponible' | 'proveedor_no_configurado' | 'sin_precio' | 'upstream';
  detail: string;
}

export interface Comparacion {
  clave: string;
  mpn: string | null;
  marca: string | null;
  nombre: string | null;
  mejor: Oferta & { criterio: 'mas_barato_con_stock' | 'mas_barato_sin_stock' };
  ofertas: Oferta[];          // ordenadas por precio ascendente
  incompleta: ProveedorAusente[];
}

/** Claves de union que un MPN produce en los catalogos cargados. */
export function resolverClaves(
  mpn: string,
  marca?: string,
  registro?: Record<string, Proveedor>,
): string[];

/** Clave de union del producto que un proveedor identifica con ese SKU. */
export function claveDeSku(proveedor: string, sku: string): string | null;

export function compararPorClave(
  clave: string,
  registro?: Record<string, Proveedor>,
): Promise<Comparacion | null>;
```

**Agregar un cuarto proveedor no toca este módulo.** Sigue siendo escribir su
módulo y sumarlo a `PROVEEDORES`, igual que hoy. Un test lo verifica registrando
un proveedor de mentira y comprobando que aparece en la comparación.

### Los tres pasos

**1. Resolver.** Dado un identificador, se obtiene una `claveUnion` y se buscan
en el catálogo de cada proveedor los productos con esa clave.

- Por `mpn`: se recorren los catálogos buscando coincidencias. Como la clave
  incluye la marca, un MPN puede resolver a **más de una clave** — el caso
  Trendnet/Eufy/MSI. Ver "Ambigüedad" más abajo.
- Por `proveedor` + `sku`: se busca ese SKU en el catálogo de ese proveedor y se
  calcula su clave. Es el camino natural cuando el agente ya encontró algo con
  `/search` y quiere saber si otro lo tiene más barato.
- Si un proveedor tiene **varios productos con la misma clave**, se queda el más
  barato de ese proveedor: son duplicados de su propio catálogo, no ofertas
  distintas.

La resolución sale de los catálogos en memoria, no de la red. No se le pregunta
el MPN directamente a cada proveedor porque eso saltaría la marca canónica y
volvería a emparejar productos distintos con el mismo part number, que es
exactamente lo que la clave de unión evita.

**2. Cotizar.** A cada proveedor que tenga el producto se le pide el precio de
ese SKU, **en paralelo y de forma independiente** (`Promise.allSettled`, el
mismo criterio que el refresco de catálogos). Un proveedor caído no puede
cancelar la comparación entre los otros.

**3. Elegir.** Gana **el más barato con stock > 0**. Si ninguno tiene stock, gana
el más barato y `criterio` queda en `mas_barato_sin_stock`, para que el agente
sepa que el ganador no se puede entregar hoy.

`ofertas` viene siempre completa y ordenada por precio, no solo la ganadora: el
agente puede necesitar el segundo lugar, o explicarle al cliente por qué el más
barato no sirve.

### Contrato HTTP

`GET /api/mejor-precio` con exactamente uno de: `mpn`, o el par `proveedor` +
`sku`. Opcional: `marca`, para desambiguar.

```json
{
  "mpn": "BVG700I-MSX",
  "marca": "APC",
  "nombre": "APC Easy UPS 700VA",
  "mejor": {
    "proveedor": "ingram",
    "sku": "6823346",
    "precio": 128.40,
    "moneda": "USD",
    "stock": 6,
    "criterio": "mas_barato_con_stock"
  },
  "ofertas": [
    { "proveedor": "ingram",      "sku": "6823346",    "precio": 128.40, "moneda": "USD", "stock": 6 },
    { "proveedor": "intcomex",    "sku": "UP001APC42", "precio": 131.02, "moneda": "USD", "stock": 12 },
    { "proveedor": "tecnoglobal", "sku": "UPS-284",    "precio": 139.90, "moneda": "USD", "stock": 0 }
  ],
  "incompleta": []
}
```

Cuando un proveedor no pudo participar, aparece en `incompleta` con el motivo, y
la respuesta sigue siendo `200`:

```json
"incompleta": [
  { "proveedor": "tecnoglobal", "error": "upstream",
    "detail": "Tecnoglobal rechazo la consulta por exceso de llamadas..." }
]
```

**`incompleta` siempre está presente**, aunque venga vacía. Un consumidor que
tiene que preguntarse si la clave existe es un consumidor que se olvida de
mirarla, y entonces cotiza caro creyendo que comparó todo.

**Un proveedor que simplemente no vende el producto no aparece en ningún lado**,
ni en `ofertas` ni en `incompleta`. Eso no es un hueco: su catálogo se revisó y
la respuesta es definitiva. La regla queda entonces sin ambigüedad para el
consumidor:

| Dónde aparece el proveedor | Qué significa |
|---|---|
| En `ofertas` | Lo vende, a ese precio |
| En `incompleta` | Podría venderlo más barato, pero no pudimos averiguarlo |
| En ninguna | Se revisó su catálogo y no lo vende |

### Ambigüedad

Si el `mpn` pedido resuelve a más de una clave —o sea, existe bajo dos marcas
canónicas distintas— **no se adivina**. Se responde `409 ambiguo` con las marcas
encontradas, para que el agente repregunte con `&marca=`:

```json
{
  "error": "ambiguo",
  "detail": "El MPN 98PT0G1299 existe bajo 3 marcas. Repite la consulta con &marca=",
  "marcas": ["trendnet", "eufy", "msi"]
}
```

Es el mismo patrón que `/search` ya usa con `demasiado_amplio`: cuando la
consulta no discrimina, se pide acotar en vez de elegir por el consumidor. Con
una colisión cada 10.000 productos esto va a ser raro, pero elegir mal aquí es
cotizarle al cliente otro producto.

### Manejo de errores

El sobre `{ error, detail }` no cambia. Códigos:

| HTTP | `error` | Cuándo |
|---|---|---|
| 400 | `bad_request` | Ningún identificador, o más de uno |
| 404 | `not_found` | Ningún proveedor tiene ese producto |
| 404 | `proveedor_desconocido` | El `proveedor` del par `proveedor`+`sku` no existe |
| 409 | `ambiguo` | El MPN existe bajo varias marcas (arriba) |
| 409 | `no_comparable` | El producto no tiene MPN o marca, así que no tiene clave |
| 503 | `catalogo_no_disponible` | **Ningún** proveedor tiene catálogo cargado |

`no_comparable` solo puede aparecer por el camino `proveedor`+`sku`: es el
producto que el agente encontró en un catálogo pero que no se puede comparar
porque le falta MPN o marca. Decirlo explícitamente es mejor que un `404` que
sugiere que el producto no existe.

**Un proveedor sin catálogo no es un `503`**, es una entrada en `incompleta`.
Solo si ninguno tiene catálogo la comparación es imposible.

## Estrategia de tests

`lib/comparador.ts` recibe el registro por parámetro, así que se testea con
proveedores de mentira, sin red y sin mocks de módulo.

Casos que hay que cubrir:

- Elige el más barato con stock aunque haya uno más barato sin stock.
- Con ninguno con stock, elige el más barato y marca `mas_barato_sin_stock`.
- Un proveedor que falla al cotizar no cancela la comparación y aparece en
  `incompleta` con su motivo.
- Un proveedor sin catálogo aparece en `incompleta`, no rompe.
- Con todos los proveedores caídos y ninguna oferta, `not_found`.
- Duplicados dentro de un mismo proveedor: gana el más barato de ese proveedor.
- **Un proveedor nuevo registrado aparece en la comparación sin tocar el
  módulo**, que es el requisito de extensibilidad.
- Ambigüedad: un MPN bajo dos marcas responde `409 ambiguo` con las dos.
- `marca` desambigua y devuelve la comparación correcta.
- Contrato de errores: las entradas nuevas van a `tests/contrato-errores.test.ts`
  para pasar por las mismas aserciones de sobre que el resto.

`tests/docs.test.ts` va a exigir que la ruta nueva esté documentada en
`docs/api/README.md` y en `openapi.yaml`, y que los nombres de campo de la
respuesta coincidan con el código. Eso es deseado: la doc la lee el agente.

## Riesgos

1. **La comparación solo cubre 1.459 productos.** El resto existe en un solo
   proveedor y `/mejor-precio` va a responder con una sola oferta. Es correcto,
   pero conviene que el prompt del agente no prometa "comparamos entre tres".
2. **Frescura desigual.** Los tres cotizan en vivo por este camino, así que el
   precio es del momento. Pero si algún día se agrega la comparación por texto
   libre, ahí Tecnoglobal serviría precios de hasta una hora y habría que decidir
   si eso es aceptable para comprometer un precio.
3. **La latencia la manda el proveedor más lento.** Las tres cotizaciones van en
   paralelo, así que la respuesta tarda lo que tarde el peor: ~2-3 s hoy. Si se
   suma un cuarto proveedor lento, sube.
4. **`incompleta` puede volverse la norma y nadie mirarla.** Los tres proveedores
   cortan por cuota o se caen con frecuencia. Vale la pena revisar en producción
   con qué frecuencia las comparaciones salen parciales.
