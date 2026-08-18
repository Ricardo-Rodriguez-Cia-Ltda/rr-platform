# API de precios de proveedores — referencia

> Documento pensado para ser leído por un modelo de lenguaje. Todo lo que
> aparece aquí está verificado contra el código de `api/` y `lib/`. Si algo del
> código cambia y esta referencia queda vieja, `tests/docs.test.ts` falla.
>
> Contrato machine-readable equivalente: [`openapi.yaml`](openapi.yaml).
> Vocabulario real del catálogo (marcas y categorías): [`vocabulario.md`](vocabulario.md).

## Qué es esto

Una API HTTP de solo lectura que expone el catálogo del mayorista **Intcomex**:
buscar productos por texto libre, ver la ficha de un SKU y cotizar un precio.

Dos capas distintas, con propiedades distintas:

| Dato | Origen | Frescura |
|---|---|---|
| Surtido (SKU, nombre, marca, categoría, MPN) | catálogo descargado de Intcomex | hasta 24 h de antigüedad |
| Precio y stock | consulta en vivo a Intcomex en cada request | del momento |

El precio nunca sale de caché. Lo que puede estar desactualizado es qué
productos existen, no cuánto cuestan.

> [!IMPORTANT]
> **Todos los precios que devuelve esta API son precio de COSTO** (lo que la
> empresa le paga a Intcomex). Si el consumidor final es un LLM que conversa con
> clientes, el margen debe aplicarse en un nodo determinista **antes** de que la
> respuesta entre al contexto del modelo. Ver [`../kapso/README.md`](../kapso/README.md).

## Acceso

**Base URL de producción:** `https://api.pyxis-latam.cl/rr/captador-precios`

**Autenticación:** header `x-api-key` en **todas** las rutas. La comparación es
de tiempo constante; sin header o con valor incorrecto se responde `401`.

```bash
curl -H "x-api-key: $API_SECRET_KEY" \
  "https://api.pyxis-latam.cl/rr/captador-precios/search?q=probook&marca=HP"
```

**Método:** `GET` en todos los endpoints de catálogo. La única excepción es
`/credito/mock`, que es `POST` con cuerpo JSON. Usar el verbo equivocado
responde `405 method_not_allowed`.

**Formato:** siempre JSON (`application/json; charset=utf-8`), tanto en éxito
como en error.

### Rutas y despliegues

El proyecto corre en dos sitios y las rutas no son idénticas:

| Endpoint | Servidor local / túnel | Vercel |
|---|---|---|
| Cotizar | `/price`, `/api/price` | `/api/price` |
| Buscar | `/search`, `/api/search` | `/api/search` |
| Ficha | `/product?sku=X`, `/product/X`, `/api/product/X` | `/api/product?sku=X` |
| Facetas | `/facetas`, `/api/facetas` | `/api/facetas` |
| Crédito (mock) | `/credito/mock`, `/api/credito/mock` | `/api/credito/mock` |

El prefijo extra (`/rr/captador-precios`) lo define la variable `BASE_PATH` del
servidor local; `/api/<nombre>` funciona siempre. La forma `/product/{sku}` como
segmento de path **solo existe en el servidor local**: en Vercel hay que usar
`?sku=`. Si escribes un cliente que deba funcionar en ambos, usa siempre
`/product?sku=`.

Una ruta desconocida en el servidor local responde `404 not_found` con
`detail: "Unknown route"`.

### Proveedores

El negocio compra a tres distribuidores y cada uno tiene su propio catálogo,
sus propios SKU y su propio precio:

| Proveedor | Ruta | Estado |
|---|---|---|
| `intcomex` | `/api/intcomex/{search,product,facetas}` | En producción |
| `tecnoglobal` | `/api/tecnoglobal/{search,product,facetas}` | Integrado y verificado contra su API real |
| `ingram` | `/api/ingram/{search,product,facetas}` | Integrado; **a la espera de credenciales** |

`/search`, `/product` y `/facetas` **sin proveedor en la ruta siguen siendo
Intcomex** y responden exactamente lo mismo que antes. Existen para que los
consumidores actuales no tengan que cambiar nada.

`/price` elige proveedor por query param: `?provider=tecnoglobal`.

Todavía **no hay un endpoint de "mejor precio"** entre los tres: cada proveedor
se consulta por separado. Comparar es el paso siguiente y necesita que las tres
integraciones estén verificadas contra sus APIs reales.

El SKU **no es comparable entre proveedores**: cada distribuidor tiene el suyo.
Lo único común es el `mpn` (part number del fabricante).

#### Frescura del precio por proveedor

| Endpoint | Intcomex | Tecnoglobal | Ingram |
|---|---|---|---|
| `/search` | En vivo | Hasta **1 hora** de antigüedad | En vivo |
| `/product`, `/price` | En vivo | En vivo | En vivo |

Tecnoglobal limita muy fuerte las descargas de su catálogo completo y no tiene
consulta de precios por lote, así que el ranking de una búsqueda se arma con
una foto periódica. **Si vas a comprometer un precio de Tecnoglobal con un
cliente, confírmalo con `/product`**, que sí consulta en vivo. Para los otros
dos proveedores no hay diferencia.

## Formato de error

Todos los errores comparten esta forma:

```json
{ "error": "<código estable>", "detail": "<explicación legible>" }
```

Ramifica siempre por `error`, nunca por el texto de `detail`.

| HTTP | `error` | Significado | Qué hacer |
|---|---|---|---|
| 400 | `bad_request` | Parámetros inválidos o faltantes | Corregir la llamada. No reintentar igual. |
| 401 | `unauthorized` | Falta `x-api-key` o es incorrecta | Problema de configuración. No reintentar. |
| 404 | `not_found` | El producto no existe o el proveedor no entregó precio | No reintentar. El SKU no sirve. |
| 405 | `method_not_allowed` | Se usó un verbo distinto de GET | Usar GET. |
| 409 | `demasiado_amplio` | La búsqueda calza demasiados productos | Acotar con `marca` o `categoria`. Ver abajo. |
| 413 | `payload_too_large` | El cuerpo de un POST supera 1 MB | Corregir la llamada. No reintentar. |
| 500 | `internal` | Error inesperado del servidor | No debería ocurrir. Transitorio; reintentar una vez. |
| 404 | `proveedor_desconocido` | El proveedor de la ruta no existe | Corregir la llamada. Los válidos son `intcomex`, `tecnoglobal`, `ingram`. |
| 502 | `upstream` | El proveedor falló o es inalcanzable | Fallo transitorio. Se puede reintentar una vez, tras unos segundos. |
| 503 | `catalogo_no_disponible` | El catálogo aún no terminó de cargar | Transitorio, típicamente al arrancar. Reintentar en ~1 min. |
| 503 | `proveedor_no_configurado` | El proveedor existe pero no tiene credenciales | **No es transitorio.** No reintentar: falta configuración nuestra. |

`502` puede traer un campo extra `upstream` con el cuerpo devuelto por el
proveedor (truncado a 500 caracteres), útil para diagnosticar pero no para
mostrar a un usuario final.

Los errores de las rutas `/api/{proveedor}/...` traen además el campo
`proveedor`, para saber cuál de los tres falló sin tener que releer la URL.

`proveedor_no_configurado` es distinto de `502` a propósito: nadie falló aguas
arriba, falta una credencial de nuestro lado. La distinción es la diferencia
entre investigar una caída y pedirle las llaves al área de TI del proveedor.

---

## `GET /search` — buscar productos por texto libre

El endpoint principal. Recibe una descripción vaga y devuelve productos con
precio y stock reales.

### Parámetros (query string)

| Parámetro | Tipo | Req. | Default | Notas |
|---|---|---|---|---|
| `q` | string | **sí** | — | Texto libre. Debe contener al menos un token alfanumérico. |
| `marca` | string | no | — | Filtro **exacto** (ignora tildes y mayúsculas). Debe ser un valor real del catálogo. |
| `categoria` | string | no | — | Filtro **exacto**, mismas reglas que `marca`. |
| `precio_max` | número | no | ∞ | Tope de **costo** en la moneda del catálogo (USD). Debe ser > 0. |
| `solo_con_stock` | `"true"` | no | `false` | Solo el literal `true` activa el filtro; cualquier otro valor lo deja apagado. |
| `limite` | entero | no | `10` | Cuántos productos devolver. Entero ≥ 0. |

Si un parámetro se repite en la query string, se usa **la primera** aparición.

### Respuesta `200`

```json
{
  "total": 12,
  "evaluados": 12,
  "productos": [
    {
      "sku": "HP001PRO14",
      "mpn": "8A5Z2LT#ABM",
      "nombre": "HP ProBook 440 G10 Notebook 14\" Core i5",
      "marca": "HP",
      "categoria": "Computadores",
      "precio": 703.42,
      "moneda": "US",
      "stock": 12
    }
  ],
  "facetas": {
    "marca": [{ "valor": "HP", "n": 12 }],
    "categoria": [{ "valor": "Computadores", "n": 12 }],
    "precio": { "min": 703.42, "max": 1288.9 }
  }
}
```

Los tres contadores significan cosas distintas y se confunden con facilidad:

- **`total`** — cuántos productos del catálogo calzan con `q` + filtros de
  marca/categoría. Es el universo de la búsqueda textual.
- **`evaluados`** — de esos, cuántos se alcanzaron a cotizar contra Intcomex
  antes de juntar `limite` resultados. Siempre ≤ `total`.
- **`productos`** — los que además pasaron `precio_max` y `solo_con_stock`.
  Como máximo `limite`.

Campos de cada producto: `mpn`, `nombre`, `marca`, `categoria` y `stock` pueden
ser `null` (el catálogo de Intcomex no siempre los trae). `sku`, `precio` y
`moneda` siempre vienen.

`facetas.precio` solo aparece cuando `productos` no está vacío, y describe el
rango de **los productos devueltos**, no del universo completo.

### Respuesta `409 demasiado_amplio`

Cuando la búsqueda calza más de **25** productos y no se envió `marca` ni
`categoria`:

```json
{
  "error": "demasiado_amplio",
  "detail": "749 coincidencias. Acota con marca o categoria.",
  "total": 749,
  "facetas": {
    "marca": [{ "valor": "Lenovo", "n": 312 }, { "valor": "HP", "n": 240 }],
    "categoria": [{ "valor": "Computadores", "n": 700 }]
  }
}
```

Esto **no es un error técnico**: es la API pidiendo que se desambigüe. La
respuesta correcta es preguntarle al usuario usando los valores de `facetas`, y
volver a llamar pasando uno de ellos **literalmente** en `marca` o `categoria`.
Reintentar con otras palabras en `q` es un antipatrón: la ambigüedad no está en
la redacción sino en el tamaño del resultado.

El umbral es 25 y el corte se evalúa **antes** de cotizar precios, así que un
409 no consume llamadas al proveedor.

### Respuesta `200` con lista vacía y `sin_resultados`

Hay dos maneras distintas de "no encontrar nada", y la API las distingue:

**a) No existe nada parecido** — `total: 0`, `evaluados: 0`, `productos: []`, sin
campo `sin_resultados`. La consulta no calzó con el catálogo.

**b) Sí existen productos, pero ninguno cumple los filtros** — aparece
`sin_resultados`:

```json
{
  "total": 8,
  "evaluados": 8,
  "productos": [],
  "facetas": { "marca": [...], "categoria": [...] },
  "sin_resultados": {
    "motivo": "sobre_presupuesto",
    "alternativa": {
      "sku": "LN002IP14",
      "mpn": "82XJ0001LM",
      "nombre": "Lenovo IdeaPad 3 14\"",
      "marca": "Lenovo",
      "categoria": "Computadores",
      "precio": 489.0,
      "moneda": "US",
      "stock": 4
    }
  }
}
```

`motivo` toma uno de dos valores:

- `sin_stock` — se pidió `solo_con_stock=true` y ninguno de los evaluados tiene
  existencias. `alternativa` es el más barato de los evaluados (sin stock).
- `sobre_presupuesto` — ninguno cae bajo `precio_max`. `alternativa` es el más
  barato **con stock** si lo hay; si no, el más barato en general.

En este caso **no hay que reintentar la búsqueda**. La información ya está: el
producto existe pero no bajo esas condiciones. Lo correcto es explicárselo al
usuario y ofrecerle la `alternativa`.

### Cómo funciona el ranking (para escribir buenos `q`)

El puntaje de cada producto suma:

| Coincidencia | Puntos |
|---|---|
| El MPN **completo** calza con la consulta o con uno de sus términos | 100 |
| Cada término que calza con un token de la marca | 10 |
| Cada término que calza con un token de la descripción | 3 |

Consecuencias prácticas:

- El texto se normaliza sin tildes y en minúsculas. `"cámara"` == `"camara"`.
- El match es por **token completo**, no por subcadena: `"note"` no encuentra
  `"notebook"`.
- El MPN solo puntúa cuando calza entero. Un `"27"` suelto no arrastra todos los
  MPN que contengan 27.
- **Los términos que ya usaste como filtro no puntúan.** Si mandas `marca=HP`,
  la palabra `HP` dentro de `q` se descarta; si no fuera así, sumaría 10 en los
  cientos de productos HP y ahogaría al término que de verdad discrimina.
  Por eso: pon la marca en `marca`, no repetida en `q`.
- `q` funciona mejor con pocas palabras clave del producto que con la frase
  completa del usuario. Bien: `"notebook 14"`. Mal:
  `"quiero un notebook hp de 14 pulgadas para la oficina"`.
- Si `q` queda sin términos útiles tras quitar los del filtro, todos los
  productos que pasan los filtros puntúan igual (score 1).

### Costo de la llamada y límites internos

Los precios se piden a Intcomex en lotes de **100 SKU** (el máximo que acepta
`getproducts`), y el bucle corta apenas junta `limite` productos válidos.
Cuántos candidatos se alcanzan a revisar depende de si hay filtros de precio o
stock:

- **Sin** `precio_max` ni `solo_con_stock`: hasta **50** candidatos (1 lote).
- **Con** alguno de los dos: hasta **300** candidatos (hasta 3 lotes).

La diferencia existe porque precio y stock solo se conocen al cotizar, y en el
catálogo real apenas ~27% de los productos tiene stock: con filtros hay que
mirar más abajo para llenar la página. El efecto para quien consume: una
búsqueda con filtros puede tardar bastante más y, si `evaluados` llegó al tope,
puede haber resultados válidos más abajo que no se revisaron.

---

## `GET /product` — ficha completa de un SKU

Para profundizar en un producto que ya apareció en una búsqueda.

**Parámetro:** `sku` (obligatorio). En el servidor local también funciona como
segmento de path: `/product/HP001PRO14`.

### Respuesta `200`

```json
{
  "sku": "HP001PRO14",
  "mpn": "8A5Z2LT#ABM",
  "nombre": "HP ProBook 440 G10 Notebook 14\" Core i5-1335U 8GB 512GB SSD W11P",
  "marca": "HP",
  "categoria": "Computadores",
  "subcategorias": ["Notebooks", "Notebooks Comerciales"],
  "tipo": "Physical",
  "precio": 703.42,
  "moneda": "US",
  "stock": 12
}
```

Frente a lo que devuelve `/search`, agrega `subcategorias` (arreglo, puede venir
vacío) y `tipo`, y trae la descripción íntegra sin truncar.

**Dos causas distintas de `404`**, distinguibles solo por `detail`:

- `"SKU no encontrado en el catalogo"` — el SKU no existe o el catálogo en
  memoria es viejo y aún no lo incluye.
- `"Intcomex no entrego precio para este SKU"` — está en el catálogo pero el
  proveedor no lo cotiza (descontinuado, sin lista de precios).

En ambos casos no sirve reintentar.

---

## `GET /price` — cotizar un identificador conocido

Consulta directa a Intcomex, **sin pasar por el catálogo**. Es el único endpoint
que sigue funcionando durante el `503` de arranque, y el único que acepta MPN y
UPC además de SKU.

### Parámetros

Exactamente **uno** de `sku`, `mpn` o `upc`. Mandar cero o más de uno responde
`400 bad_request` con `detail: "Provide exactly one of: sku, mpn, upc"`.

Opcional: `provider` (default `intcomex`; hoy es el único valor válido, otro da
`400`).

### Respuesta `200`

```json
{
  "provider": "intcomex",
  "sku": "SE001MSE01",
  "mpn": "AAA-01148",
  "description": "Microsoft Access 2013 - License",
  "price": 103.5294,
  "currency": "US",
  "inStock": 203
}
```

Ojo: este endpoint usa **nombres de campo en inglés** (`description`, `price`,
`currency`, `inStock`), a diferencia de `/search` y `/product` que los usan en
español (`nombre`, `precio`, `moneda`, `stock`). Es una diferencia histórica,
no un descuido de esta documentación.

`sku`, `mpn`, `description` e `inStock` pueden ser `null`. `price` y `currency`
siempre vienen; si Intcomex no entrega precio, la respuesta es `404`, no un
`price: null`.

---

## `GET /facetas` — vocabulario del catálogo

Devuelve todas las marcas y categorías reales con su conteo, sobre el catálogo
completo.

```json
{
  "total_productos": 10342,
  "marca": [{ "valor": "Lenovo", "n": 812 }, { "valor": "HP", "n": 740 }],
  "categoria": [{ "valor": "Computadores", "n": 2140 }]
}
```

Ordenado por conteo descendente y, a igual conteo, alfabéticamente.

**Este endpoint no está pensado como herramienta para un LLM conversacional.**
Su respuesta es grande (144 marcas, 32 categorías) y no aporta nada en medio de
una conversación. Su uso es de build-time: generar el vocabulario que se
inyecta en el system prompt, para que el modelo sepa que la marca se llama `HP`
y no `Hewlett-Packard`. Ver [`vocabulario.md`](vocabulario.md) y
`npm run docs:vocabulario`.

---

## `POST /credito/mock` — consultar cupo de crédito (MOCK)

> [!WARNING]
> **Este endpoint es un mock. No consulta nada.** Devuelve siempre la misma
> línea de crédito, sin importar qué RUT se le pase. Existe para que el
> consumidor pueda integrarse contra un contrato estable mientras no exista la
> conexión real con RRS.
>
> Toda respuesta trae `"mock": true`. **Ninguna decisión comercial real debe
> tomarse con esta respuesta.** Cuando llegue la integración de verdad vivirá en
> `/credito` y esta ruta desaparecerá.

Responde si un cliente tiene cupo suficiente para una compra de un monto dado.
Es una **consulta**: no reserva, no descuenta y no registra nada.

Único endpoint de la API que usa `POST` y cuerpo JSON, y el único que habla en
**pesos chilenos**. Tampoco toca el catálogo ni a Intcomex, así que funciona
durante el `503` de arranque.

### Petición

```http
POST /credito/mock
x-api-key: <API_SECRET_KEY>
content-type: application/json

{ "rut": "111111111", "total_clp": 123456 }
```

| Campo | Tipo | Req. | Notas |
|---|---|---|---|
| `rut` | string | **sí** | Con o sin puntos y guion. Se normaliza a dígitos + DV (`11.111.111-1` → `111111111`). |
| `total_clp` | entero | **sí** | Monto a evaluar, en **pesos chilenos**. Mayor a 0. |

`total_clp` es estricto: debe ser un **número JSON entero**, no un string. Un
`"1500"` entre comillas, un `1500.5` o un `1.500.000` con puntos se rechazan con
`400`.

> [!CAUTION]
> El resto de esta API cotiza en **USD** y este endpoint recibe **CLP**. Pasar un
> total en dólares aquí evalúa el crédito contra un monto ~900 veces menor y
> aprueba cualquier cosa. Convertir antes de llamar, en un nodo determinista.

El mock **no valida el dígito verificador** del RUT: no tiene padrón contra qué
comprobarlo. La implementación real probablemente sí lo hará, así que no
conviene apoyarse en que un RUT inválido pase.

### Respuesta `200`

Aprobado (`total_clp` ≤ disponible):

```json
{
  "mock": true,
  "rut": "111111111",
  "moneda": "CLP",
  "habilitado": true,
  "linea_credito_clp": 10000000,
  "utilizado_clp": 4000000,
  "disponible_clp": 6000000,
  "solicitado_clp": 123456,
  "aprobado": true,
  "motivo": "dentro_de_linea",
  "faltante_clp": 0
}
```

Rechazado (`total_clp` = 12.000.000, sobre los 6.000.000 disponibles):

```json
{
  "mock": true,
  "rut": "111111111",
  "moneda": "CLP",
  "habilitado": true,
  "linea_credito_clp": 10000000,
  "utilizado_clp": 4000000,
  "disponible_clp": 6000000,
  "solicitado_clp": 12000000,
  "aprobado": false,
  "motivo": "excede_linea",
  "faltante_clp": 6000000
}
```

| Campo | Significado |
|---|---|
| `mock` | Siempre `true` mientras esto sea un mock. Su ausencia indicará que la respuesta viene del sistema real. |
| `habilitado` | Si el cliente tiene línea de crédito activa. El mock siempre responde `true`. |
| `linea_credito_clp` | Cupo total aprobado. |
| `utilizado_clp` | Cuánto de ese cupo ya está consumido. |
| `disponible_clp` | `linea_credito_clp - utilizado_clp`. Es el número que decide. |
| `solicitado_clp` | Eco de `total_clp`, para que la respuesta se explique sola en un log. |
| `aprobado` | `true` si `solicitado_clp <= disponible_clp`. El límite exacto **sí** se aprueba. |
| `motivo` | `dentro_de_linea`, `excede_linea` o `sin_linea_habilitada`. |
| `faltante_clp` | Cuánto cupo falta. `0` cuando está aprobado; si no, `solicitado - disponible`. |

`sin_linea_habilitada` es parte del contrato para cuando exista la integración
real (cliente sin crédito), pero **el mock nunca lo devuelve**. Un consumidor
bien escrito ya debería manejarlo.

### Valores fijos del mock

| | |
|---|---|
| Línea de crédito | **10.000.000** CLP |
| Utilizado | **4.000.000** CLP |
| Disponible | **6.000.000** CLP |

Están hardcodeados en `api/credito/mock.ts`. Como consecuencia: cualquier monto
hasta 6.000.000 se aprueba y cualquiera sobre eso se rechaza, para todos los RUT.

### Un rechazo no es un error

Pedir más cupo del disponible responde **`200` con `aprobado: false`**, no un
error HTTP. La consulta funcionó; la respuesta simplemente es "no". Los `4xx` de
este endpoint significan que la llamada estaba mal armada, no que al cliente le
falte cupo.

| Situación | Status |
|---|---|
| Cupo suficiente | `200`, `aprobado: true` |
| Cupo insuficiente | `200`, `aprobado: false` |
| Falta `rut` o `total_clp`, o vienen mal tipados | `400` |
| Cuerpo que no es JSON válido | `400` |
| Falta o es inválida `x-api-key` | `401` |
| Se usó GET u otro verbo | `405` |
| Cuerpo sobre 1 MB | `413` |

---

## Ciclo de vida del catálogo

Relevante porque explica el `503` y el desfase del surtido.

1. Al arrancar, el servidor empieza a responder de inmediato. El catálogo se
   descarga **en segundo plano**.
2. Mientras esa primera carga no termina, `/search`, `/product` y `/facetas`
   responden `503 catalogo_no_disponible`. `/price` funciona desde el segundo
   cero.
3. Se refresca cada **24 horas**, con copia en disco por proveedor
   (`cache/catalog-<proveedor>.json`, carpeta configurable con
   `CATALOG_CACHE_DIR`). Al arrancar, si la copia en disco tiene menos de 24 h,
   se usa sin descargar nada.
4. Si un refresco falla pero hay copia en disco, **se sigue usando la copia
   vencida**. Un surtido viejo sirve más que ninguno, y el precio igual se
   consulta en vivo.
5. Si la carga inicial falla y no hay copia en disco, se reintenta cada
   **5 minutos** en vez de esperar el ciclo completo de 24 h. El reintento es
   solo para el proveedor que falló.
6. Los tres proveedores se cargan **en paralelo** y de forma independiente: que
   Tecnoglobal esté caído no deja sin catálogo a Intcomex. Un proveedor sin
   credenciales ni siquiera se intenta; sus rutas responden
   `proveedor_no_configurado`.

Ninguna de estas transiciones es visible desde fuera salvo por el `503`.

---

## Cómo consumir esto desde un agente LLM

Resumen operativo de lo anterior:

1. **Expón `buscar_productos` y `detalle_producto` como tools; no expongas
   `/facetas` ni `/price`.** El vocabulario va en el prompt, no en una tool.
2. **Nunca inventes precios, modelos ni disponibilidad.** Si no lo devolvió una
   herramienta, no existe.
3. **`409` significa preguntar, no reintentar.** Usa las facetas de la respuesta
   para ofrecer opciones concretas, y vuelve a llamar con el valor exacto.
4. **`sin_resultados` significa explicar, no reintentar.** El producto existe
   pero no cumple las condiciones; ofrece la `alternativa`.
5. **Nunca repitas la misma búsqueda con otras palabras esperando otro
   resultado.** El ranking es determinista: la misma consulta devuelve lo mismo.
   Reintentar solo hace esperar al usuario.
6. **Copia los valores de `marca` y `categoria` literalmente** de lo que devolvió
   la API. No los traduzcas ni los normalices.
7. **Todos los montos son USD.** Si el usuario habla en otra moneda, pregunta el
   equivalente antes de mandar `precio_max`. No adivines el tipo de cambio.
8. **`404` y `400` son definitivos; `502` y `503` son transitorios** (a lo más un
   reintento tras unos segundos).
9. **Aplica el margen fuera del modelo.** Los precios de esta API son costo.

La implementación de referencia de todo esto —tools, margen, esquemas y system
prompt— está en [`../kapso/README.md`](../kapso/README.md).

---

## Mantenimiento de esta documentación

| Qué | Cómo se mantiene |
|---|---|
| Rutas, códigos de error y constantes | `tests/docs.test.ts` falla si el código y estos documentos se desincronizan. Corre con `npm test`. |
| `vocabulario.md` | Regenerado desde la API con `npm run docs:vocabulario`. |
| Formas de respuesta y semántica | A mano. Al tocar un handler de `api/`, actualizar la sección correspondiente. |
