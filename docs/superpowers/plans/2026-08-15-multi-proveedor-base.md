# Base multi-proveedor — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convertir la API mono-proveedor (Intcomex) en una base multi-proveedor real, sin cambiar una sola respuesta de las rutas que el agente Rayo ya consume.

**Architecture:** Cada proveedor normaliza su catálogo a `ProductoNormalizado` dentro de su propio módulo. `lib/catalog.ts` pasa de un singleton a un catálogo por proveedor. La lógica de los tres handlers se muda a fábricas en `lib/handlers/`, y los archivos bajo `api/` quedan como envoltorios: los de `api/[proveedor]/` resuelven el proveedor desde la ruta, los de `api/` lo fijan en `intcomex`.

**Tech Stack:** TypeScript ESM sobre Node ≥20, vitest, `@vercel/node`. Sin dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-08-15-multi-proveedor-design.md`

## Alcance de este plan

Cubre los **pasos 1 y 2** del spec: el refactor provider-agnostic, con **solo Intcomex registrado**. Concentra todo el riesgo de regresión y no depende de credenciales.

Los módulos de Ingram y Tecnoglobal (pasos 3–5 del spec) **quedan fuera a propósito**: sin la documentación de sus APIs, cualquier código de mapeo sería un contrato inventado. Van en un plan aparte cuando TI entregue acceso.

Al terminar este plan: `/api/intcomex/search|product|facetas` funcionando, `/api/search|product|facetas` respondiendo idéntico a hoy, y agregar un proveedor nuevo reducido a escribir un módulo que implemente `Proveedor` y registrarlo en un objeto.

**Difiere al segundo plan:** el test de paridad de contrato entre los tres proveedores que pide el spec. Con un solo proveedor registrado no hay nada que comparar; aquí se cubre la paridad que sí es verificable hoy — que `/api/intcomex/search` responda idéntico al alias `/api/search` (Task 8).

## Global Constraints

- **Ninguna aserción de contrato de `/api/search`, `/api/product` o `/api/facetas` puede cambiar.** Son los alias de Intcomex. Si un test de `tests/search-endpoint.test.ts`, `tests/product-endpoint.test.ts` o `tests/contrato-errores.test.ts` falla, es una regresión real — se arregla el código, no el test.
- La suite arranca en **323 tests en verde**. `npm test` debe quedar en verde al final de cada tarea.
- `npm run typecheck` debe pasar al final de cada tarea.
- Español para nombres de dominio (`buscar`, `catalogo`, `proveedor`) y comentarios; inglés donde el código ya lo usa (`getPrices`, `PriceInfo`). Seguir el estilo del archivo que se toca.
- Los comentarios explican **por qué**, no qué. El repo ya sigue esa norma.
- `MAX_CANDIDATOS_SIN_FILTROS = 50` y `MAX_CANDIDATOS_CON_FILTROS = 300` son política del handler y **no** se mueven al proveedor. `TAMANO_LOTE` sí: es un límite de Intcomex.
- Commit por tarea, no por paso.

---

### Task 1: Extraer la normalización de texto a `lib/texto.ts`

Prepara el terreno: `lib/producto.ts` (Task 2) necesita `tokenizar`, y `lib/search.ts` va a necesitar `ProductoNormalizado`. Sin este movimiento previo queda un ciclo de imports entre ambos.

**Files:**
- Create: `lib/texto.ts`
- Modify: `lib/search.ts` (quitar `normalizar`/`tokenizar`, re-exportarlas)
- Test: `tests/search.test.ts` (sin cambios — debe seguir pasando tal cual)

**Interfaces:**
- Consumes: nada.
- Produces: `normalizar(texto: string): string`, `tokenizar(texto: string): string[]` desde `lib/texto.js`. `lib/search.js` las sigue re-exportando.

- [ ] **Step 1: Crear `lib/texto.ts` con las dos funciones movidas tal cual**

```ts
export function normalizar(texto: string): string {
  // U+0300-U+036F = marcas diacríticas combinantes que NFD separa de la letra.
  return texto.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

export function tokenizar(texto: string): string[] {
  return normalizar(texto)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}
```

- [ ] **Step 2: En `lib/search.ts`, borrar ambas definiciones y re-exportarlas**

Reemplazar los cuerpos de `normalizar` y `tokenizar` por, al tope del archivo:

```ts
import { normalizar, tokenizar } from './texto.js';

export { normalizar, tokenizar };
```

El re-export importa: `tests/search.test.ts` y `api/search.ts` importan `tokenizar` desde `lib/search.js` y no deben cambiar en esta tarea.

- [ ] **Step 3: Correr la suite completa**

Run: `npm test`
Expected: 323 passed. Es un movimiento puro; cualquier fallo significa que el re-export quedó mal.

- [ ] **Step 4: Typecheck**

Run: `npm run typecheck`
Expected: sin salida (OK).

- [ ] **Step 5: Commit**

```bash
git add lib/texto.ts lib/search.ts
git commit -m "refactor: extraer normalizar/tokenizar a lib/texto.ts"
```

---

### Task 2: `ProductoNormalizado` y la clave de unión

**Files:**
- Create: `lib/producto.ts`
- Test: `tests/producto.test.ts`

**Interfaces:**
- Consumes: `tokenizar`, `normalizar` de `lib/texto.js`.
- Produces:
  - `interface ProductoNormalizado { sku: string; mpn: string | null; nombre: string | null; marca: string | null; categoria: string | null; subcategorias: string[]; tipo: string | null }`
  - `compactarMpn(mpn: string | null): string` — string vacío si no hay MPN utilizable.
  - `claveUnion(p: ProductoNormalizado): string | null` — `null` cuando el producto no se puede comparar.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `tests/producto.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { claveUnion, compactarMpn } from '../lib/producto.js';
import type { ProductoNormalizado } from '../lib/producto.js';

function producto(campos: Partial<ProductoNormalizado>): ProductoNormalizado {
  return {
    sku: 'SKU1',
    mpn: null,
    nombre: null,
    marca: null,
    categoria: null,
    subcategorias: [],
    tipo: null,
    ...campos,
  };
}

describe('compactarMpn', () => {
  it('quita puntuacion y mayusculas', () => {
    expect(compactarMpn('2N6G5LT#ABM')).toBe('2n6g5ltabm');
  });

  // El mismo producto viaja escrito distinto entre distribuidores: si la
  // compactacion no los junta, la comparacion de precios nunca los empareja.
  it('iguala las variantes de un mismo MPN', () => {
    expect(compactarMpn('2N6G5LT-ABM')).toBe(compactarMpn('2N6G5LT#ABM'));
    expect(compactarMpn('920-008813')).toBe(compactarMpn('920 008813'));
  });

  it('devuelve vacio para un MPN ausente o sin caracteres utiles', () => {
    expect(compactarMpn(null)).toBe('');
    expect(compactarMpn('   ')).toBe('');
    expect(compactarMpn('---')).toBe('');
  });
});

describe('claveUnion', () => {
  it('combina MPN compactado y marca normalizada', () => {
    expect(claveUnion(producto({ mpn: '2N6G5LT#ABM', marca: 'HP' }))).toBe('2n6g5ltabm|hp');
  });

  it('empareja el mismo producto escrito distinto por dos proveedores', () => {
    const a = producto({ sku: 'NT016HPQ53', mpn: '2N6G5LT#ABM', marca: 'HP' });
    const b = producto({ sku: 'IM-99887', mpn: '2n6g5lt-abm', marca: 'hp' });
    expect(claveUnion(a)).toBe(claveUnion(b));
  });

  it('no empareja el mismo MPN de marcas distintas', () => {
    const a = producto({ mpn: 'X100', marca: 'HP' });
    const b = producto({ mpn: 'X100', marca: 'Dell' });
    expect(claveUnion(a)).not.toBe(claveUnion(b));
  });

  // Decision del spec: sin MPN no se compara. Preferimos perder un match
  // antes que inventarlo: un falso positivo aqui cotiza un producto que no es.
  it('devuelve null cuando no hay MPN', () => {
    expect(claveUnion(producto({ mpn: null, marca: 'HP' }))).toBeNull();
    expect(claveUnion(producto({ mpn: '---', marca: 'HP' }))).toBeNull();
  });

  it('devuelve null cuando no hay marca', () => {
    expect(claveUnion(producto({ mpn: 'X100', marca: null }))).toBeNull();
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/producto.test.ts`
Expected: FAIL — no se puede resolver `../lib/producto.js`.

- [ ] **Step 3: Implementar `lib/producto.ts`**

```ts
import { normalizar, tokenizar } from './texto.js';

export interface ProductoNormalizado {
  /** Identificador del proveedor. NO es comparable entre proveedores. */
  sku: string;
  /** Part number del fabricante: la unica pista comun entre distribuidores. */
  mpn: string | null;
  nombre: string | null;
  marca: string | null;
  categoria: string | null;
  subcategorias: string[];
  tipo: string | null;
}

/**
 * Un mismo MPN viaja escrito distinto segun el distribuidor (2N6G5LT#ABM,
 * 2N6G5LT-ABM, "2N6G5LT ABM"). Se compacta a solo letras y numeros para que
 * las variantes colapsen en la misma clave.
 */
export function compactarMpn(mpn: string | null): string {
  return tokenizar(mpn ?? '').join('');
}

/**
 * Clave para emparejar el mismo producto entre proveedores.
 *
 * Devuelve null cuando el producto no se puede comparar con confianza: sin MPN
 * o sin marca queda fuera del "mejor precio" en vez de arriesgar un falso
 * positivo, porque emparejar mal significa cotizarle al cliente otro producto.
 */
export function claveUnion(producto: ProductoNormalizado): string | null {
  const mpn = compactarMpn(producto.mpn);
  const marca = normalizar(producto.marca ?? '').trim();
  if (!mpn || !marca) return null;
  return `${mpn}|${marca}`;
}
```

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npx vitest run tests/producto.test.ts`
Expected: PASS, 9 tests.

- [ ] **Step 5: Suite completa y typecheck**

Run: `npm test && npm run typecheck`
Expected: 332 passed, typecheck OK.

- [ ] **Step 6: Commit**

```bash
git add lib/producto.ts tests/producto.test.ts
git commit -m "feat: ProductoNormalizado y clave de union por MPN + marca"
```

---

### Task 3: Intcomex normaliza su propio catálogo

Adición pura: nada la consume todavía, así que la suite no puede romperse.

**Files:**
- Modify: `lib/providers/intcomex.ts`
- Test: `tests/intcomex-catalogo.test.ts` (crear)

**Interfaces:**
- Consumes: `ProductoNormalizado` de `lib/producto.js`.
- Produces, desde `lib/providers/intcomex.js`:
  - `interface ProductoIntcomex` — la forma cruda de `getcatalog` (lo que hoy es `CatalogProduct` en `lib/search.ts`).
  - `normalizarProducto(crudo: ProductoIntcomex): ProductoNormalizado`
  - `cargarCatalogoIntcomex(): Promise<ProductoNormalizado[]>` — descarga `getcatalog`, valida y normaliza.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `tests/intcomex-catalogo.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cargarCatalogoIntcomex, normalizarProducto } from '../lib/providers/intcomex.js';

beforeEach(() => {
  vi.stubEnv('INTCOMEX_API_KEY', 'pub');
  vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret-key');
  vi.stubEnv('INTCOMEX_BASE_URL', 'https://intcomex-prod.apigee.net/v1/');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const CRUDO = {
  Sku: 'NT016HPQ53',
  Mpn: '2N6G5LT#ABM',
  Description: 'HP ProBook 640 G8 - Notebook - 14"',
  Type: 'Physical',
  Brand: { Description: 'HP' },
  Category: { Description: 'Computadores', Subcategories: [{ Description: 'Notebooks' }] },
};

describe('normalizarProducto', () => {
  it('traduce la forma de Intcomex a la forma comun', () => {
    expect(normalizarProducto(CRUDO)).toEqual({
      sku: 'NT016HPQ53',
      mpn: '2N6G5LT#ABM',
      nombre: 'HP ProBook 640 G8 - Notebook - 14"',
      marca: 'HP',
      categoria: 'Computadores',
      subcategorias: ['Notebooks'],
      tipo: 'Physical',
    });
  });

  it('convierte los campos ausentes en null, no en undefined', () => {
    const p = normalizarProducto({ Sku: 'X1' });
    expect(p).toEqual({
      sku: 'X1',
      mpn: null,
      nombre: null,
      marca: null,
      categoria: null,
      subcategorias: [],
      tipo: null,
    });
  });

  it('descarta subcategorias sin descripcion en vez de dejar huecos', () => {
    const p = normalizarProducto({
      Sku: 'X1',
      Category: { Description: 'C', Subcategories: [{ Description: null }, { Description: 'Buena' }] },
    });
    expect(p.subcategorias).toEqual(['Buena']);
  });
});

describe('cargarCatalogoIntcomex', () => {
  it('pide getcatalog y devuelve productos ya normalizados', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([CRUDO]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const productos = await cargarCatalogoIntcomex();

    expect((fetchMock.mock.calls[0][0] as URL).href).toContain('/v1/getcatalog');
    expect(productos).toHaveLength(1);
    expect(productos[0].marca).toBe('HP');
  });

  it('rechaza un 200 que no es un arreglo (rate limit de apigee)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ Message: 'Rate limit exceeded' }), { status: 200 }),
    ));
    await expect(cargarCatalogoIntcomex()).rejects.toThrow();
  });

  it('rechaza un arreglo vacio', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })));
    await expect(cargarCatalogoIntcomex()).rejects.toThrow();
  });

  it('rechaza un HTTP no-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    await expect(cargarCatalogoIntcomex()).rejects.toThrow();
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/intcomex-catalogo.test.ts`
Expected: FAIL — `normalizarProducto` no está exportada.

- [ ] **Step 3: Implementar en `lib/providers/intcomex.ts`**

Agregar al archivo (importar `ProductoNormalizado` de `../producto.js`):

```ts
export interface ProductoIntcomex {
  Sku: string;
  Mpn?: string | null;
  Description?: string | null;
  Type?: string | null;
  Brand?: { Description?: string | null } | null;
  Category?: {
    Description?: string | null;
    Subcategories?: { Description?: string | null }[];
  } | null;
}

export function normalizarProducto(crudo: ProductoIntcomex): ProductoNormalizado {
  return {
    sku: crudo.Sku,
    mpn: crudo.Mpn ?? null,
    nombre: crudo.Description ?? null,
    marca: crudo.Brand?.Description ?? null,
    categoria: crudo.Category?.Description ?? null,
    subcategorias: (crudo.Category?.Subcategories ?? [])
      .map((s) => s.Description)
      .filter((d): d is string => Boolean(d)),
    tipo: crudo.Type ?? null,
  };
}

export async function cargarCatalogoIntcomex(): Promise<ProductoNormalizado[]> {
  const response = await fetchIws('getcatalog');
  if (!response.ok) {
    throw new Error(`Intcomex respondió HTTP ${response.status} al pedir el catálogo`);
  }
  const datos = await response.json();
  if (!Array.isArray(datos) || datos.length === 0) {
    throw new Error('getcatalog no devolvio un arreglo de productos');
  }
  return (datos as ProductoIntcomex[]).map(normalizarProducto);
}
```

Es el mismo cuerpo que hoy tiene `descargar()` en `lib/catalog.ts`, más el `.map`. La versión de `lib/catalog.ts` se borra en la Task 4.

- [ ] **Step 4: Correr y verificar que pasa**

Run: `npx vitest run tests/intcomex-catalogo.test.ts`
Expected: PASS, 7 tests.

- [ ] **Step 5: Suite completa y typecheck**

Run: `npm test && npm run typecheck`
Expected: 339 passed, typecheck OK.

- [ ] **Step 6: Commit**

```bash
git add lib/providers/intcomex.ts tests/intcomex-catalogo.test.ts
git commit -m "feat: Intcomex normaliza su catalogo a ProductoNormalizado"
```

---

### Task 4: El switch — todo el sistema opera sobre `ProductoNormalizado`

**Esta tarea es atómica a propósito.** Cambiar la forma del dato toca el catálogo, el buscador y los tres handlers a la vez; dejarla a medias deja la suite roja. Es la tarea de mayor riesgo del plan.

**Files:**
- Modify: `lib/catalog.ts` (usa `cargarCatalogoIntcomex`, borra `descargar()`)
- Modify: `lib/search.ts` (`buscar`/`calcularFacetas` leen los campos nuevos; borra `CatalogProduct`)
- Modify: `api/search.ts`, `api/product.ts` (dejan de traducir campos crudos)
- Test: `tests/search.test.ts`, `tests/catalog.test.ts`, `tests/search-endpoint.test.ts`, `tests/product-endpoint.test.ts`, `tests/contrato-errores.test.ts`

**Interfaces:**
- Consumes: `ProductoNormalizado` (Task 2), `cargarCatalogoIntcomex` (Task 3).
- Produces: `buscar(catalogo: ProductoNormalizado[], filtros: SearchFilters): ScoredProduct[]` con `ScoredProduct = { product: ProductoNormalizado; score: number }`. `calcularFacetas(productos: ProductoNormalizado[]): Facetas`. `CatalogProduct` deja de existir.

- [ ] **Step 1: Migrar los helpers de los tests a la forma nueva**

En `tests/search.test.ts`, reemplazar el helper y el tipo importado:

```ts
import type { ProductoNormalizado } from '../lib/producto.js';

function producto(
  sku: string,
  mpn: string,
  nombre: string,
  marca: string,
  categoria = 'Computadores',
): ProductoNormalizado {
  return { sku, mpn, nombre, marca, categoria, subcategorias: [], tipo: null };
}
```

Y en las aserciones, `r.product.Sku` pasa a `r.product.sku`. Los valores esperados **no cambian**: mismos SKUs, mismo orden. Si un test de ranking cambia de resultado, el scoring se rompió.

En `tests/search-endpoint.test.ts`, `tests/product-endpoint.test.ts` y `tests/contrato-errores.test.ts`, el helper `producto()` y la constante `PRODUCTO` pasan a construir `ProductoNormalizado` (campos en minúscula). **Las aserciones sobre `res.body` no se tocan**: la respuesta HTTP es la misma.

- [ ] **Step 2: Correr y verificar que falla**

Run: `npm test`
Expected: FAIL en `tests/search.test.ts` — `buscar` lee `product.Brand?.Description`, que ahora es `undefined`, así que ningún producto puntúa.

- [ ] **Step 3: `lib/search.ts` lee los campos nuevos**

Borrar la interfaz `CatalogProduct` e importar `ProductoNormalizado`. Reemplazos, uno a uno:

```ts
// en puntuar()
const mpnNormalizado = normalizar(product.mpn ?? '');
const mpnCompacto = tokenizar(product.mpn ?? '').join('');
const tokensMarca = new Set(tokenizar(product.marca ?? ''));
const tokensDescripcion = new Set(tokenizar(product.nombre ?? ''));

// en buscar()
if (marca && normalizar(product.marca ?? '') !== marca) continue;
if (categoria && normalizar(product.categoria ?? '') !== categoria) continue;

// en calcularFacetas()
marca: contar(productos.map((p) => p.marca)),
categoria: contar(productos.map((p) => p.categoria)),
```

`ScoredProduct.product` pasa a `ProductoNormalizado`. La lógica de puntaje no se toca: mismos pesos, mismas reglas.

- [ ] **Step 4: `lib/catalog.ts` usa el cargador del proveedor**

Borrar `descargar()` y el import de `fetchIws`. `CacheEnDisco.productos` pasa a `ProductoNormalizado[]`, y en `cargarCatalogo()`:

```ts
const productos = await cargarCatalogoIntcomex();
```

- [ ] **Step 5: Los handlers dejan de traducir**

En `api/search.ts`, el armado de `Cotizado` se simplifica — los campos ya vienen normalizados:

```ts
const cotizado: Cotizado = {
  sku: p.sku,
  mpn: p.mpn,
  nombre: p.nombre,
  marca: p.marca,
  categoria: p.categoria,
  precio: precio.price,
  moneda: precio.currency,
  stock: precio.inStock,
};
```

Y `getPrices(lote.map((p) => p.Sku))` pasa a `getPrices(lote.map((p) => p.sku))`.

En `api/product.ts`, el `catalogo.find` y la respuesta:

```ts
const producto = catalogo.find((p) => p.sku === sku);
...
res.status(200).json({
  sku: producto.sku,
  mpn: producto.mpn,
  nombre: producto.nombre,
  marca: producto.marca,
  categoria: producto.categoria,
  subcategorias: producto.subcategorias,
  tipo: producto.tipo,
  precio: precio.price,
  moneda: precio.currency,
  stock: precio.inStock,
});
```

- [ ] **Step 6: Correr la suite completa**

Run: `npm test`
Expected: 339 passed. **Cero cambios en aserciones de `res.body`** respecto al commit anterior — si alguna hubo que tocar, es una regresión del contrato y hay que arreglar el código.

- [ ] **Step 7: Typecheck**

Run: `npm run typecheck`
Expected: OK. Debe quedar cero referencias a `CatalogProduct`; verificar con `grep -rn "CatalogProduct" lib api tests` → vacío.

- [ ] **Step 8: Commit**

```bash
git add lib/ api/ tests/
git commit -m "refactor: todo el sistema opera sobre ProductoNormalizado"
```

---

### Task 5: Catálogo por proveedor

**Files:**
- Modify: `lib/catalog.ts`
- Test: `tests/catalog.test.ts`

**Interfaces:**
- Produces: `obtenerCatalogo(proveedor: string): ProductoNormalizado[]`, `cargarCatalogo(proveedor: string): Promise<ProductoNormalizado[]>`, `_resetCatalogoParaTests(): void`. Env: `CATALOG_CACHE_DIR` (default `cache/`) reemplaza a `CATALOG_CACHE_PATH`.

- [ ] **Step 1: Escribir los tests que fallan**

En `tests/catalog.test.ts`, cambiar el `beforeEach` a un directorio y agregar los casos nuevos:

```ts
let cacheDir: string;

beforeEach(() => {
  cacheDir = mkdtempSync(join(tmpdir(), 'cat-'));
  vi.stubEnv('CATALOG_CACHE_DIR', cacheDir);
  // ...las tres env de Intcomex igual que antes
  _resetCatalogoParaTests();
});
```

Todas las llamadas existentes pasan a `cargarCatalogo('intcomex')` / `obtenerCatalogo('intcomex')`, y `cachePath` pasa a `join(cacheDir, 'catalog-intcomex.json')`. Agregar:

```ts
it('cachea cada proveedor en su propio archivo', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(ITEMS), { status: 200 })));
  await cargarCatalogo('intcomex');
  expect(existsSync(join(cacheDir, 'catalog-intcomex.json'))).toBe(true);
});

it('un proveedor cargado no deja disponible a otro', async () => {
  vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(JSON.stringify(ITEMS), { status: 200 })));
  await cargarCatalogo('intcomex');
  expect(obtenerCatalogo('intcomex')).toHaveLength(2);
  expect(() => obtenerCatalogo('ingram')).toThrow(CatalogUnavailableError);
});

it('lanza para un proveedor que no existe', async () => {
  await expect(cargarCatalogo('nadie')).rejects.toThrow();
});
```

`ITEMS` pasa a la forma normalizada:

```ts
const ITEMS = [
  { sku: 'A1', mpn: 'M1', nombre: 'Producto uno', marca: 'HP', categoria: null, subcategorias: [], tipo: null },
  { sku: 'B2', mpn: 'M2', nombre: 'Producto dos', marca: 'Dell', categoria: null, subcategorias: [], tipo: null },
];
```

Ojo: los tests que mockean `fetch` para `getcatalog` devuelven forma **cruda** de Intcomex, no `ITEMS`. Mantener esa distinción: lo que va al disco es normalizado, lo que devuelve la red es crudo.

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/catalog.test.ts`
Expected: FAIL — `cargarCatalogo` no acepta argumento.

- [ ] **Step 3: Implementar el catálogo parametrizado**

```ts
const enMemoria = new Map<string, ProductoNormalizado[]>();

const CARGADORES: Record<string, () => Promise<ProductoNormalizado[]>> = {
  intcomex: cargarCatalogoIntcomex,
};

function rutaCache(proveedor: string): string {
  const dir = process.env.CATALOG_CACHE_DIR ?? 'cache';
  return join(dir, `catalog-${proveedor}.json`);
}

export function obtenerCatalogo(proveedor: string): ProductoNormalizado[] {
  const productos = enMemoria.get(proveedor);
  if (!productos) throw new CatalogUnavailableError();
  return productos;
}

export async function cargarCatalogo(proveedor: string): Promise<ProductoNormalizado[]> {
  const cargador = CARGADORES[proveedor];
  if (!cargador) throw new Error(`Proveedor desconocido: ${proveedor}`);
  // ...resto igual que hoy, pero usando rutaCache(proveedor), cargador() y
  // enMemoria.set(proveedor, productos) en vez del singleton.
}

export function _resetCatalogoParaTests(): void {
  enMemoria.clear();
}
```

`CARGADORES` es provisorio: en la Task 6 pasa a leerse del registro de proveedores. Se deja así ahora para no acoplar dos tareas.

- [ ] **Step 4: Actualizar los llamadores**

`api/search.ts`, `api/product.ts`, `api/facetas.ts` pasan a `obtenerCatalogo('intcomex')`. `server.ts` pasa a `cargarCatalogo('intcomex')`.

- [ ] **Step 5: Actualizar la configuración**

En `.env.example`, reemplazar la línea de `CATALOG_CACHE_PATH` por:

```
# Carpeta donde se cachea el catalogo de cada proveedor (opcional; default cache/)
CATALOG_CACHE_DIR=
```

Hacer el mismo cambio en `.env.local` si tiene la variable puesta.

- [ ] **Step 6: Suite completa y typecheck**

Run: `npm test && npm run typecheck`
Expected: verde. Ninguna aserción de `res.body` cambió.

- [ ] **Step 7: Commit**

```bash
git add lib/catalog.ts api/ server.ts tests/catalog.test.ts .env.example
git commit -m "feat: catalogo por proveedor con cache independiente"
```

---

### Task 6: Interfaz `Proveedor` y registro compartido

**Files:**
- Modify: `lib/types.ts` (agregar `Proveedor`, borrar `Provider`)
- Modify: `lib/providers/intcomex.ts` (exportar el objeto `Proveedor` completo)
- Create: `lib/providers/index.ts`
- Modify: `lib/catalog.ts` (usa el registro), `api/price.ts` (usa el registro)
- Test: `tests/proveedores.test.ts` (crear)

**Interfaces:**
- Produces: `PROVEEDORES: Record<string, Proveedor>` desde `lib/providers/index.js`, con `intcomex` como única entrada.

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

- [ ] **Step 1: Escribir los tests que fallan**

Crear `tests/proveedores.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { PROVEEDORES } from '../lib/providers/index.js';

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('registro de proveedores', () => {
  it('expone intcomex', () => {
    expect(Object.keys(PROVEEDORES)).toContain('intcomex');
  });

  // Todo proveedor tiene que cumplir el contrato completo, o los handlers
  // genericos se rompen recien en runtime contra ese proveedor.
  it.each(Object.entries(PROVEEDORES))('%s cumple la interfaz Proveedor', (nombre, proveedor) => {
    expect(proveedor.nombre).toBe(nombre);
    expect(typeof proveedor.cargarCatalogo).toBe('function');
    expect(typeof proveedor.getPrecios).toBe('function');
    expect(typeof proveedor.getPrecio).toBe('function');
    expect(typeof proveedor.estaConfigurado).toBe('function');
    expect(proveedor.maxSkusPorLote).toBeGreaterThan(0);
  });
});

describe('estaConfigurado', () => {
  it('es false si falta alguna credencial de Intcomex', () => {
    vi.stubEnv('INTCOMEX_API_KEY', '');
    vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret');
    vi.stubEnv('INTCOMEX_BASE_URL', 'https://x/');
    expect(PROVEEDORES.intcomex.estaConfigurado()).toBe(false);
  });

  it('es true con las tres credenciales puestas', () => {
    vi.stubEnv('INTCOMEX_API_KEY', 'pub');
    vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret');
    vi.stubEnv('INTCOMEX_BASE_URL', 'https://x/');
    expect(PROVEEDORES.intcomex.estaConfigurado()).toBe(true);
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/proveedores.test.ts`
Expected: FAIL — no existe `lib/providers/index.js`.

- [ ] **Step 3: Definir `Proveedor` en `lib/types.ts`**

Agregar la interfaz de arriba (importando `ProductoNormalizado` de `./producto.js`) y borrar la interfaz `Provider`, que queda subsumida.

- [ ] **Step 4: Completar el objeto `intcomex`**

En `lib/providers/intcomex.ts`, reemplazar `export const intcomex: Provider` por:

```ts
export const intcomex: Proveedor = {
  nombre: 'intcomex',
  maxSkusPorLote: MAX_SKUS_POR_LLAMADA,
  estaConfigurado: () =>
    Boolean(process.env.INTCOMEX_API_KEY && process.env.INTCOMEX_ACCESS_KEY && process.env.INTCOMEX_BASE_URL),
  cargarCatalogo: cargarCatalogoIntcomex,
  getPrecios: getPrices,
  async getPrecio(query: PriceQuery): Promise<PriceResult> {
    // ...el cuerpo actual de getPrice, sin cambios
  },
};
```

Mover la constante `MAX_SKUS_POR_LLAMADA` por encima del objeto. `getPrices` y `getPrice` siguen exportadas sueltas: los tests existentes las importan así.

- [ ] **Step 5: Crear el registro**

```ts
// lib/providers/index.ts
import type { Proveedor } from '../types.js';
import { intcomex } from './intcomex.js';

// Ingram y Tecnoglobal entran aca cuando sus modulos existan.
export const PROVEEDORES: Record<string, Proveedor> = { intcomex };
```

- [ ] **Step 6: Que `lib/catalog.ts` y `api/price.ts` usen el registro**

En `lib/catalog.ts`, borrar `CARGADORES` y resolver contra `PROVEEDORES[proveedor]?.cargarCatalogo()`. En `api/price.ts`, borrar el objeto `providers` local e importar `PROVEEDORES`; `provider.getPrice(...)` pasa a `proveedor.getPrecio(...)`.

- [ ] **Step 7: Suite completa y typecheck**

Run: `npm test && npm run typecheck`
Expected: verde. `tests/price-endpoint.test.ts` mockea el módulo de Intcomex: ajustar el mock para que exporte `intcomex` con `getPrecio` en vez de `getPrice`. Es un cambio de mock, no de aserción.

- [ ] **Step 8: Commit**

```bash
git add lib/ api/price.ts tests/
git commit -m "feat: interfaz Proveedor e indice compartido de proveedores"
```

---

### Task 7: Handlers como fábricas

**Files:**
- Create: `lib/handlers/tipos.ts`, `lib/handlers/busqueda.ts`, `lib/handlers/producto.ts`, `lib/handlers/facetas.ts`
- Modify: `api/search.ts`, `api/product.ts`, `api/facetas.ts` (quedan como envoltorios)
- Test: los tres tests de endpoint existentes deben pasar sin tocar aserciones

- [ ] **Step 0: Crear el tipo compartido**

```ts
// lib/handlers/tipos.ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

export type Handler = (req: VercelRequest, res: VercelResponse) => Promise<void>;
```

**Interfaces:**
- Produces, desde `lib/handlers/busqueda.js`, `lib/handlers/producto.js` y `lib/handlers/facetas.js`:
  - `crearHandlerBusqueda(proveedor: Proveedor): Handler`
  - `crearHandlerProducto(proveedor: Proveedor): Handler`
  - `crearHandlerFacetas(proveedor: Proveedor): Handler`
  - donde `type Handler = (req: VercelRequest, res: VercelResponse) => Promise<void>`, exportado desde `lib/handlers/tipos.ts`.
- La Task 8 agrega una segunda variante de cada una (`...PorRuta`) que resuelve el proveedor desde `req.query.proveedor` en vez de recibirlo fijo.

- [ ] **Step 1: Mover el cuerpo de `api/search.ts` a `lib/handlers/busqueda.ts`**

El archivo entero pasa a:

```ts
export function crearHandlerBusqueda(proveedor: Proveedor) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    // ...cuerpo actual, con tres cambios:
    //   obtenerCatalogo(proveedor.nombre)
    //   proveedor.getPrecios(...)  en vez de getPrices(...)
    //   const TAMANO_LOTE = proveedor.maxSkusPorLote
  };
}
```

`MAX_CANDIDATOS_SIN_FILTROS`, `MAX_CANDIDATOS_CON_FILTROS` y `UMBRAL_AMBIGUEDAD` se quedan como constantes del módulo: son política nuestra, no del proveedor.

- [ ] **Step 2: Idem para producto y facetas**

`lib/handlers/producto.ts` y `lib/handlers/facetas.ts`, mismo patrón: `obtenerCatalogo(proveedor.nombre)` y `proveedor.getPrecios(...)`.

- [ ] **Step 3: Los archivos de `api/` quedan como envoltorios**

```ts
// api/search.ts
import { crearHandlerBusqueda } from '../lib/handlers/busqueda.js';
import { PROVEEDORES } from '../lib/providers/index.js';

// Alias historico: el agente Rayo apunta aca y no debe enterarse del cambio.
export default crearHandlerBusqueda(PROVEEDORES.intcomex);
```

Igual para `api/product.ts` y `api/facetas.ts`.

- [ ] **Step 4: Ajustar los mocks de los tests de endpoint**

Los tres tests mockean `../lib/providers/intcomex.js` para interceptar `getPrices`. Ahora el handler llama `proveedor.getPrecios`, así que el mock debe exportar `intcomex` con `getPrecios` apuntando al `vi.fn()`. **Las aserciones sobre `res.body` no se tocan.**

- [ ] **Step 5: Suite completa y typecheck**

Run: `npm test && npm run typecheck`
Expected: verde, con las mismas aserciones de contrato.

- [ ] **Step 6: Commit**

```bash
git add lib/handlers/ api/ tests/
git commit -m "refactor: handlers como fabricas parametrizadas por proveedor"
```

---

### Task 8: Rutas `/api/{proveedor}/...` y errores de proveedor

**Files:**
- Create: `api/[proveedor]/search.ts`, `api/[proveedor]/product.ts`, `api/[proveedor]/facetas.ts`, `lib/handlers/guardas.ts`
- Modify: `lib/server.ts` (tabla de rutas), `lib/handlers/busqueda.ts`, `lib/handlers/producto.ts`, `lib/handlers/facetas.ts` (variantes `PorRuta`), `lib/providers/index.ts`
- Test: `tests/proveedor-rutas.test.ts` (crear), `tests/server.test.ts`, `tests/contrato-errores.test.ts`

**Interfaces:**
- Produces: `resolverProveedor(nombre: string | undefined): Proveedor | null` en `lib/providers/index.js`; `resolverOResponder(nombreCrudo: string | undefined, res: VercelResponse): Proveedor | null` en `lib/handlers/guardas.js`; y `crearHandlerBusquedaPorRuta(): Handler`, `crearHandlerProductoPorRuta(): Handler`, `crearHandlerFacetasPorRuta(): Handler` en sus módulos respectivos. Errores `proveedor_desconocido` (404) y `proveedor_no_configurado` (503), ambos con `proveedor` en el cuerpo.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `tests/proveedor-rutas.test.ts`, con el mismo `makeReq`/`makeRes` de los otros tests de endpoint (mockeando `lib/catalog.js` y `lib/providers/intcomex.js` igual que `tests/search-endpoint.test.ts`):

```ts
const { default: aliasSearch } = await import('../api/search.js');
const { default: porRutaSearch } = await import('../api/[proveedor]/search.js');

beforeEach(() => {
  vi.stubEnv('API_SECRET_KEY', 'test-secret');
  vi.stubEnv('INTCOMEX_API_KEY', 'pub');
  vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret');
  vi.stubEnv('INTCOMEX_BASE_URL', 'https://x/');
  obtenerCatalogoMock.mockReset().mockReturnValue(CATALOGO);
  getPreciosMock.mockReset().mockResolvedValue(
    new Map([['HP1', { price: 1000, currency: 'us', inStock: 5 }]]),
  );
});

// El alias existe para que Rayo no se entere del cambio: si las dos rutas
// divergen, el agente empieza a recibir algo distinto sin que nadie lo pida.
it('sirve /api/intcomex/search identico al alias /api/search', async () => {
  const resAlias = makeRes();
  await aliasSearch(makeReq({ q: 'probook' }, AUTH), resAlias);

  const resRuta = makeRes();
  await porRutaSearch(makeReq({ proveedor: 'intcomex', q: 'probook' }, AUTH), resRuta);

  expect(resRuta.statusCode).toBe(resAlias.statusCode);
  expect(resRuta.body).toEqual(resAlias.body);
});

it('404 proveedor_desconocido para un proveedor que no existe', async () => {
  const res = makeRes();
  await porRutaSearch(makeReq({ proveedor: 'nadie', q: 'notebook' }, AUTH), res);
  expect(res.statusCode).toBe(404);
  expect(res.body).toMatchObject({ error: 'proveedor_desconocido', proveedor: 'nadie' });
});

// Va a pasar todo el tiempo mientras TI no entregue credenciales: tiene que
// distinguirse de "el proveedor esta caido", que es 502.
it('503 proveedor_no_configurado cuando faltan credenciales', async () => {
  vi.stubEnv('INTCOMEX_API_KEY', '');
  const res = makeRes();
  await porRutaSearch(makeReq({ proveedor: 'intcomex', q: 'notebook' }, AUTH), res);
  expect(res.statusCode).toBe(503);
  expect(res.body).toMatchObject({ error: 'proveedor_no_configurado', proveedor: 'intcomex' });
});

it('valida la api key antes de mirar el proveedor', async () => {
  const res = makeRes();
  await porRutaSearch(makeReq({ proveedor: 'nadie', q: 'notebook' }), res);
  expect(res.statusCode).toBe(401);
});
```

Y en `tests/server.test.ts`, agregar el ruteo (siguiendo el patrón `pedir()` que el archivo ya usa):

```ts
it('sirve /api/intcomex/search bajo la ruta con proveedor', async () => {
  const r = await pedir('/api/intcomex/search?q=probook', { 'x-api-key': 'test-secret' });
  expect(r.status).toBe(200);
});

it('404 para un proveedor que no existe en la ruta', async () => {
  const r = await pedir('/api/nadie/search?q=x', { 'x-api-key': 'test-secret' });
  expect(r.status).toBe(404);
});

it('enruta /api/intcomex/product/{sku} tomando el sku del path', async () => {
  const r = await pedir('/api/intcomex/product/HP1', { 'x-api-key': 'test-secret' });
  expect(r.status).toBe(200);
  expect(r.body.sku).toBe('HP1');
});
```

- [ ] **Step 1b: Parametrizar el contrato de errores por proveedor**

En `tests/contrato-errores.test.ts`, agregar a `CASOS` las entradas de los códigos nuevos, para que pasen por las mismas aserciones de sobre que el resto:

```ts
{
  nombre: 'proveedor desconocido en la ruta',
  handler: porRutaSearch,
  req: makeReq({ proveedor: 'nadie', q: 'notebook' }, AUTH),
  status: 404,
  error: 'proveedor_desconocido',
},
{
  nombre: 'proveedor sin credenciales',
  handler: porRutaSearch,
  req: makeReq({ proveedor: 'intcomex', q: 'notebook' }, AUTH),
  status: 503,
  error: 'proveedor_no_configurado',
  antes: () => vi.stubEnv('INTCOMEX_API_KEY', ''),
},
```

El test `cubre los cuatro endpoints GET` de ese archivo deriva el nombre del endpoint del primer token de `nombre`, así que estas dos entradas romperían su aserción. Ajustarlo para que ignore las entradas cuyo nombre empiece con `proveedor`, o darles un prefijo de endpoint (`search proveedor desconocido`). Elegir la segunda: mantiene la cobertura del test original intacta.

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/proveedor-rutas.test.ts`
Expected: FAIL — los archivos de `api/[proveedor]/` no existen.

- [ ] **Step 3: Agregar `resolverProveedor` y los guardas**

En `lib/providers/index.ts`:

```ts
export function resolverProveedor(nombre: string | undefined): Proveedor | null {
  return (nombre && PROVEEDORES[nombre]) || null;
}
```

Guarda compartida en `lib/handlers/guardas.ts`:

```ts
export function resolverOResponder(
  nombreCrudo: string | undefined,
  res: VercelResponse,
): Proveedor | null {
  const proveedor = resolverProveedor(nombreCrudo);
  if (!proveedor) {
    res.status(404).json({
      error: 'proveedor_desconocido',
      detail: `No existe el proveedor '${nombreCrudo}'. Disponibles: ${Object.keys(PROVEEDORES).join(', ')}`,
      proveedor: nombreCrudo ?? null,
    });
    return null;
  }
  if (!proveedor.estaConfigurado()) {
    // No es 502: nadie fallo aguas arriba, falta configuracion nuestra.
    res.status(503).json({
      error: 'proveedor_no_configurado',
      detail: `El proveedor '${proveedor.nombre}' no tiene credenciales configuradas`,
      proveedor: proveedor.nombre,
    });
    return null;
  }
  return proveedor;
}
```

- [ ] **Step 4: Agregar la variante `PorRuta` a cada fábrica**

En `lib/handlers/busqueda.ts`, junto a `crearHandlerBusqueda`:

```ts
/**
 * Variante para las rutas /api/{proveedor}/search: el proveedor no se conoce
 * al construir el handler, sale de la ruta en cada request.
 *
 * La api key se valida antes de resolver el proveedor: un cliente sin
 * autenticar no debe poder enumerar que proveedores existen probando nombres.
 */
export function crearHandlerBusquedaPorRuta(): Handler {
  return async function handler(req, res) {
    if (req.method && req.method !== 'GET') {
      res.status(405).json({ error: 'method_not_allowed', detail: 'Use GET' });
      return;
    }
    if (!isAuthorized(firstString(req.headers['x-api-key']), process.env.API_SECRET_KEY)) {
      res.status(401).json({ error: 'unauthorized', detail: 'Missing or invalid x-api-key header' });
      return;
    }

    const proveedor = resolverOResponder(firstString(req.query.proveedor), res);
    if (!proveedor) return;

    await crearHandlerBusqueda(proveedor)(req, res);
  };
}
```

Idem `crearHandlerProductoPorRuta` y `crearHandlerFacetasPorRuta` en sus archivos, con el mismo cuerpo salvo la fábrica que delegan.

- [ ] **Step 5: Crear los archivos de ruta dinámica**

```ts
// api/[proveedor]/search.ts
import { crearHandlerBusquedaPorRuta } from '../../lib/handlers/busqueda.js';

export default crearHandlerBusquedaPorRuta();
```

Idem `api/[proveedor]/product.ts` y `api/[proveedor]/facetas.ts`.

- [ ] **Step 6: Extender la tabla de rutas en `lib/server.ts`**

`rutas()` genera el producto cartesiano proveedores × recursos:

```ts
for (const proveedor of Object.keys(PROVEEDORES)) {
  for (const recurso of ['search', 'product', 'facetas']) {
    tabla[`/api/${proveedor}/${recurso}`] = `${proveedor}:${recurso}`;
    if (basePath) tabla[`${basePath}/${proveedor}/${recurso}`] = `${proveedor}:${recurso}`;
  }
}
```

Y el patrón de `/product/{sku}` se extiende para aceptar el prefijo de proveedor. Un proveedor no registrado no está en la tabla, así que cae en el 404 genérico de ruta; el `proveedor_desconocido` con cuerpo detallado lo entrega Vercel, donde el segmento es dinámico. Documentar esa diferencia en un comentario.

- [ ] **Step 7: Suite completa y typecheck**

Run: `npm test && npm run typecheck`
Expected: verde.

- [ ] **Step 8: Commit**

```bash
git add api/ lib/ tests/
git commit -m "feat: rutas por proveedor con proveedor_desconocido y no_configurado"
```

---

### Task 9: Refresco de catálogos en paralelo

**Files:**
- Modify: `server.ts`
- Test: `tests/refresco.test.ts` (crear)

**Interfaces:**
- Consumes: `PROVEEDORES`, `cargarCatalogo(proveedor)`.
- Produces, desde `lib/refresco.js`:
  - `refrescarTodos(nombres: string[], cargar: (p: string) => Promise<unknown[]>, alFallar?: (p: string) => void): Promise<void>`

  `cargar` y `alFallar` se inyectan para poder testear sin red ni temporizadores. `server.ts` los llama con `cargarCatalogo` y con el reintento real.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `tests/refresco.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { refrescarTodos } from '../lib/refresco.js';

describe('refrescarTodos', () => {
  // Que un proveedor este caido no puede dejar sin catalogo a los demas: hoy
  // server.ts carga uno solo y un throw ahi mata el refresco entero.
  it('carga los demas proveedores aunque uno falle', async () => {
    const cargar = vi.fn(async (p: string) => {
      if (p === 'ingram') throw new Error('ingram caido');
      return [];
    });

    await refrescarTodos(['ingram', 'intcomex'], cargar);

    expect(cargar).toHaveBeenCalledTimes(2);
    expect(cargar).toHaveBeenCalledWith('intcomex');
  });

  it('no rechaza aunque fallen todos', async () => {
    const cargar = vi.fn().mockRejectedValue(new Error('todo caido'));
    await expect(refrescarTodos(['a', 'b'], cargar)).resolves.toBeUndefined();
  });

  it('avisa solo por los proveedores que fallaron', async () => {
    const cargar = vi.fn(async (p: string) => {
      if (p === 'ingram') throw new Error('caido');
      return [];
    });
    const alFallar = vi.fn();

    await refrescarTodos(['ingram', 'intcomex'], cargar, alFallar);

    expect(alFallar).toHaveBeenCalledTimes(1);
    expect(alFallar).toHaveBeenCalledWith('ingram');
  });

  it('los carga en paralelo, no en cadena', async () => {
    let simultaneos = 0;
    let pico = 0;
    const cargar = vi.fn(async () => {
      simultaneos += 1;
      pico = Math.max(pico, simultaneos);
      await Promise.resolve();
      simultaneos -= 1;
      return [];
    });

    await refrescarTodos(['a', 'b', 'c'], cargar);

    expect(pico).toBeGreaterThan(1);
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/refresco.test.ts`
Expected: FAIL — no existe `lib/refresco.ts`.

- [ ] **Step 3: Implementar `lib/refresco.ts`**

```ts
/**
 * Refresca los catalogos de varios proveedores a la vez.
 *
 * allSettled y no all: un proveedor caido no puede cancelar la carga de los
 * otros. El error de cada uno se reporta por separado y la promesa nunca
 * rechaza, porque el llamador es un temporizador de fondo sin nadie que
 * atrape la excepcion.
 */
export async function refrescarTodos(
  nombres: string[],
  cargar: (proveedor: string) => Promise<unknown[]>,
  alFallar: (proveedor: string) => void = () => {},
): Promise<void> {
  const resultados = await Promise.allSettled(
    nombres.map(async (nombre) => {
      const productos = await cargar(nombre);
      console.log(`[catalog] ${nombre}: ${productos.length} productos disponibles`);
    }),
  );

  resultados.forEach((resultado, i) => {
    if (resultado.status === 'rejected') {
      console.error(`[catalog] ${nombres[i]}: no se pudo cargar`, resultado.reason);
      alFallar(nombres[i]);
    }
  });
}
```

- [ ] **Step 4: `server.ts` usa `refrescarTodos`**

Reemplazar el bloque `refrescarCatalogo()` de `server.ts` por:

```ts
const REFRESCO_MS = 24 * 60 * 60 * 1000;
const REINTENTO_MS = 5 * 60 * 1000;

function reintentar(proveedor: string): void {
  setTimeout(() => {
    void refrescarTodos([proveedor], cargarCatalogo, reintentar);
  }, REINTENTO_MS).unref();
}

void refrescarTodos(Object.keys(PROVEEDORES), cargarCatalogo, reintentar);
setInterval(() => {
  void refrescarTodos(Object.keys(PROVEEDORES), cargarCatalogo, reintentar);
}, REFRESCO_MS).unref();
```

El reintento se agenda solo para el proveedor que falló, no para todos: reintentar los tres porque uno se cayó multiplica llamadas a proveedores que ya respondieron bien.

- [ ] **Step 5: Suite completa y typecheck**

Run: `npm test && npm run typecheck`
Expected: verde.

- [ ] **Step 6: Commit**

```bash
git add server.ts lib/refresco.ts tests/refresco.test.ts
git commit -m "feat: refresco de catalogos en paralelo con reintento por proveedor"
```

---

### Task 10: Documentación y cierre

**Files:**
- Modify: `README.md`, `docs/api/README.md`, `docs/api/openapi.yaml`, `.env.example`

- [ ] **Step 1: Documentar las rutas nuevas**

En `docs/api/openapi.yaml`, agregar `/api/{proveedor}/search|product|facetas` con el parámetro de path enumerado, y los dos códigos de error nuevos. Marcar los alias `/api/search|product|facetas` como "Intcomex, compatibilidad".

- [ ] **Step 2: Actualizar el README**

Sección de proveedores: cómo se agrega uno (implementar `Proveedor`, registrarlo en `lib/providers/index.ts`, agregar sus env vars). Mencionar que Ingram y Tecnoglobal **están pendientes de credenciales**.

- [ ] **Step 3: Verificar que la doc no miente**

Run: `npm test`
Expected: verde, incluidos los 95 tests de `tests/docs.test.ts`, que validan la documentación contra el código.

- [ ] **Step 4: Commit**

```bash
git add README.md docs/ .env.example
git commit -m "docs: rutas por proveedor y como agregar uno nuevo"
```

---

## Verificación final

- [ ] `npm test` en verde, sin ninguna aserción de contrato de `/api/search|product|facetas` modificada respecto al commit inicial.
- [ ] `npm run typecheck` limpio.
- [ ] `grep -rn "CatalogProduct" lib api tests` → vacío.
- [ ] `git diff <commit-inicial> -- tests/search-endpoint.test.ts tests/product-endpoint.test.ts` muestra solo cambios de helpers y mocks, nunca de valores esperados en `res.body`.
- [ ] Agregar un proveedor nuevo requiere: un módulo que implemente `Proveedor` + una línea en `lib/providers/index.ts`. Nada más.
