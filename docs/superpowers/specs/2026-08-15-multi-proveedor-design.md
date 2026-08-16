# Diseño: Soporte multi-proveedor (Intcomex, Ingram Micro, Tecnoglobal)

**Fecha:** 2026-08-15
**Estado:** Aprobado

## Problema

La API cotiza contra un solo proveedor, Intcomex. El negocio compra a tres:
Intcomex, Ingram Micro Chile (`cl.ingrammicro.com`) y Tecnoglobal
(`tecnoglobal.cl`). El objetivo final es que el agente reciba **el mejor precio**
entre los tres, y que ese sea el precio oficial que se le da al cliente.

Este diseño **no** construye la comparación. Construye la base sobre la que la
comparación es un paso pequeño, y expone cada proveedor por separado para poder
validar las integraciones una por una antes de confiar en el número unificado.

## Hallazgos que fundamentan el diseño

Verificados leyendo el código el 2026-08-15:

1. **La abstracción `Provider` de hoy es una fachada.** Existe
   `lib/types.ts:Provider` con un registro en `api/price.ts`, pero solo
   `/api/price` la usa. Los otros tres endpoints no pasan por ella.
2. **La capa de catálogo es mono-proveedor por diseño.** `lib/catalog.ts` llama
   `fetchIws()` de Intcomex directamente y guarda **un** catálogo en un
   singleton en memoria (`let enMemoria`). No hay lugar donde poner un segundo.
3. **`lib/search.ts` conoce la forma de Intcomex.** El scoring es bueno y
   conceptualmente agnóstico, pero lee `product.Brand?.Description`,
   `product.Mpn`, `product.Category?.Description`. El tipo `CatalogProduct` es
   literalmente la respuesta cruda de `getcatalog`.
4. **`TAMANO_LOTE = 100` en `api/search.ts` es un límite de Intcomex**, no una
   política nuestra: `getPrices()` lanza `ProviderError` sobre 100 SKUs. Está
   escrito como constante de handler, donde otro proveedor no puede cambiarlo.
5. **La suite tiene 323 tests en verde** y cubre el comportamiento sutil de los
   handlers (paginado por lotes, topes de candidatos 50/300, umbral de
   ambigüedad 25, sobre de errores). Es la red de seguridad del refactor.

### Estado del acceso a los proveedores nuevos

Al momento de escribir este spec, **no tenemos credenciales de Ingram ni de
Tecnoglobal**. Se asume API oficial en ambos casos, pendiente de confirmación
con TI. El diseño aísla el transporte dentro del módulo de cada proveedor, de
modo que si TI vuelve con "archivo periódico" o "solo portal web", cambia el
módulo y no la arquitectura.

**Riesgo abierto, a confirmar con TI junto con las credenciales:** ¿Ingram y
Tecnoglobal ofrecen volcado masivo del catálogo, equivalente a `getcatalog`?
Toda la búsqueda local y las facetas dependen de eso. Si algún proveedor solo
permite consultar producto por producto, `/search` y `/facetas` de ese proveedor
no se pueden construir como los de Intcomex y requieren rediseño de esa parte.

## Alcance

**Incluido:**

- Forma normalizada del producto (`ProductoNormalizado`) y clave de unión para
  la comparación futura.
- Interfaz `Proveedor` real, con registro compartido.
- `lib/catalog.ts` parametrizado por proveedor (memoria + disco).
- Handlers de `/search`, `/product` y `/facetas` convertidos en fábricas.
- Rutas `/api/{proveedor}/{recurso}` en el servidor local y en Vercel.
- Módulos de Ingram y Tecnoglobal implementados contra fixtures.
- Códigos de error nuevos: `proveedor_desconocido`, `proveedor_no_configurado`.

**Fuera de alcance:**

- El endpoint de "mejor precio" / comparación entre proveedores. Es el paso
  siguiente y tiene su propio diseño.
- Cambios en los prompts del agente Rayo (`docs/kapso/`): sigue usando los alias
  de Intcomex, que no cambian.
- Persistencia del caché de catálogo en Vercel (ver Riesgos).
- Márgenes, conversión de moneda y disponibilidad por bodega.

## Arquitectura

```
api/[proveedor]/search.ts ─┐
api/[proveedor]/product.ts ─┼─→ lib/handlers/*.ts (fábricas)
api/[proveedor]/facetas.ts ─┘         │
                                      ├─→ lib/catalog.ts   (catálogo por proveedor)
                                      └─→ lib/providers/index.ts (registro)
                                                │
                                 ┌──────────────┼──────────────┐
                                 │              │              │
                          intcomex.ts      ingram.ts    tecnoglobal.ts
                                 │              │              │
                        (cada uno normaliza a ProductoNormalizado)
```

### Forma normalizada del producto

```ts
export interface ProductoNormalizado {
  sku: string;            // id del proveedor — NO comparable entre proveedores
  mpn: string | null;     // part number del fabricante — la clave de unión
  nombre: string | null;
  marca: string | null;
  categoria: string | null;
  subcategorias: string[];
  tipo: string | null;
}
```

Coincide con lo que `/product` ya devuelve, así que el contrato público no
cambia: desaparece la traducción ad-hoc que hoy hace cada handler.

La normalización ocurre **dentro del módulo de cada proveedor**, en su
`cargarCatalogo()`. `lib/catalog.ts` y `lib/search.ts` nunca ven una respuesta
cruda.

### Clave de unión para la comparación futura

`claveUnion = mpnCompactado + '|' + marcaNormalizada`

- `mpnCompactado`: MPN sin puntuación ni mayúsculas. El mismo producto viaja
  escrito distinto entre distribuidores (`2N6G5LT`, `2N6G5LT#ABM`,
  `2N6G5LT-ABM`). Se reutiliza `tokenizar(mpn).join('')` de `lib/search.ts`,
  que ya hace exactamente esta compactación para el scoring.
- `marcaNormalizada`: `normalizar(marca)`, ya existente.
- **No se usa el SKU**: cada distribuidor tiene el suyo propio.

**Decisión aprobada: un producto sin MPN no se compara.** Aparece en los
resultados de su proveedor, pero queda fuera del "mejor precio". La alternativa
—emparejar por similitud de descripción— produce falsos positivos, y un falso
positivo aquí significa cotizarle al cliente un producto que no es. Se prefiere
perder un match antes que inventar uno.

Este spec no implementa la comparación; define el dato para que sea posible.

### Interfaz del proveedor

```ts
export interface Proveedor {
  nombre: string;
  cargarCatalogo(): Promise<ProductoNormalizado[]>;
  getPrecios(skus: string[]): Promise<Map<string, PriceInfo>>;
  getPrecio(query: PriceQuery): Promise<PriceResult>;
  maxSkusPorLote: number;
  estaConfigurado(): boolean;
}
```

`maxSkusPorLote` migra desde `TAMANO_LOTE` en `api/search.ts`: es un límite del
proveedor y pertenece al proveedor. Los topes `MAX_CANDIDATOS_SIN_FILTROS` (50)
y `MAX_CANDIDATOS_CON_FILTROS` (300) **se quedan en el handler**: esos sí son
política nuestra sobre cuánto vale la pena cotizar, no un límite externo.

`estaConfigurado()` reporta si el módulo tiene sus credenciales. Sostiene el
error `proveedor_no_configurado` descrito más abajo.

El registro vive en `lib/providers/index.ts`:

```ts
export const PROVEEDORES: Record<string, Proveedor> = { intcomex, ingram, tecnoglobal };
```

`api/price.ts` deja su registro local y usa este.

### Capa de catálogo

```ts
obtenerCatalogo(proveedor: string): ProductoNormalizado[]         // throws CatalogUnavailableError
cargarCatalogo(proveedor: string): Promise<ProductoNormalizado[]>
```

- En memoria: `Map<proveedor, ProductoNormalizado[]>` en lugar del singleton.
- En disco: `cache/catalog-<proveedor>.json`.
- Vigencia de 24 h por proveedor, con el mismo comportamiento actual: si la
  descarga falla y hay caché vencido, se usa el vencido y se registra el error.
  Un surtido viejo sirve mucho más que ninguno, porque el precio siempre se
  consulta aparte.
- `server.ts` refresca los tres en paralelo, con reintento independiente por
  proveedor: que Tecnoglobal esté caído no puede dejar sin catálogo a Intcomex.

**Cambio de configuración aprobado:** `CATALOG_CACHE_PATH` (un archivo) pasa a
`CATALOG_CACHE_DIR` (una carpeta, default `cache/`). Hay que actualizar
`.env.local`, `.env.example` y las variables del proyecto en Vercel.

### Rutas y contrato HTTP

| Ruta | Comportamiento |
|---|---|
| `/api/{proveedor}/search` | Igual que `/api/search`, contra el catálogo del proveedor |
| `/api/{proveedor}/product` | Igual que `/api/product` |
| `/api/{proveedor}/facetas` | Igual que `/api/facetas` |
| `/api/search`, `/api/product`, `/api/facetas` | **Se mantienen** como alias de `intcomex` |
| `/api/price?provider=` | Sin cambios, salvo que usa el registro compartido |

`{proveedor}` ∈ `intcomex | ingram | tecnoglobal`.

La lógica de los tres handlers se muda a `lib/handlers/` como fábricas
(`crearHandlerBusqueda(proveedor)`, `crearHandlerProducto(proveedor)`,
`crearHandlerFacetas(proveedor)`). Todo archivo bajo `api/` queda como
envoltorio de pocas líneas: los de `api/[proveedor]/` resuelven el proveedor
desde `req.query.proveedor`, y los alias de `api/` lo fijan en `intcomex`. Una
sola implementación detrás de todas las rutas.

En `lib/server.ts` la tabla de rutas se genera por producto cartesiano
proveedores × recursos, y el patrón `/product/{sku}` se extiende para aceptar el
prefijo de proveedor. `/api/{proveedor}/product` acepta el SKU por query param o
por path, igual que hoy.

Los alias existen para que el agente Rayo no se entere del cambio: sus prompts y
sus tools siguen apuntando a `/api/search` y `/api/product` y siguen recibiendo
exactamente la misma respuesta.

### Manejo de errores

El sobre `{ error, detail }` no cambia. Dos agregados:

**`proveedor` en el cuerpo de los errores** de endpoints con proveedor en la
ruta. Es aditivo, no rompe consumidores, y el módulo de comparación lo va a
necesitar: cuando consulte a los tres y uno falle, tiene que saber cuál para
decidir si responde con dos precios o aborta.

**Códigos nuevos:**

| Código | HTTP | Cuándo |
|---|---|---|
| `proveedor_desconocido` | 404 | El segmento de ruta no corresponde a un proveedor registrado |
| `proveedor_no_configurado` | 503 | El proveedor existe pero le faltan credenciales |

`proveedor_no_configurado` merece existir porque hoy ese caso saldría como
`502 upstream`, que miente: no falló nadie aguas arriba, falta configuración
nuestra. Y va a ocurrir de forma permanente mientras TI no entregue las llaves,
así que la distinción en los logs entre "Ingram está caído" e "Ingram nunca se
configuró" es la diferencia entre investigar y no investigar.

**Asimetría conocida y aceptada:** `/api/price?provider=nadie` sigue devolviendo
`400 bad_request` en vez de `404 proveedor_desconocido`, porque ahí el proveedor
es query param y cambiar el código rompería a quien ya consuma ese endpoint.

## Estrategia de tests

Los 323 tests actuales son la red del refactor. Regla dura:

> **Ninguna aserción de contrato de `/api/search`, `/api/product` o
> `/api/facetas` puede cambiar.** Son los alias de Intcomex. Si uno falla
> durante el refactor es una regresión real, no un test desactualizado.

Cambios esperados y legítimos:

- `tests/search.test.ts` (21 tests) cambia la forma del dato de entrada
  (`CatalogProduct` → `ProductoNormalizado`). Mecánico.
- `tests/catalog.test.ts` (8 tests) cambia por la firma parametrizada.

Tests nuevos:

- Normalización por proveedor, contra fixtures de respuesta.
- `tests/contrato-errores.test.ts` parametrizado por proveedor.
- Paridad de contrato: los tres proveedores devuelven las mismas llaves en
  `/product`.
- `proveedor_desconocido` y `proveedor_no_configurado`.

**Limitación que se reporta como tal:** sin credenciales, los módulos de Ingram
y Tecnoglobal se testean contra fixtures escritas a partir de la documentación.
Eso demuestra que **nuestra** normalización es correcta, no que acertamos la
forma real de la respuesta del proveedor. Hasta capturar una respuesta real,
esos dos módulos quedan marcados como **no verificados contra la realidad**.

## Orden de implementación

| # | Paso | ¿Necesita credenciales? |
|---|---|---|
| 1 | `ProductoNormalizado` + refactor de `lib/search.ts`, sin tocar la API pública | No |
| 2 | Catálogo por proveedor + registro + rutas, solo con Intcomex registrado | No |
| 3 | Módulo de Ingram contra fixtures | No |
| 4 | Módulo de Tecnoglobal contra fixtures | No |
| 5 | Cablear credenciales reales, capturar respuestas, reemplazar fixtures | **Sí** |

Los pasos 1 y 2 concentran el riesgo del refactor y no dependen de TI: se pueden
hacer de inmediato. Cuando lleguen las credenciales, lo que falta es enchufar.

## Riesgos

1. **Volcado masivo de catálogo no confirmado** en Ingram y Tecnoglobal. Es el
   supuesto más grande del diseño. Confirmar con TI antes del paso 3.
2. **El caché en disco no persiste en Vercel.** Ya es un problema latente con un
   catálogo; con tres se triplican la memoria residente y la descarga en arranque
   frío. Fuera de alcance aquí, pero hay que resolverlo antes de que los tres
   proveedores estén en producción — probablemente moviendo el caché a Vercel
   Blob o a un almacenamiento del Marketplace.
3. **Volumen del catálogo de Ingram.** Puede ser un orden de magnitud mayor que
   los ~10.300 productos de Intcomex. Si es así, el motor de búsqueda en memoria
   necesita revisión de rendimiento.
4. **Monedas distintas entre proveedores.** Intcomex cotiza en USD. Si Ingram o
   Tecnoglobal cotizan en CLP, comparar precios exige conversión, y una tasa de
   cambio es una decisión de negocio, no técnica. Bloquea la comparación, no este
   diseño.
