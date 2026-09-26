# Búsqueda multi-mayorista — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que `GET /search` busque en Intcomex, Ingram y Tecnoglobal y muestre por producto el mismo ganador que elige la cotización (`pickBest`), para que el precio del catálogo coincida con el cobrado.

**Architecture:** Funciones puras nuevas para agrupar coincidencias por `unionKey` y elegir el ganador con `pickBest` (exportado del comparador); una función `cotizarLote` que cotiza los SKU de un mayorista con caché + lotes en paralelo + límite de reloj; un handler nuevo `createMultiSearchHandler` que reutiliza el parseo de parámetros, `explainEmpty` y el contrato de respuesta del handler de un mayorista. `api/search.ts` pasa a usar el handler nuevo; `/{proveedor}/search` no cambia.

**Tech Stack:** TypeScript (ESM), vitest, `@vercel/node` handlers servidos por el servidor local de la `pricing-api`.

**Spec:** `docs/superpowers/specs/2026-09-25-busqueda-multi-proveedor-design.md`

## Global Constraints

- Criterio de ganador: `pickBest` de `packages/providers/src/comparator.ts` tal cual (con stock > stock desconocido > sin stock; el más barato dentro de cada nivel). No se reimplementa.
- Por mayorista, la oferta de un grupo es su SKU más barato con precio.
- Productos sin `unionKey` solo entran si son de `intcomex`.
- Topes: 25 grupos para `demasiado_amplio` sin filtros; 50 candidatos sin filtros, 300 con filtros; presupuesto de 20 000 ms para cotizar.
- El contrato de respuesta de `/search` se mantiene y cada producto suma `proveedor`.
- `/{proveedor}/search` no cambia de comportamiento.
- Comentarios en español sin tildes. Tests con vitest desde la raíz; `npm run typecheck` también revisa tests.
- Todos los commits terminan con estas dos líneas, verbatim:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0181D9EDBLHn8Srbz98ydxeb
  ```

---

### Task 1: Agrupar coincidencias y elegir ganador

**Files:**
- Modify: `packages/providers/src/comparator.ts` (exportar `pickBest` y `cheapest`)
- Create: `apps/pricing-api/src/handlers/busqueda-multi.ts`
- Test: `apps/pricing-api/tests/busqueda-multi.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // comparator.ts
  export function pickBest(ofertas: Offer[]): WinningOffer | null;
  export function cheapest(proveedor: string, prices: Map<string, PriceInfo>): Offer | null;
  // busqueda-multi.ts
  export interface GrupoBusqueda {
    clave: string; score: number;
    porProveedor: Record<string, NormalizedProduct[]>;
    representante: NormalizedProduct;
  }
  export function agruparCoincidencias(porProveedor: Array<{ proveedor: string; matches: ScoredProduct[] }>): GrupoBusqueda[];
  export type Ganador = WinningOffer & { producto: NormalizedProduct };
  export function elegirGanador(grupo: GrupoBusqueda, precios: Record<string, Map<string, PriceInfo>>): Ganador | null;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/pricing-api/tests/busqueda-multi.test.ts
import { describe, expect, it } from 'vitest';
import type { NormalizedProduct } from '@rr/domain/product';
import type { PriceInfo } from '@rr/domain/types';
import { agruparCoincidencias, elegirGanador } from '../src/handlers/busqueda-multi.js';

function prod(sku: string, mpn: string | null, marca: string | null, nombre = sku): NormalizedProduct {
  return { sku, mpn, nombre, marca, categoria: 'Componentes', subcategorias: [], tipo: null };
}
const precio = (price: number, inStock: number | null): PriceInfo => ({ price, currency: 'USD', inStock });

describe('agruparCoincidencias', () => {
  it('junta el mismo producto de dos mayoristas aunque el MPN venga escrito distinto', () => {
    const grupos = agruparCoincidencias([
      { proveedor: 'intcomex', matches: [{ product: prod('I1', 'BX8071514100F', 'Intel'), score: 5 }] },
      { proveedor: 'ingram', matches: [{ product: prod('G1', 'BX80715-14100F', 'INTEL CORP'), score: 7 }] },
    ]);
    expect(grupos).toHaveLength(1);
    expect(grupos[0].score).toBe(7);
    expect(Object.keys(grupos[0].porProveedor).sort()).toEqual(['ingram', 'intcomex']);
    expect(grupos[0].representante.sku).toBe('I1');
  });

  it('sin clave solo entra desde Intcomex, cada uno como grupo propio', () => {
    const grupos = agruparCoincidencias([
      { proveedor: 'intcomex', matches: [{ product: prod('I1', null, 'HP'), score: 3 }, { product: prod('I2', null, null), score: 2 }] },
      { proveedor: 'tecnoglobal', matches: [{ product: prod('T1', null, 'HP'), score: 9 }] },
    ]);
    expect(grupos.map((g) => g.representante.sku)).toEqual(['I1', 'I2']);
  });

  it('ordena por puntaje; en empate respeta el orden de llegada', () => {
    const grupos = agruparCoincidencias([
      { proveedor: 'intcomex', matches: [{ product: prod('I1', 'A1', 'HP'), score: 2 }, { product: prod('I2', 'B2', 'HP'), score: 2 }] },
      { proveedor: 'ingram', matches: [{ product: prod('G3', 'C3', 'HP'), score: 5 }] },
    ]);
    expect(grupos.map((g) => g.representante.sku)).toEqual(['G3', 'I1', 'I2']);
  });
});

describe('elegirGanador', () => {
  const grupo = agruparCoincidencias([
    { proveedor: 'intcomex', matches: [{ product: prod('I1', 'BX8071514100F', 'Intel'), score: 5 }] },
    { proveedor: 'ingram', matches: [{ product: prod('G1', 'BX8071514100F', 'Intel'), score: 5 }] },
  ])[0];

  it('caso real: Ingram con stock gana a Intcomex sin stock', () => {
    const g = elegirGanador(grupo, { intcomex: new Map([['I1', precio(169.23, 0)]]), ingram: new Map([['G1', precio(93.49, 16)]]) });
    expect(g).toMatchObject({ proveedor: 'ingram', sku: 'G1', precio: 93.49, stock: 16, criterio: 'mas_barato_con_stock' });
    expect(g?.producto.sku).toBe('G1');
  });

  it('con stock en los dos gana el mas barato; un mayorista sin precio no participa', () => {
    expect(elegirGanador(grupo, { intcomex: new Map([['I1', precio(90, 3)]]), ingram: new Map([['G1', precio(93, 16)]]) })?.proveedor).toBe('intcomex');
    expect(elegirGanador(grupo, { intcomex: new Map([['I1', precio(169, 0)]]), ingram: new Map() })?.proveedor).toBe('intcomex');
    expect(elegirGanador(grupo, { intcomex: new Map(), ingram: new Map() })).toBeNull();
  });

  it('un precio no positivo no compite', () => {
    expect(elegirGanador(grupo, { intcomex: new Map([['I1', precio(0, 5)]]), ingram: new Map([['G1', precio(93, 0)]]) })?.proveedor).toBe('ingram');
  });

  it('dentro de un mayorista toma su SKU mas barato', () => {
    const dos = agruparCoincidencias([{ proveedor: 'intcomex', matches: [
      { product: prod('I1', 'X1', 'HP'), score: 1 }, { product: prod('I2', 'X-1', 'HP'), score: 1 },
    ] }])[0];
    expect(elegirGanador(dos, { intcomex: new Map([['I1', precio(20, 5)], ['I2', precio(18, 5)]]) })?.sku).toBe('I2');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/pricing-api/tests/busqueda-multi.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implement**

En `packages/providers/src/comparator.ts`, cambiar `function pickBest(` por `export function pickBest(` y `function cheapest(` por `export function cheapest(` (sin otro cambio).

```ts
// apps/pricing-api/src/handlers/busqueda-multi.ts
import { unionKey, type NormalizedProduct } from '@rr/domain/product';
import type { ScoredProduct } from '@rr/domain/search';
import type { PriceInfo } from '@rr/domain/types';
import { cheapest, pickBest, type Offer, type WinningOffer } from '@rr/providers/comparator';

// Piezas puras de la busqueda en los tres mayoristas. Ver
// docs/superpowers/specs/2026-09-25-busqueda-multi-proveedor-design.md.

export interface GrupoBusqueda {
  clave: string;
  score: number;
  porProveedor: Record<string, NormalizedProduct[]>;
  /** Producto que representa al grupo en facetas: el de Intcomex si hay; si no, el de mayor puntaje. */
  representante: NormalizedProduct;
}

export function agruparCoincidencias(porProveedor: Array<{ proveedor: string; matches: ScoredProduct[] }>): GrupoBusqueda[] {
  const grupos = new Map<string, GrupoBusqueda & { mejorScoreRep: number; repDeIntcomex: boolean; orden: number }>();
  let orden = 0;
  for (const { proveedor, matches } of porProveedor) {
    for (const { product, score } of matches) {
      let clave = unionKey(product);
      if (!clave) {
        // Sin clave no se puede comparar; la cotizacion solo sabe resolverlo
        // por SKU de Intcomex, asi que los demas mayoristas no lo aportan.
        if (proveedor !== 'intcomex') continue;
        clave = `sku:intcomex:${product.sku}`;
      }
      let g = grupos.get(clave);
      if (!g) {
        g = { clave, score, porProveedor: {}, representante: product, mejorScoreRep: score, repDeIntcomex: proveedor === 'intcomex', orden: orden++ };
        grupos.set(clave, g);
      }
      (g.porProveedor[proveedor] ??= []).push(product);
      g.score = Math.max(g.score, score);
      const esIntcomex = proveedor === 'intcomex';
      if ((esIntcomex && !g.repDeIntcomex) || (!g.repDeIntcomex && score > g.mejorScoreRep)) {
        g.representante = product;
        g.mejorScoreRep = score;
        g.repDeIntcomex = esIntcomex;
      }
    }
  }
  return [...grupos.values()]
    .sort((a, b) => b.score - a.score || a.orden - b.orden)
    .map(({ clave, score, porProveedor, representante }) => ({ clave, score, porProveedor, representante }));
}

export type Ganador = WinningOffer & { producto: NormalizedProduct };

export function elegirGanador(grupo: GrupoBusqueda, precios: Record<string, Map<string, PriceInfo>>): Ganador | null {
  const ofertas: Offer[] = [];
  const productoDe = new Map<string, NormalizedProduct>();
  for (const [proveedor, productos] of Object.entries(grupo.porProveedor)) {
    // Misma regla que la cotizacion: por mayorista, su SKU mas barato con
    // precio valido (cheapest descarta precios no positivos).
    const delGrupo = new Map<string, PriceInfo>();
    for (const producto of productos) {
      const p = precios[proveedor]?.get(producto.sku);
      if (p) delGrupo.set(producto.sku, p);
      productoDe.set(`${proveedor}:${producto.sku}`, producto);
    }
    const oferta = cheapest(proveedor, delGrupo);
    if (oferta) ofertas.push(oferta);
  }
  const ganadora = pickBest(ofertas);
  if (!ganadora) return null;
  return { ...ganadora, producto: productoDe.get(`${ganadora.proveedor}:${ganadora.sku}`)! };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/pricing-api/tests/busqueda-multi.test.ts packages/providers/tests/comparator.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src/comparator.ts apps/pricing-api/src/handlers/busqueda-multi.ts apps/pricing-api/tests/busqueda-multi.test.ts
git commit -m "feat(busqueda): agrupar coincidencias de los tres mayoristas y elegir ganador con pickBest"
```

---

### Task 2: Cotizar en lote con caché y límite de reloj

**Files:**
- Create: `apps/pricing-api/src/handlers/cotizar-lote.ts`
- Test: `apps/pricing-api/tests/cotizar-lote.test.ts`

**Interfaces:**
- Consumes: `getPriceCache(proveedor)` de `@rr/providers/price-cache` (`get(skus) → { fresh, usable }` de `CachedPrice { info: PriceInfo | null; quotedAt }`, `put(results, requested)`), `Provider` de `@rr/domain/types`.
- Produces:
  ```ts
  export interface ResultadoLote { precios: Map<string, PriceInfo>; maxAgeMs: number; incompleto: boolean; fallaTotal: boolean }
  export async function cotizarLote(provider: Provider, skus: string[], deadline: number): Promise<ResultadoLote>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// apps/pricing-api/tests/cotizar-lote.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { PriceInfo, Provider } from '@rr/domain/types';
import { getPriceCache, resetPriceCachesForTests } from '@rr/providers/price-cache';
import { cotizarLote } from '../src/handlers/cotizar-lote.js';

const P = (price: number, inStock = 1): PriceInfo => ({ price, currency: 'USD', inStock });

function proveedor(getPrices: (skus: string[]) => Promise<Map<string, PriceInfo>>, lote = 2): Provider {
  return {
    name: 'ingram', maxSkusPerBatch: lote, isConfigured: () => true,
    loadCatalog: async () => [], getPrices: vi.fn(getPrices), getPrice: async () => { throw new Error('no usado'); },
  } as unknown as Provider;
}

beforeEach(() => {
  vi.stubEnv('CATALOG_CACHE_DIR', mkdtempSync(join(tmpdir(), 'lote-')));
  resetPriceCachesForTests();
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('cotizarLote', () => {
  it('usa el cache fresco sin llamar al mayorista', async () => {
    getPriceCache('ingram').put(new Map([['A', P(10)]]), ['A']);
    const prov = proveedor(async () => new Map());
    const r = await cotizarLote(prov, ['A'], Date.now() + 5000);
    expect(r.precios.get('A')?.price).toBe(10);
    expect(prov.getPrices).not.toHaveBeenCalled();
    expect(r.incompleto).toBe(false);
  });

  it('cotiza lo pendiente en lotes paralelos y lo guarda en cache', async () => {
    const prov = proveedor(async (skus) => new Map(skus.map((s) => [s, P(s.charCodeAt(0))])));
    const r = await cotizarLote(prov, ['A', 'B', 'C', 'A'], Date.now() + 5000);
    expect(prov.getPrices).toHaveBeenCalledTimes(2); // A,B y C (lote de 2, sin duplicados)
    expect([...r.precios.keys()].sort()).toEqual(['A', 'B', 'C']);
    expect(getPriceCache('ingram').get(['C']).fresh.has('C')).toBe(true);
    expect(r.maxAgeMs).toBe(0);
  });

  it('un lote fallido se rescata del cache utilizable; lo que no esta queda incompleto', async () => {
    const cache = getPriceCache('ingram');
    cache.put(new Map([['A', P(10)]]), ['A']);
    // Envejecer la entrada: pasa de fresca (15 min) a utilizable (24 h).
    vi.useFakeTimers({ now: Date.now() + 20 * 60 * 1000, toFake: ['Date'] });
    const prov = proveedor(async () => { throw new Error('caido'); });
    const r = await cotizarLote(prov, ['A', 'B'], Date.now() + 5000);
    expect(r.precios.get('A')?.price).toBe(10);
    expect(r.precios.has('B')).toBe(false);
    expect(r.incompleto).toBe(true);
    expect(r.fallaTotal).toBe(true);
    expect(r.maxAgeMs).toBeGreaterThan(15 * 60 * 1000);
  });

  it('un lote que no responde antes del limite se corta', async () => {
    const prov = proveedor(() => new Promise(() => {}));
    const inicio = Date.now();
    const r = await cotizarLote(prov, ['A'], Date.now() + 50);
    expect(Date.now() - inicio).toBeLessThan(2000);
    expect(r.precios.size).toBe(0);
    expect(r.incompleto).toBe(true);
  });

  it('sin SKU no llama a nada', async () => {
    const prov = proveedor(async () => new Map());
    expect(await cotizarLote(prov, [], Date.now() + 5000)).toEqual({ precios: new Map(), maxAgeMs: 0, incompleto: false, fallaTotal: false });
    expect(prov.getPrices).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/pricing-api/tests/cotizar-lote.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implement**

```ts
// apps/pricing-api/src/handlers/cotizar-lote.ts
import { getPriceCache, type CachedPrice } from '@rr/providers/price-cache';
import type { PriceInfo, Provider } from '@rr/domain/types';

export interface ResultadoLote {
  /** Solo los SKU con precio. */
  precios: Map<string, PriceInfo>;
  /** Edad del dato de cache mas viejo que se uso con precio; 0 si todo fue en vivo. */
  maxAgeMs: number;
  /** Algun SKU quedo sin resolver: ni en vivo ni en cache. */
  incompleto: boolean;
  /** Habia SKU por cotizar en vivo y ningun lote respondio. */
  fallaTotal: boolean;
}

function conLimite<T>(promesa: Promise<T>, deadline: number): Promise<T> {
  const restante = Math.max(0, deadline - Date.now());
  let timer: ReturnType<typeof setTimeout> | undefined;
  const corte = new Promise<never>((_, rechazar) => {
    timer = setTimeout(() => rechazar(new Error('limite de tiempo')), restante);
  });
  return Promise.race([promesa, corte]).finally(() => clearTimeout(timer));
}

// Cotiza los SKU de UN mayorista para la busqueda: cache fresco primero, lo
// pendiente en vivo en lotes paralelos cortados por un mismo limite de reloj,
// y lo que falle se rescata del cache utilizable. Misma politica que el
// handler de un mayorista (ver search.ts), sin la sonda: aca se cotizan los
// candidatos de los tres mayoristas a la vez.
export async function cotizarLote(provider: Provider, skus: string[], deadline: number): Promise<ResultadoLote> {
  const unicos = [...new Set(skus)];
  const precios = new Map<string, PriceInfo>();
  if (unicos.length === 0) return { precios, maxAgeMs: 0, incompleto: false, fallaTotal: false };

  const cache = getPriceCache(provider.name);
  const lookup = cache.get(unicos);
  let maxAgeMs = 0;
  const usar = (sku: string, entrada: CachedPrice) => {
    // info null = negativo cacheado: el mayorista no tiene precio para ese SKU.
    if (!entrada.info) return;
    precios.set(sku, entrada.info);
    maxAgeMs = Math.max(maxAgeMs, Date.now() - entrada.quotedAt);
  };

  const pendientes: string[] = [];
  for (const sku of unicos) {
    const fresca = lookup.fresh.get(sku);
    if (fresca) usar(sku, fresca);
    else pendientes.push(sku);
  }
  if (pendientes.length === 0) return { precios, maxAgeMs, incompleto: false, fallaTotal: false };

  const lotes: string[][] = [];
  for (let i = 0; i < pendientes.length; i += provider.maxSkusPerBatch) lotes.push(pendientes.slice(i, i + provider.maxSkusPerBatch));
  const resultados = await Promise.allSettled(lotes.map((lote) => conLimite(provider.getPrices(lote), deadline)));

  let algunoOk = false;
  let incompleto = false;
  resultados.forEach((r, i) => {
    const lote = lotes[i];
    if (r.status === 'fulfilled') {
      algunoOk = true;
      cache.put(r.value, lote);
      for (const sku of lote) {
        const p = r.value.get(sku);
        if (p) precios.set(sku, p);
      }
      return;
    }
    console.error(`[search] ${provider.name}: lote sin respuesta`, { skus: lote.length, error: r.reason instanceof Error ? r.reason.message : r.reason });
    for (const sku of lote) {
      const utilizable = lookup.usable.get(sku);
      if (utilizable) usar(sku, utilizable);
      else incompleto = true;
    }
  });
  return { precios, maxAgeMs, incompleto, fallaTotal: !algunoOk };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/pricing-api/tests/cotizar-lote.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/pricing-api/src/handlers/cotizar-lote.ts apps/pricing-api/tests/cotizar-lote.test.ts
git commit -m "feat(busqueda): cotizar SKU de un mayorista en lotes paralelos con cache y limite de reloj"
```

---

### Task 3: Extraer lo compartido del handler de un mayorista

**Files:**
- Modify: `apps/pricing-api/src/handlers/search.ts`
- Modify: `apps/pricing-api/tests/search-endpoint.test.ts`, `apps/pricing-api/tests/error-contract.test.ts` (import del handler)

**Interfaces:**
- Produces (exportados desde `search.ts`, sin cambiar comportamiento):
  ```ts
  export interface Cotizado { sku; mpn; nombre; marca; categoria; precio; moneda; stock; foto; proveedor?: string }
  export const UMBRAL_AMBIGUEDAD = 25, LIMITE_POR_DEFECTO = 10, MAX_CANDIDATOS_SIN_FILTROS = 50, MAX_CANDIDATOS_CON_FILTROS = 300, PRESUPUESTO_MS = 20000;
  export interface ParametrosBusqueda { q: string; marca?: string; categoria?: string; subcategoria?: string; onlyWithStock: boolean; maxPrice: number; limit: number }
  /** Valida metodo, api key y parametros; si algo falla, ya respondio y devuelve null. */
  export function leerParametrosBusqueda(req: VercelRequest, res: VercelResponse): ParametrosBusqueda | null;
  export function explainEmpty(evaluados: Cotizado[], onlyWithStock: boolean, truncado: boolean): { motivo: string; alternativa: Cotizado };
  ```

- [ ] **Step 1: Refactor sin cambio de comportamiento**

En `search.ts`:
1. Exportar las cinco constantes (`export const`), `interface Cotizado` (sumándole el campo opcional `proveedor?: string` con el comentario `/** Mayorista ganador; solo lo informa /search, que compara los tres. */`) y `explainEmpty`.
2. Mover a `export function leerParametrosBusqueda(req, res)` el bloque que hoy va desde el chequeo de método hasta el parseo de `limite` (líneas ~89-139 del handler), devolviendo `{ q, marca, categoria, subcategoria, onlyWithStock, maxPrice, limit }` o `null` después de responder el error exacto de hoy (405, 401, 400 con los mismos `detail`).
3. En `createSearchHandler`, reemplazar ese bloque por:
   ```ts
   const params = leerParametrosBusqueda(req, res);
   if (!params) return;
   const { q, marca, categoria, subcategoria, onlyWithStock, maxPrice, limit } = params;
   ```

En `apps/pricing-api/tests/search-endpoint.test.ts` y `apps/pricing-api/tests/error-contract.test.ts`, el import `await import('../api/search.js')` pasa a apuntar al handler de un mayorista, que es lo que esas suites prueban (en la Task 4 `api/search.ts` cambia a la búsqueda multi):
```ts
const { createSearchHandler } = await import('../src/handlers/search.js');
const { PROVIDERS } = await import('@rr/providers');
const handler = createSearchHandler(PROVIDERS.intcomex);   // en error-contract: const searchHandler = ...
```
(Esos archivos ya mockean `@rr/providers/intcomex`, así que `PROVIDERS.intcomex` es el mock.)

- [ ] **Step 2: Verify nothing changed**

Run: `npx vitest run apps/pricing-api && npm run typecheck`
Expected: PASS, con la misma cantidad de tests que antes del refactor en `apps/pricing-api`.

- [ ] **Step 3: Commit**

```bash
git add apps/pricing-api/src/handlers/search.ts apps/pricing-api/tests/search-endpoint.test.ts apps/pricing-api/tests/error-contract.test.ts
git commit -m "refactor(busqueda): exportar parametros, constantes y explainEmpty del handler de un mayorista"
```

---

### Task 4: Handler de búsqueda en los tres mayoristas

**Files:**
- Create: `apps/pricing-api/src/handlers/search-multi.ts`
- Modify: `apps/pricing-api/api/search.ts`
- Modify: `docs/api/README.md`, `docs/api/openapi.yaml` (documentar `proveedor` y el comportamiento de `/search`)
- Test: `apps/pricing-api/tests/search-multi.test.ts`

**Interfaces:**
- Consumes: Tasks 1–3; `getCatalog`, `CatalogUnavailableError` de `@rr/providers/catalog`; `search`, `computeFacets` de `@rr/domain/search`; `fotoDe` de `@rr/providers/fotos/indice`.
- Produces: `export function createMultiSearchHandler(providers: Record<string, Provider>): Handler;` y `api/search.ts` → `export default createMultiSearchHandler(PROVIDERS);`

- [ ] **Step 1: Write the failing test**

```ts
// apps/pricing-api/tests/search-multi.test.ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { NormalizedProduct } from '@rr/domain/product';
import type { PriceInfo, Provider } from '@rr/domain/types';
import { CatalogUnavailableError } from '@rr/providers/catalog';
import { resetPriceCachesForTests } from '@rr/providers/price-cache';

const catalogos: Record<string, NormalizedProduct[] | undefined> = {};
vi.mock('@rr/providers/catalog', async () => {
  const actual = await vi.importActual<typeof import('@rr/providers/catalog')>('@rr/providers/catalog');
  return {
    ...actual,
    getCatalog: (p: string) => {
      const c = catalogos[p];
      if (!c) throw new actual.CatalogUnavailableError();
      return c;
    },
  };
});

const { createMultiSearchHandler } = await import('../src/handlers/search-multi.js');

const prod = (sku: string, mpn: string, nombre: string, marca = 'Intel', categoria = 'Procesadores'): NormalizedProduct =>
  ({ sku, mpn, nombre, marca, categoria, subcategorias: [], tipo: null });
const P = (price: number, inStock: number | null): PriceInfo => ({ price, currency: 'USD', inStock });

function proveedor(name: string, precios: Record<string, PriceInfo>, falla = false): Provider {
  return {
    name, maxSkusPerBatch: 50, isConfigured: () => true, loadCatalog: async () => [],
    getPrices: vi.fn(async (skus: string[]) => {
      if (falla) throw new Error('caido');
      return new Map(skus.filter((s) => precios[s]).map((s) => [s, precios[s]]));
    }),
    getPrice: async () => { throw new Error('no usado'); },
  } as unknown as Provider;
}

const req = (query: Record<string, string>, headers: Record<string, string> = { 'x-api-key': 'k' }) =>
  ({ method: 'GET', query, headers }) as unknown as VercelRequest;
function res() {
  const r: any = { statusCode: 0, body: undefined, status(c: number) { r.statusCode = c; return r; }, json(b: unknown) { r.body = b; return r; } };
  return r as VercelResponse & { statusCode: number; body: any };
}

beforeEach(() => {
  vi.stubEnv('API_SECRET_KEY', 'k');
  vi.stubEnv('CATALOG_CACHE_DIR', mkdtempSync(join(tmpdir(), 'multi-')));
  resetPriceCachesForTests();
  for (const k of Object.keys(catalogos)) delete catalogos[k];
});
afterEach(() => { vi.unstubAllEnvs(); });

describe('GET /search (tres mayoristas)', () => {
  it('muestra el ganador de pickBest con su SKU, precio y proveedor', async () => {
    catalogos.intcomex = [prod('I1', 'BX8071514100F', 'Intel Core i5 14100F')];
    catalogos.ingram = [prod('G1', 'BX8071514100F', 'INTEL CORE I5-14100F', 'INTEL CORP')];
    const h = createMultiSearchHandler({
      intcomex: proveedor('intcomex', { I1: P(169.23, 0) }),
      ingram: proveedor('ingram', { G1: P(93.49, 16) }),
    });
    const r = res();
    await h(req({ q: 'core i5' }), r);
    expect(r.statusCode).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.productos).toHaveLength(1);
    expect(r.body.productos[0]).toMatchObject({ sku: 'G1', proveedor: 'ingram', precio: 93.49, stock: 16, moneda: 'USD' });
  });

  it('aplica solo_con_stock y precio_max al ganador', async () => {
    catalogos.intcomex = [prod('I1', 'A1', 'Toner negro', 'HP', 'Toner'), prod('I2', 'B2', 'Toner color', 'HP', 'Toner')];
    const h = createMultiSearchHandler({ intcomex: proveedor('intcomex', { I1: P(50, 0), I2: P(30, 4) }) });
    let r = res();
    await h(req({ q: 'toner', solo_con_stock: 'true' }), r);
    expect(r.body.productos.map((p: any) => p.sku)).toEqual(['I2']);
    r = res();
    await h(req({ q: 'toner', precio_max: '40' }), r);
    expect(r.body.productos.map((p: any) => p.sku)).toEqual(['I2']);
  });

  it('un mayorista caido deja la respuesta parcial con lo de los demas', async () => {
    catalogos.intcomex = [prod('I1', 'A1', 'Toner negro', 'HP', 'Toner')];
    catalogos.ingram = [prod('G1', 'A1', 'Toner negro', 'HP', 'Toner')];
    const h = createMultiSearchHandler({
      intcomex: proveedor('intcomex', { I1: P(50, 3) }),
      ingram: proveedor('ingram', {}, true),
    });
    const r = res();
    await h(req({ q: 'toner' }), r);
    expect(r.statusCode).toBe(200);
    expect(r.body.parcial).toBe(true);
    expect(r.body.productos[0].proveedor).toBe('intcomex');
  });

  it('502 si no se pudo cotizar nada; 503 si ningun catalogo cargo', async () => {
    catalogos.intcomex = [prod('I1', 'A1', 'Toner negro', 'HP', 'Toner')];
    let r = res();
    await createMultiSearchHandler({ intcomex: proveedor('intcomex', {}, true) })(req({ q: 'toner' }), r);
    expect(r.statusCode).toBe(502);
    delete catalogos.intcomex;
    r = res();
    await createMultiSearchHandler({ intcomex: proveedor('intcomex', {}) })(req({ q: 'toner' }), r);
    expect(r.statusCode).toBe(503);
  });

  it('demasiado amplio cuenta grupos, no filas de cada catalogo', async () => {
    catalogos.intcomex = Array.from({ length: 20 }, (_, i) => prod(`I${i}`, `M${i}`, `Toner ${i}`, 'HP', 'Toner'));
    catalogos.ingram = Array.from({ length: 20 }, (_, i) => prod(`G${i}`, `M${i}`, `Toner ${i}`, 'HP', 'Toner'));
    const h = createMultiSearchHandler({ intcomex: proveedor('intcomex', {}), ingram: proveedor('ingram', {}) });
    const r = res();
    await h(req({ q: 'toner' }), r);
    expect(r.statusCode).toBe(200); // 20 grupos, no 40
  });

  it('mismos errores de entrada que el handler de un mayorista', async () => {
    const h = createMultiSearchHandler({ intcomex: proveedor('intcomex', {}) });
    let r = res(); await h(req({ q: 'x' }, {}), r); expect(r.statusCode).toBe(401);
    r = res(); await h(req({}), r); expect(r.statusCode).toBe(400);
    r = res(); await h({ ...req({ q: 'x' }), method: 'POST' } as VercelRequest, r); expect(r.statusCode).toBe(405);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/pricing-api/tests/search-multi.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implement**

```ts
// apps/pricing-api/src/handlers/search-multi.ts
import { CatalogUnavailableError, getCatalog } from '@rr/providers/catalog';
import { fotoDe } from '@rr/providers/fotos/indice';
import { computeFacets, search } from '@rr/domain/search';
import type { NormalizedProduct } from '@rr/domain/product';
import type { PriceInfo, Provider } from '@rr/domain/types';
import { agruparCoincidencias, elegirGanador } from './busqueda-multi.js';
import { cotizarLote } from './cotizar-lote.js';
import {
  MAX_CANDIDATOS_CON_FILTROS, MAX_CANDIDATOS_SIN_FILTROS, PRESUPUESTO_MS, UMBRAL_AMBIGUEDAD,
  explainEmpty, leerParametrosBusqueda, type Cotizado,
} from './search.js';
import type { Handler } from './types.js';

function catalogoDe(nombre: string): NormalizedProduct[] | null {
  try {
    return getCatalog(nombre);
  } catch (error) {
    if (error instanceof CatalogUnavailableError) return null;
    throw error;
  }
}

// GET /search: busca en los catalogos de todos los mayoristas cargados y, por
// producto, muestra el mismo ganador que elige la cotizacion (pickBest). Ver
// docs/superpowers/specs/2026-09-25-busqueda-multi-proveedor-design.md.
export function createMultiSearchHandler(providers: Record<string, Provider>): Handler {
  return async function handler(req, res): Promise<void> {
    const params = leerParametrosBusqueda(req, res);
    if (!params) return;
    const { q, marca, categoria, subcategoria, onlyWithStock, maxPrice, limit } = params;

    const cargados = Object.values(providers)
      .map((provider) => ({ provider, catalogo: catalogoDe(provider.name) }))
      .filter((c): c is { provider: Provider; catalogo: NormalizedProduct[] } => c.catalogo !== null);
    if (cargados.length === 0) {
      res.status(503).json({ error: 'catalogo_no_disponible', detail: 'El catalogo aun no esta disponible. Reintenta mas tarde.' });
      return;
    }

    const grupos = agruparCoincidencias(
      cargados.map(({ provider, catalogo }) => ({ proveedor: provider.name, matches: search(catalogo, { q, marca, categoria, subcategoria }) })),
    );
    const facetas = computeFacets(grupos.map((g) => g.representante));

    if (grupos.length > UMBRAL_AMBIGUEDAD && !marca && !categoria && !subcategoria) {
      res.status(409).json({
        error: 'demasiado_amplio',
        detail: `${grupos.length} coincidencias. Acota con marca o categoria.`,
        total: grupos.length,
        facetas,
      });
      return;
    }

    const hayFiltros = onlyWithStock || Number.isFinite(maxPrice);
    const candidatos = grupos.slice(0, hayFiltros ? MAX_CANDIDATOS_CON_FILTROS : MAX_CANDIDATOS_SIN_FILTROS);

    const skusDe: Record<string, string[]> = {};
    for (const g of candidatos) {
      for (const [proveedor, productos] of Object.entries(g.porProveedor)) {
        (skusDe[proveedor] ??= []).push(...productos.map((p) => p.sku));
      }
    }
    const deadline = Date.now() + PRESUPUESTO_MS;
    const lotes = await Promise.all(
      cargados.map(async ({ provider }) => ({ nombre: provider.name, ...(await cotizarLote(provider, skusDe[provider.name] ?? [], deadline)) })),
    );
    const precios: Record<string, Map<string, PriceInfo>> = Object.fromEntries(lotes.map((l) => [l.nombre, l.precios]));
    const parcial = lotes.some((l) => l.incompleto);
    const maxAgeMs = Math.max(0, ...lotes.map((l) => l.maxAgeMs));

    const evaluados: Cotizado[] = [];
    const productos: Cotizado[] = [];
    for (const g of candidatos) {
      const ganador = elegirGanador(g, precios);
      if (!ganador) continue;
      const cotizado: Cotizado = {
        sku: ganador.sku,
        mpn: ganador.producto.mpn,
        nombre: ganador.producto.nombre,
        marca: ganador.producto.marca,
        categoria: ganador.producto.categoria,
        precio: ganador.precio,
        moneda: ganador.moneda,
        stock: ganador.stock,
        foto: fotoDe(ganador.producto),
        proveedor: ganador.proveedor,
      };
      evaluados.push(cotizado);
      if (cotizado.precio > maxPrice) continue;
      if (onlyWithStock && (cotizado.stock ?? 0) <= 0) continue;
      if (productos.length < limit) productos.push(cotizado);
    }

    // Nada para mostrar y ningun mayorista respondio: el mismo 502 de hoy.
    if (evaluados.length === 0 && candidatos.length > 0 && lotes.filter((l) => (skusDe[l.nombre] ?? []).length > 0).every((l) => l.fallaTotal)) {
      res.status(502).json({ error: 'upstream', detail: 'Ningun mayorista respondio a tiempo' });
      return;
    }

    const devueltos = productos.map((p) => p.precio);
    res.status(200).json({
      total: grupos.length,
      evaluados: evaluados.length,
      ...(parcial ? { parcial: true } : {}),
      productos,
      facetas: devueltos.length > 0 ? { ...facetas, precio: { min: Math.min(...devueltos), max: Math.max(...devueltos) } } : facetas,
      ...(productos.length === 0 && evaluados.length > 0 ? { sin_resultados: explainEmpty(evaluados, onlyWithStock, parcial) } : {}),
      ...(maxAgeMs > 0 ? { precios_de_hace_min: Math.ceil(maxAgeMs / 60000) } : {}),
    });
  };
}
```

`apps/pricing-api/api/search.ts` completo:

```ts
import { createMultiSearchHandler } from '../src/handlers/search-multi.js';
import { PROVIDERS } from '@rr/providers';

// /search compara los tres mayoristas y muestra el mismo ganador que elige la
// cotizacion (/mejor-precio). La busqueda de un solo mayorista sigue en
// /{proveedor}/search.
export default createMultiSearchHandler(PROVIDERS);
```

Documentación: en `docs/api/README.md`, en la sección de `/search`, explicar que busca en los tres mayoristas y devuelve por producto el mejor precio con el criterio de `/mejor-precio`, y documentar el campo `` `proveedor` `` ("mayorista ganador; solo en `/search`"). En `docs/api/openapi.yaml`, agregar `proveedor` (string) al esquema del producto de búsqueda con la misma indentación que `stock`. Correr `npx vitest run tests/docs.test.ts` para confirmar que la documentación sigue sincronizada.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/pricing-api tests/docs.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/pricing-api/src/handlers/search-multi.ts apps/pricing-api/api/search.ts apps/pricing-api/tests/search-multi.test.ts docs/api/README.md docs/api/openapi.yaml
git commit -m "feat(busqueda): /search compara los tres mayoristas y muestra el mismo ganador que la cotizacion"
```

---

### Task 5: Verificación real

**Files:** ninguno nuevo.

- [ ] **Step 1: Suite completa**

Run: `npm test && npm run typecheck`
Expected: todo en verde.

- [ ] **Step 2: API local contra los mayoristas reales**

Levantar la `pricing-api` de la rama en otro puerto (`PORT=3100 npm run serve`) y consultar `GET /search?q=<mpn>` para `BX8071514100F`, `E551755` y `DP2VGAMM6B`. Expected: cada uno devuelve `proveedor: "ingram"` con el precio que dio `/mejor-precio` en el análisis (US$93,49, US$270,20 y US$25,42, o el vigente), no el de Intcomex. Comparar además una búsqueda amplia con filtro (`q=toner&marca=Brother`) y medir el tiempo de respuesta (debe quedar bajo ~20 s).

- [ ] **Step 3: Tienda local**

Levantar la tienda apuntando a la API local (como en la verificación del banco de fotos) y comprobar que el procesador `BX8071514100F` aparece al precio de Ingram y que agregarlo al carro y confirmar ya no dispara el aviso de recotización (sin pagar).

- [ ] **Step 4: Reinicio de la API de oficina tras el merge**

Después del merge a `main`, el servidor de la oficina tiene que reiniciarse (PowerShell de administrador: `Stop-Process` sobre el puerto 3000 y `Start-ScheduledTask -TaskName "CaptadorPrecios-API"`, en ese orden) para que tienda y bot usen la búsqueda nueva.
