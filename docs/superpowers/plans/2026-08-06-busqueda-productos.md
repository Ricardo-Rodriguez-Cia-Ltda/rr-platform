# Búsqueda de Productos para LLM — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que un LLM pueda pasar de un pedido vago ("algo HP") a productos concretos con precio, mediante `GET /search`, `GET /product/{sku}` y `GET /facetas`.

**Architecture:** Copia local del catálogo de Intcomex (10.297 productos) refrescada a diario en `lib/catalog.ts`; motor de búsqueda puro (sin I/O) en `lib/search.ts`; cotización en lote vía `getproducts` en el provider existente; tres handlers nuevos con firma Vercel enrutados por `lib/server.ts`.

**Tech Stack:** Node 20+, TypeScript strict ESM (NodeNext), vitest, tsx. Sin dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-08-06-busqueda-productos-design.md`

## Global Constraints

- Sin dependencias de producción nuevas.
- Imports relativos SIEMPRE con extensión `.js` (tsconfig NodeNext).
- Secretos solo por env; nunca en logs ni en mensajes de error.
- Formato de error uniforme `{ "error": "...", "detail": "..." }`.
- Umbral de ambigüedad: **25** coincidencias.
- Pesos de puntaje: MPN exacto **100**, marca **10**, descripción **3**.
- Máximo de SKUs por llamada a `getproducts`: **100**; se cotizan los **50** mejores candidatos.
- Caché de catálogo: **24 horas**. Precios: **nunca** se cachean.
- Todo el texto visible al LLM (nombres de campo de la respuesta) va en español, como en el spec.

---

### Task 1: Helper de request a IWS + cotización en lote

**Files:**
- Modify: `lib/providers/intcomex.ts`
- Modify: `lib/types.ts`
- Test: `tests/intcomex-batch.test.ts`

**Interfaces:**
- Consumes: `buildAuthToken` (ya existe), `ProviderError` de `lib/types.js`.
- Produces:
  - `lib/types.ts`: `interface PriceInfo { price: number; currency: string; inStock: number | null }`
  - `lib/providers/intcomex.ts`: `export async function fetchIws(path: string, params?: Record<string, string>): Promise<Response>` — arma URL con base normalizada, firma y hace el fetch; lanza `ProviderError('upstream')` si falta config o falla la red.
  - `lib/providers/intcomex.ts`: `export async function getPrices(skus: string[]): Promise<Map<string, PriceInfo>>` — cotiza hasta 100 SKUs en una llamada a `getproducts`; los SKUs sin precio simplemente no aparecen en el Map.

- [ ] **Step 1: Escribir los tests que fallan (`tests/intcomex-batch.test.ts`)**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getPrices } from '../lib/providers/intcomex.js';
import { ProviderError } from '../lib/types.js';

const IWS_ITEMS = [
  { Sku: 'A1', Mpn: 'M1', Price: { UnitPrice: 10.5, CurrencyId: 'us' }, InStock: 3 },
  { Sku: 'B2', Mpn: 'M2', Price: { UnitPrice: 20, CurrencyId: 'us' }, InStock: 0 },
  { Sku: 'C3', Mpn: 'M3', Price: null, InStock: 5 },
];

describe('getPrices', () => {
  beforeEach(() => {
    vi.stubEnv('INTCOMEX_API_KEY', 'pub');
    vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret-key');
    vi.stubEnv('INTCOMEX_BASE_URL', 'https://intcomex-prod.apigee.net/v1/');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('requests getproducts with a comma separated skusList and maps the results', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(IWS_ITEMS), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const prices = await getPrices(['A1', 'B2', 'C3']);

    const [url] = fetchMock.mock.calls[0] as [URL];
    expect(url.href).toContain('/v1/getproducts');
    expect(url.searchParams.get('skusList')).toBe('A1,B2,C3');
    expect(url.searchParams.get('includePriceData')).toBe('true');
    expect(url.searchParams.get('includeInventoryData')).toBe('true');

    expect(prices.get('A1')).toEqual({ price: 10.5, currency: 'us', inStock: 3 });
    expect(prices.get('B2')).toEqual({ price: 20, currency: 'us', inStock: 0 });
    // Sin precio: no aparece en el Map.
    expect(prices.has('C3')).toBe(false);
  });

  it('returns an empty map without calling the network for an empty list', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const prices = await getPrices([]);

    expect(prices.size).toBe(0);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects more than 100 skus', async () => {
    const many = Array.from({ length: 101 }, (_, i) => `S${i}`);
    await expect(getPrices(many)).rejects.toBeInstanceOf(ProviderError);
  });

  it('throws upstream on a non-ok response without leaking credentials', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));

    const error = await getPrices(['A1']).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('upstream');
    expect(JSON.stringify(error)).not.toContain('secret-key');
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `npx vitest run tests/intcomex-batch.test.ts`
Expected: FAIL — `getPrices` no existe.

- [ ] **Step 3: Agregar `PriceInfo` a `lib/types.ts`**

```ts
export interface PriceInfo {
  price: number;
  currency: string;
  inStock: number | null;
}
```

- [ ] **Step 4: Refactorizar `lib/providers/intcomex.ts` para exponer `fetchIws`**

Reemplazar el cuerpo de `getConfig` y la construcción de la URL dentro de `getPrice` por este helper compartido, dejando `getPrice` usándolo (mismo comportamiento, mismos errores):

```ts
export async function fetchIws(
  path: string,
  params: Record<string, string> = {},
): Promise<Response> {
  const apiKey = process.env.INTCOMEX_API_KEY;
  const accessKey = process.env.INTCOMEX_ACCESS_KEY;
  const rawBaseUrl = process.env.INTCOMEX_BASE_URL;
  if (!apiKey || !accessKey || !rawBaseUrl) {
    throw new ProviderError('upstream', 'Intcomex credentials are not configured');
  }
  const baseUrl = rawBaseUrl.endsWith('/') ? rawBaseUrl : `${rawBaseUrl}/`;

  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  try {
    return await fetch(url, {
      headers: {
        Authorization: `Bearer ${buildAuthToken(apiKey, accessKey, new Date())}`,
      },
    });
  } catch {
    throw new ProviderError('upstream', 'Could not reach Intcomex');
  }
}
```

`getPrice` queda así (misma lógica de errores que ya tenía, ahora sobre `fetchIws`):

```ts
export const intcomex: Provider = {
  name: 'intcomex',

  async getPrice(query: PriceQuery): Promise<PriceResult> {
    const params: Record<string, string> = {
      includePriceData: 'true',
      includeInventoryData: 'true',
    };
    if (query.sku) params.sku = query.sku;
    if (query.mpn) params.mpn = query.mpn;
    if (query.upc) params.upc = query.upc;

    const response = await fetchIws('getproduct', params);

    if (response.status === 404) {
      throw new ProviderError('not_found', 'Product not found at Intcomex');
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderError(
        'upstream',
        `Intcomex responded with HTTP ${response.status}`,
        body.slice(0, 500),
      );
    }

    let product: IwsProduct;
    try {
      product = (await response.json()) as IwsProduct;
    } catch {
      throw new ProviderError('upstream', 'Intcomex returned an invalid JSON response');
    }

    if (product.Price?.UnitPrice == null) {
      throw new ProviderError('not_found', 'Intcomex returned no price for this product');
    }

    return {
      provider: 'intcomex',
      sku: product.Sku ?? null,
      mpn: product.Mpn ?? null,
      description: product.Description ?? null,
      price: product.Price.UnitPrice,
      currency: product.Price.CurrencyId ?? 'USD',
      inStock: product.InStock ?? null,
    };
  },
};
```

- [ ] **Step 5: Implementar `getPrices` (agregar al final de `lib/providers/intcomex.ts`)**

```ts
const MAX_SKUS_POR_LLAMADA = 100;

export async function getPrices(skus: string[]): Promise<Map<string, PriceInfo>> {
  const prices = new Map<string, PriceInfo>();
  if (skus.length === 0) return prices;
  if (skus.length > MAX_SKUS_POR_LLAMADA) {
    throw new ProviderError(
      'upstream',
      `Intcomex accepts at most ${MAX_SKUS_POR_LLAMADA} SKUs per request`,
    );
  }

  const response = await fetchIws('getproducts', {
    skusList: skus.join(','),
    includePriceData: 'true',
    includeInventoryData: 'true',
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ProviderError(
      'upstream',
      `Intcomex responded with HTTP ${response.status}`,
      body.slice(0, 500),
    );
  }

  let items: IwsProduct[];
  try {
    items = (await response.json()) as IwsProduct[];
  } catch {
    throw new ProviderError('upstream', 'Intcomex returned an invalid JSON response');
  }

  for (const item of items ?? []) {
    if (!item.Sku || item.Price?.UnitPrice == null) continue;
    prices.set(item.Sku, {
      price: item.Price.UnitPrice,
      currency: item.Price.CurrencyId ?? 'USD',
      inStock: item.InStock ?? null,
    });
  }

  return prices;
}
```

Agregar `PriceInfo` al import de tipos existente desde `../types.js`.

- [ ] **Step 6: Verificar que pasan y que no hubo regresión**

Run: `npx vitest run tests/intcomex-batch.test.ts tests/intcomex-provider.test.ts`
Expected: PASS — los 4 nuevos y los 7 existentes del provider.

- [ ] **Step 7: Suite completa + typecheck**

Run: `npm test` y `npm run typecheck`
Expected: 39 tests PASS, typecheck exit 0.

- [ ] **Step 8: Commit**

```bash
git add lib/types.ts lib/providers/intcomex.ts tests/intcomex-batch.test.ts
git commit -m "feat: add shared IWS request helper and batch price lookup"
```

---

### Task 2: Motor de búsqueda (funciones puras)

**Files:**
- Create: `lib/search.ts`
- Test: `tests/search.test.ts`

**Interfaces:**
- Consumes: nada (sin I/O, sin red, sin env).
- Produces:
  - `interface CatalogProduct { Sku: string; Mpn: string | null; Description: string | null; Type?: string | null; Brand?: { Description?: string | null } | null; Category?: { Description?: string | null; Subcategories?: { Description?: string | null }[] } | null }`
  - `interface SearchFilters { q: string; marca?: string; categoria?: string }`
  - `interface ScoredProduct { product: CatalogProduct; score: number }`
  - `interface Facetas { marca: { valor: string; n: number }[]; categoria: { valor: string; n: number }[] }`
  - `export function normalizar(texto: string): string`
  - `export function tokenizar(texto: string): string[]`
  - `export function buscar(catalogo: CatalogProduct[], filtros: SearchFilters): ScoredProduct[]`
  - `export function calcularFacetas(productos: CatalogProduct[]): Facetas`

- [ ] **Step 1: Escribir los tests que fallan (`tests/search.test.ts`)**

Los casos vienen de fallos medidos contra el catálogo real de Intcomex.

```ts
import { describe, expect, it } from 'vitest';
import { buscar, calcularFacetas, normalizar, tokenizar } from '../lib/search.js';
import type { CatalogProduct } from '../lib/search.js';

function producto(
  Sku: string,
  Mpn: string,
  Description: string,
  marca: string,
  categoria = 'Computadores',
): CatalogProduct {
  return {
    Sku,
    Mpn,
    Description,
    Brand: { Description: marca },
    Category: { Description: categoria, Subcategories: [] },
  };
}

const CATALOGO: CatalogProduct[] = [
  producto('MT027DEL20', 'P2725HE', 'Dell P2725HE - 27" - 1920 x 1080 - IPS - USB-C', 'Dell', 'Monitores'),
  producto('NT016HPQ53', '2N6G5LT#ABM', 'HP ProBook 640 G8 - Notebook - 14" - Intel Core i7', 'HP'),
  producto('100016385', '4P5H8AA', 'HyperX CloudX Gaming - Auricular - tamaño completo - cableado', 'HyperX', 'Audio'),
  producto('ID020LOG11', '920-008813', 'Logitech K380 - Teclado - inalámbrico - Bluetooth', 'Logitech', 'Accesorios'),
];

describe('normalizar', () => {
  it('pasa a minúsculas y quita tildes', () => {
    expect(normalizar('Inalámbrico ÑOÑO')).toBe('inalambrico ñoño');
  });
});

describe('tokenizar', () => {
  it('parte en palabras completas descartando puntuación', () => {
    expect(tokenizar('HP ProBook 640 G8 - 14"')).toEqual(['hp', 'probook', '640', 'g8', '14']);
  });
});

describe('buscar', () => {
  it('no devuelve HyperX al buscar hp (palabras completas, no subcadenas)', () => {
    const skus = buscar(CATALOGO, { q: 'hp' }).map((r) => r.product.Sku);
    expect(skus).toContain('NT016HPQ53');
    expect(skus).not.toContain('100016385');
  });

  it('encuentra el monitor Dell aunque su descripción no diga "monitor"', () => {
    const skus = buscar(CATALOGO, { q: 'monitor dell 27' }).map((r) => r.product.Sku);
    expect(skus[0]).toBe('MT027DEL20');
  });

  it('encuentra "inalámbrico" buscando sin tilde', () => {
    const skus = buscar(CATALOGO, { q: 'teclado logitech inalambrico' }).map((r) => r.product.Sku);
    expect(skus[0]).toBe('ID020LOG11');
  });

  it('da la máxima prioridad a una coincidencia exacta de MPN', () => {
    const resultados = buscar(CATALOGO, { q: 'P2725HE' });
    expect(resultados[0].product.Sku).toBe('MT027DEL20');
    expect(resultados[0].score).toBeGreaterThanOrEqual(100);
  });

  it('ordena por cantidad de términos coincidentes', () => {
    const resultados = buscar(CATALOGO, { q: 'hp probook notebook' });
    expect(resultados[0].product.Sku).toBe('NT016HPQ53');
  });

  it('filtra por marca sin considerarla en el puntaje de texto', () => {
    const skus = buscar(CATALOGO, { q: 'notebook', marca: 'HP' }).map((r) => r.product.Sku);
    expect(skus).toEqual(['NT016HPQ53']);
  });

  it('filtra por categoría', () => {
    const skus = buscar(CATALOGO, { q: 'dell', categoria: 'Monitores' }).map((r) => r.product.Sku);
    expect(skus).toEqual(['MT027DEL20']);
  });

  it('devuelve vacío cuando ningún término calza', () => {
    expect(buscar(CATALOGO, { q: 'tractor agricola' })).toEqual([]);
  });
});

describe('calcularFacetas', () => {
  it('cuenta marcas y categorías presentes, ordenadas por frecuencia', () => {
    const facetas = calcularFacetas([CATALOGO[1], CATALOGO[1], CATALOGO[0]]);
    expect(facetas.marca[0]).toEqual({ valor: 'HP', n: 2 });
    expect(facetas.marca).toContainEqual({ valor: 'Dell', n: 1 });
    expect(facetas.categoria[0]).toEqual({ valor: 'Computadores', n: 2 });
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `npx vitest run tests/search.test.ts`
Expected: FAIL — no existe `lib/search.ts`.

- [ ] **Step 3: Implementar `lib/search.ts`**

```ts
export interface CatalogProduct {
  Sku: string;
  Mpn: string | null;
  Description: string | null;
  Type?: string | null;
  Brand?: { Description?: string | null } | null;
  Category?: {
    Description?: string | null;
    Subcategories?: { Description?: string | null }[];
  } | null;
}

export interface SearchFilters {
  q: string;
  marca?: string;
  categoria?: string;
}

export interface ScoredProduct {
  product: CatalogProduct;
  score: number;
}

export interface Facetas {
  marca: { valor: string; n: number }[];
  categoria: { valor: string; n: number }[];
}

const PESO_MPN_EXACTO = 100;
const PESO_MARCA = 10;
const PESO_DESCRIPCION = 3;

export function normalizar(texto: string): string {
  // U+0300-U+036F = marcas diacríticas combinantes que NFD separa de la letra.
  return texto.normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
}

export function tokenizar(texto: string): string[] {
  return normalizar(texto)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

function puntuar(product: CatalogProduct, terminos: string[]): number {
  const mpn = normalizar(product.Mpn ?? '');
  const tokensMarca = new Set(tokenizar(product.Brand?.Description ?? ''));
  const tokensDescripcion = new Set(tokenizar(product.Description ?? ''));

  let score = 0;
  for (const termino of terminos) {
    if (mpn && termino === mpn) score += PESO_MPN_EXACTO;
    if (tokensMarca.has(termino)) score += PESO_MARCA;
    if (tokensDescripcion.has(termino)) score += PESO_DESCRIPCION;
  }
  return score;
}

export function buscar(catalogo: CatalogProduct[], filtros: SearchFilters): ScoredProduct[] {
  const marca = filtros.marca ? normalizar(filtros.marca) : undefined;
  const categoria = filtros.categoria ? normalizar(filtros.categoria) : undefined;
  const terminos = [...new Set(tokenizar(filtros.q))];

  const resultados: ScoredProduct[] = [];
  for (const product of catalogo) {
    if (marca && normalizar(product.Brand?.Description ?? '') !== marca) continue;
    if (categoria && normalizar(product.Category?.Description ?? '') !== categoria) continue;

    const score = terminos.length === 0 ? 1 : puntuar(product, terminos);
    if (score > 0) resultados.push({ product, score });
  }

  return resultados.sort((a, b) => b.score - a.score);
}

function contar(valores: (string | null | undefined)[]): { valor: string; n: number }[] {
  const conteo = new Map<string, number>();
  for (const valor of valores) {
    if (!valor) continue;
    conteo.set(valor, (conteo.get(valor) ?? 0) + 1);
  }
  return [...conteo.entries()]
    .map(([valor, n]) => ({ valor, n }))
    .sort((a, b) => b.n - a.n || a.valor.localeCompare(b.valor));
}

export function calcularFacetas(productos: CatalogProduct[]): Facetas {
  return {
    marca: contar(productos.map((p) => p.Brand?.Description)),
    categoria: contar(productos.map((p) => p.Category?.Description)),
  };
}
```

- [ ] **Step 4: Verificar que pasan**

Run: `npx vitest run tests/search.test.ts`
Expected: PASS (11 tests).

- [ ] **Step 5: Suite completa + typecheck**

Run: `npm test` y `npm run typecheck`
Expected: 50 tests PASS, typecheck exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/search.ts tests/search.test.ts
git commit -m "feat: add pure text search engine over the catalog"
```

---

### Task 3: Caché del catálogo

**Files:**
- Create: `lib/catalog.ts`
- Modify: `.gitignore` (ignorar el archivo de caché)
- Test: `tests/catalog.test.ts`

**Interfaces:**
- Consumes: `fetchIws` (Task 1), `CatalogProduct` de `lib/search.js` (Task 2), `ProviderError` de `lib/types.js`.
- Produces:
  - `export class CatalogUnavailableError extends Error` — el catálogo aún no está cargado.
  - `export async function cargarCatalogo(): Promise<CatalogProduct[]>` — devuelve el catálogo en memoria; si no está, lee `cache/catalog.json` si tiene menos de 24 h; si no, lo descarga y lo persiste.
  - `export function obtenerCatalogo(): CatalogProduct[]` — accesor sincrónico; lanza `CatalogUnavailableError` si aún no se cargó.
  - `export function _resetCatalogoParaTests(): void` — limpia el estado en memoria (solo tests).
  - Ruta del caché configurable por `CATALOG_CACHE_PATH` (default `cache/catalog.json`).

- [ ] **Step 1: Escribir los tests que fallan (`tests/catalog.test.ts`)**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  CatalogUnavailableError,
  cargarCatalogo,
  obtenerCatalogo,
  _resetCatalogoParaTests,
} from '../lib/catalog.js';

const ITEMS = [
  { Sku: 'A1', Mpn: 'M1', Description: 'Producto uno', Brand: { Description: 'HP' } },
  { Sku: 'B2', Mpn: 'M2', Description: 'Producto dos', Brand: { Description: 'Dell' } },
];

let cachePath: string;

beforeEach(() => {
  cachePath = join(mkdtempSync(join(tmpdir(), 'cat-')), 'catalog.json');
  vi.stubEnv('CATALOG_CACHE_PATH', cachePath);
  vi.stubEnv('INTCOMEX_API_KEY', 'pub');
  vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret-key');
  vi.stubEnv('INTCOMEX_BASE_URL', 'https://intcomex-prod.apigee.net/v1/');
  _resetCatalogoParaTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe('obtenerCatalogo', () => {
  it('lanza CatalogUnavailableError si aún no se cargó', () => {
    expect(() => obtenerCatalogo()).toThrow(CatalogUnavailableError);
  });
});

describe('cargarCatalogo', () => {
  it('descarga getcatalog, lo persiste en disco y lo deja en memoria', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(ITEMS), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const catalogo = await cargarCatalogo();

    expect(catalogo).toHaveLength(2);
    expect((fetchMock.mock.calls[0][0] as URL).href).toContain('/v1/getcatalog');
    expect(JSON.parse(readFileSync(cachePath, 'utf8')).productos).toHaveLength(2);
    expect(obtenerCatalogo()).toHaveLength(2);
  });

  it('usa el caché de disco sin llamar a la red si tiene menos de 24 horas', async () => {
    writeFileSync(
      cachePath,
      JSON.stringify({ descargadoEn: new Date().toISOString(), productos: ITEMS }),
    );
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);

    const catalogo = await cargarCatalogo();

    expect(catalogo).toHaveLength(2);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('vuelve a descargar si el caché tiene más de 24 horas', async () => {
    const viejo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(cachePath, JSON.stringify({ descargadoEn: viejo, productos: [] }));
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify(ITEMS), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const catalogo = await cargarCatalogo();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(catalogo).toHaveLength(2);
  });

  it('si la descarga falla pero hay caché vencido en disco, lo usa igual', async () => {
    const viejo = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    writeFileSync(cachePath, JSON.stringify({ descargadoEn: viejo, productos: ITEMS }));
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));

    const catalogo = await cargarCatalogo();

    expect(catalogo).toHaveLength(2);
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `npx vitest run tests/catalog.test.ts`
Expected: FAIL — no existe `lib/catalog.ts`.

- [ ] **Step 3: Implementar `lib/catalog.ts`**

```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fetchIws } from './providers/intcomex.js';
import type { CatalogProduct } from './search.js';

const VIGENCIA_MS = 24 * 60 * 60 * 1000;

export class CatalogUnavailableError extends Error {
  constructor() {
    super('El catálogo todavía no está disponible');
    this.name = 'CatalogUnavailableError';
  }
}

interface CacheEnDisco {
  descargadoEn: string;
  productos: CatalogProduct[];
}

let enMemoria: CatalogProduct[] | null = null;

function rutaCache(): string {
  return process.env.CATALOG_CACHE_PATH ?? 'cache/catalog.json';
}

function leerCache(): CacheEnDisco | null {
  try {
    return JSON.parse(readFileSync(rutaCache(), 'utf8')) as CacheEnDisco;
  } catch {
    return null;
  }
}

function escribirCache(productos: CatalogProduct[]): void {
  const ruta = rutaCache();
  mkdirSync(dirname(ruta), { recursive: true });
  writeFileSync(
    ruta,
    JSON.stringify({ descargadoEn: new Date().toISOString(), productos } satisfies CacheEnDisco),
  );
}

function estaVigente(cache: CacheEnDisco): boolean {
  const edad = Date.now() - new Date(cache.descargadoEn).getTime();
  return Number.isFinite(edad) && edad >= 0 && edad < VIGENCIA_MS;
}

async function descargar(): Promise<CatalogProduct[]> {
  const response = await fetchIws('getcatalog');
  if (!response.ok) {
    throw new Error(`Intcomex respondió HTTP ${response.status} al pedir el catálogo`);
  }
  return (await response.json()) as CatalogProduct[];
}

export async function cargarCatalogo(): Promise<CatalogProduct[]> {
  const cache = leerCache();
  if (cache && estaVigente(cache)) {
    enMemoria = cache.productos;
    return enMemoria;
  }

  try {
    const productos = await descargar();
    escribirCache(productos);
    enMemoria = productos;
    return enMemoria;
  } catch (error) {
    // Un catálogo viejo sirve mucho más que ninguno: el precio siempre se
    // consulta aparte, así que lo desactualizado aquí es a lo sumo el surtido.
    if (cache) {
      console.error('[catalog] no se pudo refrescar, se usa el caché vencido', error);
      enMemoria = cache.productos;
      return enMemoria;
    }
    throw error;
  }
}

export function obtenerCatalogo(): CatalogProduct[] {
  if (!enMemoria) throw new CatalogUnavailableError();
  return enMemoria;
}

export function _resetCatalogoParaTests(): void {
  enMemoria = null;
}
```

- [ ] **Step 4: Agregar `cache/` a `.gitignore`** (línea nueva, junto a `logs/`)

```
cache/
```

- [ ] **Step 5: Verificar que pasan**

Run: `npx vitest run tests/catalog.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 6: Suite completa + typecheck**

Run: `npm test` y `npm run typecheck`
Expected: 55 tests PASS, typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add lib/catalog.ts tests/catalog.test.ts .gitignore
git commit -m "feat: add daily catalog cache with stale fallback"
```

---

### Task 4: Endpoint `GET /search`

**Files:**
- Create: `api/search.ts`
- Modify: `lib/server.ts` (enrutar `/search`)
- Test: `tests/search-endpoint.test.ts`

**Interfaces:**
- Consumes: `isAuthorized` de `lib/auth.js`; `buscar`/`calcularFacetas` de `lib/search.js` (Task 2); `obtenerCatalogo`/`CatalogUnavailableError` de `lib/catalog.js` (Task 3); `getPrices` de `lib/providers/intcomex.js` (Task 1); `ProviderError` de `lib/types.js`.
- Produces: `export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void>` en `api/search.ts`; ruta `/search` (y `${BASE_PATH}/search`) en `lib/server.ts`.

- [ ] **Step 1: Escribir los tests que fallan (`tests/search-endpoint.test.ts`)**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { CatalogUnavailableError } from '../lib/catalog.js';
import type { CatalogProduct } from '../lib/search.js';

const obtenerCatalogoMock = vi.fn();
const getPricesMock = vi.fn();

vi.mock('../lib/catalog.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/catalog.js')>('../lib/catalog.js');
  return { ...actual, obtenerCatalogo: () => obtenerCatalogoMock() };
});

vi.mock('../lib/providers/intcomex.js', () => ({
  getPrices: (skus: string[]) => getPricesMock(skus),
}));

const { default: handler } = await import('../api/search.js');

function producto(Sku: string, Description: string, marca: string, categoria: string): CatalogProduct {
  return {
    Sku,
    Mpn: `MPN-${Sku}`,
    Description,
    Brand: { Description: marca },
    Category: { Description: categoria, Subcategories: [] },
  };
}

const CATALOGO = [
  producto('HP1', 'HP ProBook 640 Notebook 14"', 'HP', 'Computadores'),
  producto('HP2', 'HP EliteBook 840 Notebook 14"', 'HP', 'Computadores'),
  producto('DE1', 'Dell Latitude Notebook 15"', 'Dell', 'Computadores'),
];

function makeReq(query: Record<string, string>, headers: Record<string, string> = {}): VercelRequest {
  return { query, headers, method: 'GET' } as unknown as VercelRequest;
}

function makeRes(): VercelResponse & { statusCode: number; body: any } {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
  };
  return res;
}

const AUTH = { 'x-api-key': 'test-secret' };

describe('GET /search', () => {
  beforeEach(() => {
    vi.stubEnv('API_SECRET_KEY', 'test-secret');
    obtenerCatalogoMock.mockReset().mockReturnValue(CATALOGO);
    getPricesMock.mockReset().mockResolvedValue(
      new Map([
        ['HP1', { price: 1000, currency: 'us', inStock: 5 }],
        ['HP2', { price: 2000, currency: 'us', inStock: 0 }],
        ['DE1', { price: 1500, currency: 'us', inStock: 2 }],
      ]),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 without x-api-key', async () => {
    const res = makeRes();
    await handler(makeReq({ q: 'hp' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when q is missing', async () => {
    const res = makeRes();
    await handler(makeReq({}, AUTH), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request' });
  });

  it('returns matching products with price and stock', async () => {
    const res = makeRes();
    await handler(makeReq({ q: 'probook' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(1);
    expect(res.body.productos[0]).toMatchObject({
      sku: 'HP1',
      marca: 'HP',
      categoria: 'Computadores',
      precio: 1000,
      moneda: 'us',
      stock: 5,
    });
    expect(res.body.facetas.marca).toContainEqual({ valor: 'HP', n: 1 });
  });

  it('asks getPrices only for the candidates it will return', async () => {
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP' }, AUTH), res);
    expect(getPricesMock).toHaveBeenCalledWith(['HP1', 'HP2']);
    expect(res.statusCode).toBe(200);
  });

  it('applies precio_max after pricing', async () => {
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', precio_max: '1200' }, AUTH), res);
    const skus = res.body.productos.map((p: any) => p.sku);
    expect(skus).toEqual(['HP1']);
  });

  it('applies solo_con_stock after pricing', async () => {
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true' }, AUTH), res);
    const skus = res.body.productos.map((p: any) => p.sku);
    expect(skus).toEqual(['HP1']);
  });

  it('honours limite', async () => {
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', limite: '1' }, AUTH), res);
    expect(res.body.productos).toHaveLength(1);
    expect(res.body.total).toBe(3);
  });

  it('returns 409 demasiado_amplio with facets when too many matches and no filters', async () => {
    const grande = Array.from({ length: 30 }, (_, i) =>
      producto(`S${i}`, `Notebook generico ${i}`, i % 2 === 0 ? 'HP' : 'Dell', 'Computadores'),
    );
    obtenerCatalogoMock.mockReturnValue(grande);

    const res = makeRes();
    await handler(makeReq({ q: 'notebook' }, AUTH), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'demasiado_amplio', total: 30 });
    expect(res.body.facetas.marca).toContainEqual({ valor: 'HP', n: 15 });
    expect(getPricesMock).not.toHaveBeenCalled();
  });

  it('does not trigger 409 when marca is provided', async () => {
    const grande = Array.from({ length: 30 }, (_, i) =>
      producto(`S${i}`, `Notebook generico ${i}`, 'HP', 'Computadores'),
    );
    obtenerCatalogoMock.mockReturnValue(grande);
    getPricesMock.mockResolvedValue(new Map());

    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP' }, AUTH), res);
    expect(res.statusCode).toBe(200);
  });

  it('returns 503 when the catalog is not loaded yet', async () => {
    obtenerCatalogoMock.mockImplementation(() => {
      throw new CatalogUnavailableError();
    });

    const res = makeRes();
    await handler(makeReq({ q: 'hp' }, AUTH), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'catalogo_no_disponible' });
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `npx vitest run tests/search-endpoint.test.ts`
Expected: FAIL — no existe `api/search.ts`.

- [ ] **Step 3: Implementar `api/search.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '../lib/auth.js';
import { CatalogUnavailableError, obtenerCatalogo } from '../lib/catalog.js';
import { getPrices } from '../lib/providers/intcomex.js';
import { buscar, calcularFacetas } from '../lib/search.js';
import { ProviderError } from '../lib/types.js';

const UMBRAL_AMBIGUEDAD = 25;
const MAX_CANDIDATOS_A_COTIZAR = 50;
const LIMITE_POR_DEFECTO = 10;

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method && req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed', detail: 'Use GET' });
    return;
  }
  if (!isAuthorized(firstString(req.headers['x-api-key']), process.env.API_SECRET_KEY)) {
    res.status(401).json({ error: 'unauthorized', detail: 'Missing or invalid x-api-key header' });
    return;
  }

  const q = firstString(req.query.q)?.trim();
  if (!q) {
    res.status(400).json({ error: 'bad_request', detail: 'El parametro q es obligatorio' });
    return;
  }

  const marca = firstString(req.query.marca);
  const categoria = firstString(req.query.categoria);
  const precioMax = Number(firstString(req.query.precio_max) ?? NaN);
  const soloConStock = firstString(req.query.solo_con_stock) === 'true';
  const limite = Number(firstString(req.query.limite) ?? LIMITE_POR_DEFECTO) || LIMITE_POR_DEFECTO;

  let catalogo;
  try {
    catalogo = obtenerCatalogo();
  } catch (error) {
    if (error instanceof CatalogUnavailableError) {
      res.status(503).json({
        error: 'catalogo_no_disponible',
        detail: 'El catalogo aun no se ha descargado. Reintenta en unos segundos.',
      });
      return;
    }
    throw error;
  }

  const coincidencias = buscar(catalogo, { q, marca, categoria });
  const productosCoincidentes = coincidencias.map((r) => r.product);
  const facetas = calcularFacetas(productosCoincidentes);

  if (coincidencias.length > UMBRAL_AMBIGUEDAD && !marca && !categoria) {
    res.status(409).json({
      error: 'demasiado_amplio',
      detail: `${coincidencias.length} coincidencias. Acota con marca o categoria.`,
      total: coincidencias.length,
      facetas,
    });
    return;
  }

  const candidatos = productosCoincidentes.slice(0, MAX_CANDIDATOS_A_COTIZAR);

  let precios;
  try {
    precios = await getPrices(candidatos.map((p) => p.Sku));
  } catch (error) {
    if (error instanceof ProviderError) {
      res.status(502).json({ error: 'upstream', detail: error.detail ?? error.message });
      return;
    }
    res.status(502).json({ error: 'upstream', detail: 'Unexpected error calling provider' });
    return;
  }

  const productos = candidatos
    .map((p) => {
      const precio = precios.get(p.Sku);
      if (!precio) return null;
      return {
        sku: p.Sku,
        mpn: p.Mpn ?? null,
        nombre: p.Description ?? null,
        marca: p.Brand?.Description ?? null,
        categoria: p.Category?.Description ?? null,
        precio: precio.price,
        moneda: precio.currency,
        stock: precio.inStock,
      };
    })
    .filter((p): p is NonNullable<typeof p> => p !== null)
    .filter((p) => (Number.isFinite(precioMax) ? p.precio <= precioMax : true))
    .filter((p) => (soloConStock ? (p.stock ?? 0) > 0 : true))
    .slice(0, limite);

  res.status(200).json({ total: coincidencias.length, productos, facetas });
}
```

- [ ] **Step 4: Enrutar `/search` en `lib/server.ts`**

Reemplazar la función `priceRoutes` y su uso por una tabla de rutas:

```ts
function rutas(): Record<string, string> {
  const basePath = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');
  const tabla: Record<string, string> = {
    '/api/price': 'price',
    '/api/search': 'search',
  };
  if (basePath) {
    tabla[`${basePath}/price`] = 'price';
    tabla[`${basePath}/search`] = 'search';
  }
  return tabla;
}
```

y en el callback, resolver el handler por nombre:

```ts
import priceHandler from '../api/price.js';
import searchHandler from '../api/search.js';

const handlers = { price: priceHandler, search: searchHandler };
```

```ts
const nombre = tabla[url.pathname];
if (!nombre) {
  vres.status(404).json({ error: 'not_found', detail: 'Unknown route' });
  return;
}
// ...construcción de query igual que antes...
await handlers[nombre as keyof typeof handlers](req as unknown as VercelRequest, vres);
```

- [ ] **Step 5: Verificar que pasan (endpoint y servidor)**

Run: `npx vitest run tests/search-endpoint.test.ts tests/server.test.ts`
Expected: PASS — 11 nuevos y los 9 del servidor.

- [ ] **Step 6: Suite completa + typecheck**

Run: `npm test` y `npm run typecheck`
Expected: 66 tests PASS, typecheck exit 0.

- [ ] **Step 7: Commit**

```bash
git add api/search.ts lib/server.ts tests/search-endpoint.test.ts
git commit -m "feat: add GET /search endpoint for LLM product discovery"
```

---

### Task 5: Endpoints `/product/{sku}` y `/facetas`, arranque del catálogo y documentación

**Files:**
- Create: `api/product.ts`
- Create: `api/facetas.ts`
- Modify: `lib/server.ts` (rutas nuevas + carga del catálogo al arrancar)
- Modify: `server.ts` (cargar catálogo antes de escuchar)
- Modify: `README.md`
- Modify: `.env.example`
- Test: `tests/product-endpoint.test.ts`

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: rutas `/product/{sku}` y `/facetas` (con y sin `BASE_PATH`); `createApp()` sin cambios de firma; `server.ts` llama `cargarCatalogo()` antes de escuchar y programa un refresco cada 24 h.

- [ ] **Step 1: Escribir los tests que fallan (`tests/product-endpoint.test.ts`)**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { CatalogProduct } from '../lib/search.js';

const obtenerCatalogoMock = vi.fn();
const getPricesMock = vi.fn();

vi.mock('../lib/catalog.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/catalog.js')>('../lib/catalog.js');
  return { ...actual, obtenerCatalogo: () => obtenerCatalogoMock() };
});

vi.mock('../lib/providers/intcomex.js', () => ({
  getPrices: (skus: string[]) => getPricesMock(skus),
}));

const { default: productHandler } = await import('../api/product.js');
const { default: facetasHandler } = await import('../api/facetas.js');

const PRODUCTO: CatalogProduct = {
  Sku: 'HP1',
  Mpn: '2N6G5LT',
  Description: 'HP ProBook 640 G8 - Notebook - 14"',
  Type: 'Physical',
  Brand: { Description: 'HP' },
  Category: {
    Description: 'Computadores',
    Subcategories: [{ Description: 'Notebooks' }],
  },
};

function makeReq(query: Record<string, string>, headers: Record<string, string> = {}): VercelRequest {
  return { query, headers, method: 'GET' } as unknown as VercelRequest;
}

function makeRes(): VercelResponse & { statusCode: number; body: any } {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
  };
  return res;
}

const AUTH = { 'x-api-key': 'test-secret' };

beforeEach(() => {
  vi.stubEnv('API_SECRET_KEY', 'test-secret');
  obtenerCatalogoMock.mockReset().mockReturnValue([PRODUCTO]);
  getPricesMock.mockReset().mockResolvedValue(
    new Map([['HP1', { price: 1697.82, currency: 'us', inStock: 4 }]]),
  );
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /product/{sku}', () => {
  it('returns 401 without x-api-key', async () => {
    const res = makeRes();
    await productHandler(makeReq({ sku: 'HP1' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 without sku', async () => {
    const res = makeRes();
    await productHandler(makeReq({}, AUTH), res);
    expect(res.statusCode).toBe(400);
  });

  it('returns the full product sheet with price and stock', async () => {
    const res = makeRes();
    await productHandler(makeReq({ sku: 'HP1' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({
      sku: 'HP1',
      mpn: '2N6G5LT',
      marca: 'HP',
      categoria: 'Computadores',
      subcategorias: ['Notebooks'],
      tipo: 'Physical',
      precio: 1697.82,
      moneda: 'us',
      stock: 4,
    });
  });

  it('returns 404 for an unknown sku', async () => {
    const res = makeRes();
    await productHandler(makeReq({ sku: 'NOEXISTE' }, AUTH), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found' });
  });

  it('returns 404 when the catalog knows it but Intcomex has no price', async () => {
    getPricesMock.mockResolvedValue(new Map());
    const res = makeRes();
    await productHandler(makeReq({ sku: 'HP1' }, AUTH), res);
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /facetas', () => {
  it('lists brands and categories with counts', async () => {
    const res = makeRes();
    await facetasHandler(makeReq({}, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.marca).toContainEqual({ valor: 'HP', n: 1 });
    expect(res.body.categoria).toContainEqual({ valor: 'Computadores', n: 1 });
    expect(res.body.total_productos).toBe(1);
  });

  it('returns 401 without x-api-key', async () => {
    const res = makeRes();
    await facetasHandler(makeReq({}), res);
    expect(res.statusCode).toBe(401);
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `npx vitest run tests/product-endpoint.test.ts`
Expected: FAIL — no existen `api/product.ts` ni `api/facetas.ts`.

- [ ] **Step 3: Implementar `api/product.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '../lib/auth.js';
import { CatalogUnavailableError, obtenerCatalogo } from '../lib/catalog.js';
import { getPrices } from '../lib/providers/intcomex.js';
import { ProviderError } from '../lib/types.js';

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method && req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed', detail: 'Use GET' });
    return;
  }
  if (!isAuthorized(firstString(req.headers['x-api-key']), process.env.API_SECRET_KEY)) {
    res.status(401).json({ error: 'unauthorized', detail: 'Missing or invalid x-api-key header' });
    return;
  }

  const sku = firstString(req.query.sku)?.trim();
  if (!sku) {
    res.status(400).json({ error: 'bad_request', detail: 'El parametro sku es obligatorio' });
    return;
  }

  let catalogo;
  try {
    catalogo = obtenerCatalogo();
  } catch (error) {
    if (error instanceof CatalogUnavailableError) {
      res.status(503).json({
        error: 'catalogo_no_disponible',
        detail: 'El catalogo aun no se ha descargado. Reintenta en unos segundos.',
      });
      return;
    }
    throw error;
  }

  const producto = catalogo.find((p) => p.Sku === sku);
  if (!producto) {
    res.status(404).json({ error: 'not_found', detail: 'SKU no encontrado en el catalogo' });
    return;
  }

  let precios;
  try {
    precios = await getPrices([sku]);
  } catch (error) {
    const detail = error instanceof ProviderError ? (error.detail ?? error.message) : 'Unexpected error calling provider';
    res.status(502).json({ error: 'upstream', detail });
    return;
  }

  const precio = precios.get(sku);
  if (!precio) {
    res.status(404).json({ error: 'not_found', detail: 'Intcomex no entrego precio para este SKU' });
    return;
  }

  res.status(200).json({
    sku: producto.Sku,
    mpn: producto.Mpn ?? null,
    nombre: producto.Description ?? null,
    marca: producto.Brand?.Description ?? null,
    categoria: producto.Category?.Description ?? null,
    subcategorias: (producto.Category?.Subcategories ?? [])
      .map((s) => s.Description)
      .filter((d): d is string => Boolean(d)),
    tipo: producto.Type ?? null,
    precio: precio.price,
    moneda: precio.currency,
    stock: precio.inStock,
  });
}
```

- [ ] **Step 4: Implementar `api/facetas.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '../lib/auth.js';
import { CatalogUnavailableError, obtenerCatalogo } from '../lib/catalog.js';
import { calcularFacetas } from '../lib/search.js';

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method && req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed', detail: 'Use GET' });
    return;
  }
  if (!isAuthorized(firstString(req.headers['x-api-key']), process.env.API_SECRET_KEY)) {
    res.status(401).json({ error: 'unauthorized', detail: 'Missing or invalid x-api-key header' });
    return;
  }

  let catalogo;
  try {
    catalogo = obtenerCatalogo();
  } catch (error) {
    if (error instanceof CatalogUnavailableError) {
      res.status(503).json({
        error: 'catalogo_no_disponible',
        detail: 'El catalogo aun no se ha descargado. Reintenta en unos segundos.',
      });
      return;
    }
    throw error;
  }

  const facetas = calcularFacetas(catalogo);
  res.status(200).json({ total_productos: catalogo.length, ...facetas });
}
```

- [ ] **Step 5: Enrutar en `lib/server.ts`**

Importar los handlers nuevos y sumarlos al mapa:

```ts
import facetasHandler from '../api/facetas.js';
import priceHandler from '../api/price.js';
import productHandler from '../api/product.js';
import searchHandler from '../api/search.js';

const handlers = {
  price: priceHandler,
  search: searchHandler,
  product: productHandler,
  facetas: facetasHandler,
};
```

Extender la tabla de rutas fijas:

```ts
function rutas(): Record<string, string> {
  const basePath = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');
  const nombres = ['price', 'search', 'product', 'facetas'];
  const tabla: Record<string, string> = {};
  for (const nombre of nombres) {
    tabla[`/api/${nombre}`] = nombre;
    if (basePath) tabla[`${basePath}/${nombre}`] = nombre;
  }
  return tabla;
}
```

Y resolver `/product/{sku}` como ruta con parámetro. Dentro del callback, después de construir `url` y antes de consultar la tabla:

```ts
const basePath = (process.env.BASE_PATH ?? '').replace(/\/+$/, '');
const escapado = basePath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const patronProducto = new RegExp(`^(?:${escapado})?(?:/api)?/product/(.+)$`);

const conSku = patronProducto.exec(url.pathname);
const nombre = conSku ? 'product' : tabla[url.pathname];

if (!nombre) {
  vres.status(404).json({ error: 'not_found', detail: 'Unknown route' });
  return;
}

const query: Record<string, string> = {};
for (const [key, value] of url.searchParams) {
  if (!(key in query)) query[key] = value;
}
if (conSku) query.sku = decodeURIComponent(conSku[1]);
(req as unknown as VercelRequest).query = query;

await handlers[nombre as keyof typeof handlers](req as unknown as VercelRequest, vres);
```

El handler lee `req.query.sku`, así que en Vercel un archivo `api/product/[sku].ts` daría el mismo comportamiento sin tocar el handler.

- [ ] **Step 5b: Agregar tests de enrutamiento a `tests/server.test.ts`** (dentro del describe `BASE_PATH routing`)

```ts
  it('enruta /product/{sku} tomando el sku del path', async () => {
    const res = await fetch(`${prefixedBase}/rr/captador-precios/product/HP1`);
    // Sin x-api-key el handler responde 401: basta para probar que enrutó.
    expect(res.status).toBe(401);
  });

  it('404 para /product sin sku en el path', async () => {
    const res = await fetch(`${prefixedBase}/rr/captador-precios/product/`);
    expect(res.status).toBe(404);
  });
```

- [ ] **Step 6: Cargar el catálogo al arrancar (`server.ts`)**

```ts
import { cargarCatalogo } from './lib/catalog.js';
import { createApp } from './lib/server.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

process.on('unhandledRejection', (reason) => {
  console.error('[server] unhandled rejection', reason);
});

createApp().listen(port, host, () => {
  console.log(`price-fetcher API listening on http://${host}:${port}`);
});

// El catalogo se carga en segundo plano: el servidor ya responde (con 503 en
// las rutas que lo necesitan) mientras la primera descarga termina.
const REFRESCO_MS = 24 * 60 * 60 * 1000;

async function refrescarCatalogo(): Promise<void> {
  try {
    const productos = await cargarCatalogo();
    console.log(`[catalog] ${productos.length} productos disponibles`);
  } catch (error) {
    console.error('[catalog] no se pudo cargar el catalogo', error);
  }
}

void refrescarCatalogo();
setInterval(() => void refrescarCatalogo(), REFRESCO_MS).unref();
```

- [ ] **Step 7: Documentar en `.env.example`** (agregar al final)

```
# Ruta del archivo de cache del catalogo (opcional; default cache/catalog.json)
CATALOG_CACHE_PATH=
```

- [ ] **Step 8: Documentar en `README.md`** (nueva sección antes de "Hosting local")

````markdown
## Búsqueda de productos (para consumo por LLM)

Además de cotizar un SKU conocido, la API permite descubrir productos a partir de una descripción vaga. Pensado para que un LLM lo use como herramienta.

### `GET /search` — buscar productos

Parámetros: `q` (obligatorio, texto libre), `marca`, `categoria`, `precio_max`, `solo_con_stock`, `limite` (default 10).

```
GET /search?q=probook&marca=HP
Header: x-api-key: <API_SECRET_KEY>
```

Respuesta 200: `total`, `productos[]` (sku, mpn, nombre, marca, categoria, precio, moneda, stock) y `facetas`.

Si la consulta calza más de 25 productos y no se envió `marca` ni `categoria`, responde **409** con el total y las facetas disponibles, para que el LLM repregunte con opciones concretas en vez de adivinar.

### `GET /product/{sku}` — ficha completa

Devuelve descripción íntegra, marca, categoría con subcategorías, tipo, precio, moneda y stock.

### `GET /facetas` — vocabulario del catálogo

Lista las marcas y categorías reales con su conteo. No es una herramienta para el LLM: sirve para construir el prompt del sistema con el vocabulario que Intcomex realmente usa.

### Catálogo

El catálogo (unos 10.000 productos) se descarga al arrancar y se refresca cada 24 horas, con copia en `cache/catalog.json`. Mientras la primera descarga no termina, estos tres endpoints responden **503 `catalogo_no_disponible`**. Si el refresco falla pero hay copia en disco, se sigue usando la copia vencida: el precio siempre se consulta en vivo, así que lo único desactualizado sería el surtido.

> **Importante:** las respuestas de búsqueda traen el precio de **costo**. Si el consumidor es un LLM que habla con clientes finales, el margen debe aplicarse en un nodo determinista antes de que la respuesta entre al contexto del modelo.
````

- [ ] **Step 9: Verificar que pasan**

Run: `npx vitest run tests/product-endpoint.test.ts tests/server.test.ts`
Expected: PASS — 7 nuevos del endpoint y 11 del servidor (9 previos + 2 de enrutamiento).

- [ ] **Step 10: Suite completa + typecheck**

Run: `npm test` y `npm run typecheck`
Expected: 75 tests PASS, typecheck exit 0.

- [ ] **Step 11: Commit**

```bash
git add api/product.ts api/facetas.ts lib/server.ts server.ts README.md .env.example tests/product-endpoint.test.ts
git commit -m "feat: add product detail and facets endpoints, load catalog on boot"
```

---

## Post-implementación (manual, con el usuario)

1. Merge de la rama a `main` (PR) y `git pull` en el PC que sirve la API.
2. Reiniciar el servidor (`npm run serve` o la tarea programada) para que descargue el catálogo.
3. Probar en vivo contra Intcomex producción:
   - `GET /rr/captador-precios/search?q=probook&marca=HP`
   - `GET /rr/captador-precios/search?q=notebook` (esperar 409 con facetas)
   - `GET /rr/captador-precios/product/MT027DEL20`
   - `GET /rr/captador-precios/facetas`
4. Con la salida de `/facetas`, redactar el prompt del sistema del LLM en Kapso: qué marcas y categorías existen, cuándo usar cada tool, y la regla de repreguntar ante un 409.
5. Implementar en Kapso el nodo determinista que aplica márgenes y elimina el costo antes de entregar al LLM.
6. Agregar la regla de rate limiting en el WAF de Cloudflare.
