# Diseño: Búsqueda de productos para consumo por LLM

**Fecha:** 2026-08-06
**Estado:** Aprobado

## Problema

Hoy la API cotiza un producto solo si se conoce su SKU, MPN o UPC. El consumidor real es un LLM conectado a WhatsApp que atiende clientes finales, y los clientes piden en lenguaje vago ("algo HP", "una laptop de 15 pulgadas"). Falta el paso de descubrimiento: de una descripción imprecisa a un producto concreto que se pueda cotizar.

## Hallazgos que fundamentan el diseño

Verificados contra la cuenta de producción de Intcomex (2026-08-05/06):

1. **`getcatalog` ya contiene el mapeo completo**: 10.297 productos con `Sku`, `Mpn`, `Description`, `Brand`, `Category` en una sola llamada. No hacen falta dos módulos encadenados (modelo → part number → SKU): es una sola tabla y el problema es de búsqueda, no de traducción.
2. **El catálogo NO trae precio ni stock** (no existen los campos `Price` ni `InStock`). El precio sigue requiriendo una segunda llamada.
3. **`getproducts` cotiza hasta 100 SKUs en una sola llamada** (verificado: 4 SKUs → HTTP 200 con precio y stock de cada uno). Permite cotizar toda una lista de candidatos con una sola llamada externa.
4. **La búsqueda ingenua por subcadena falla**, medido sobre el catálogo real:
   - `"hp laptop 15"` devuelve audífonos **HyperX** (la subcadena "hp" calza dentro de "HyperX").
   - `"monitor dell 27"` devuelve **0 resultados** aunque el monitor existe: su descripción es `Dell P2725HE - 27" - 1920 x 1080 - IPS` y nunca dice "monitor".
   - `"teclado logitech inalambrico"` devuelve **0 resultados** por la tilde de "inalámbrico".

Distribución de marcas (top): Lenovo 989, HP 805, Hikvision 561, Xiaomi 557, Epson 370, Logitech 354.

## Alcance

**Incluido:**
- Caché local del catálogo de Intcomex con refresco diario.
- Motor de búsqueda en memoria (normalización, tokenización, puntaje, filtros estructurados, facetas).
- `GET /search` — herramienta `buscar_productos` del LLM.
- `GET /product/{sku}` — herramienta `detalle_producto` del LLM.
- `GET /facetas` — listado de marcas y categorías reales, para construir el prompt del sistema (no es una tool del LLM).
- Cotización en lote vía `getproducts`.

**Fuera de alcance:**
- Aplicación de márgenes: la resuelve el usuario en un nodo de Kapso.
- Otros proveedores y el endpoint de comparación multi-proveedor.
- Búsqueda semántica / embeddings (evolución posible si la búsqueda léxica se queda corta).

## Arquitectura

Se agregan endpoints al mismo servicio que ya corre localmente y se reutiliza el provider `intcomex` existente.

```
Cliente (WhatsApp)
   ↓
LLM en Kapso  ──tool──→  nodo determinista  ──HTTP──→  API (este proyecto)
                              ↑                            │
                              └──── aplica margen ─────────┘
   ↓
LLM ve solo precio de venta → responde al cliente
```

**Restricción de seguridad:** las respuestas de búsqueda contienen precio de **costo**. El margen debe aplicarse en un nodo determinista de Kapso que transforme la respuesta **antes** de que entre al contexto del LLM. Si el costo pasa por el contexto del modelo, es filtrable mediante manipulación de la conversación.

## Contrato

### `GET /search` (tool `buscar_productos`)

Parámetros: `q` (requerido, texto libre), `marca`, `categoria`, `precio_max`, `solo_con_stock`, `limite` (default 10).

**200:**

```json
{
  "total": 12,
  "productos": [
    {
      "sku": "NT016HPQ53",
      "mpn": "2N6G5LT#ABM",
      "nombre": "HP ProBook 640 G8 - Notebook - 14\" - Intel Core i7...",
      "marca": "HP",
      "categoria": "Computadores",
      "precio": 1697.8246,
      "moneda": "us",
      "stock": 0
    }
  ],
  "facetas": {
    "marca": [{ "valor": "HP", "n": 8 }],
    "categoria": [{ "valor": "Computadores", "n": 12 }],
    "precio": { "min": 373.92, "max": 1697.82 }
  }
}
```

La faceta `precio` solo se incluye en la respuesta **200**, calculada sobre los productos con precio efectivamente devueltos. Se omite cuando no hay productos con precio (por ejemplo, cero resultados).

**409 `demasiado_amplio`** cuando las coincidencias superan el umbral (25) y no se envió `marca` ni `categoria`. Esta ruta no hace ninguna llamada a Intcomex (no hay cotización), así que no hay precios y `facetas` nunca trae la clave `precio`:

```json
{
  "error": "demasiado_amplio",
  "detail": "212 coincidencias. Acota con marca o categoria.",
  "total": 212,
  "facetas": { "marca": [...], "categoria": [...] }
}
```

El LLM queda obligado a repreguntar, pero con material concreto para formular la pregunta.

### `GET /product/{sku}` (tool `detalle_producto`)

Ficha completa: sku, mpn, nombre, descripción íntegra, marca, categoría con subcategorías, tipo, precio, moneda, stock. Errores: `404` si el SKU no existe o no está autorizado; `502` si Intcomex falla.

### `GET /facetas`

Marcas y categorías presentes en el catálogo, con su conteo. Sirve para construir el prompt del sistema con vocabulario real (las categorías de Intcomex tienen nombres propios, ej. "Consumibles y Media").

## Motor de búsqueda

- **Normalización:** minúsculas y sin tildes, tanto en el catálogo indexado como en la consulta. Resuelve el caso "inalambrico" / "inalámbrico".
- **Tokenización por límite de palabra:** se comparan palabras completas, no subcadenas. Resuelve el falso positivo "hp" → "HyperX".
- **Puntaje en vez de conjunción:** cada término coincidente suma; los resultados se ordenan por puntaje y no se exige que estén todos. Resuelve "monitor dell 27" → 0 resultados. Pesos de mayor a menor: MPN exacto, marca, palabras de la descripción.
- **Filtros estructurados:** `marca` y `categoria` se comparan contra los campos `Brand`/`Category` del catálogo (normalizados), no por texto libre.
- **Orden de operaciones:** filtrar y puntuar en memoria → tomar los ~50 mejores → cotizarlos en **una sola** llamada `getproducts` → aplicar `precio_max` y `solo_con_stock` → devolver `limite` resultados. Una única llamada externa por búsqueda.

## Caché

- **Catálogo:** refresco diario, persistido en disco y cargado en memoria al arrancar. El campo `CompilationDate` permite detectar cambios.
- **Precios:** no se cachean. Cambian, y el stock más aún.

## Errores

Se mantiene el formato `{ "error": "...", "detail": "..." }`. Se agregan:

- `409 demasiado_amplio` — con `total` y `facetas`.
- `503 catalogo_no_disponible` — el catálogo aún no se ha descargado (arranque en frío), para que el LLM reintente en vez de informar al cliente que no hay productos.

## Seguridad

- Misma `x-api-key`, mismo prefijo `BASE_PATH`, mismo túnel.
- Recomendado (fuera de este repo): regla de rate limiting en el WAF de Cloudflare. Ahora hay un LLM llamando en producción y cada búsqueda consume una llamada a Intcomex.

## Pruebas

Unitarias con un catálogo de prueba pequeño, cubriendo los casos medidos:

- `"hp"` no devuelve productos HyperX.
- `"monitor dell 27"` encuentra el monitor Dell pese a que la descripción no dice "monitor".
- `"inalambrico"` sin tilde encuentra "inalámbrico".
- El umbral dispara `409` con facetas correctas.
- `precio_max` y `solo_con_stock` se aplican después de cotizar.
- Coincidencia exacta de MPN gana al resto.

Los precios se mockean; ningún test toca la red.
