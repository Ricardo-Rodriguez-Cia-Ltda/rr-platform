# Caché de precios para la búsqueda — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la búsqueda converse sobre precios cacheados con TTL y solo vaya a Intcomex por lo que falta, sirviendo datos viejos declarados cuando Intcomex se cae — sin tocar jamás la cotización, que sigue 100% en vivo.

**Architecture:** Un módulo `price-cache` en `packages/providers` (memoria + disco, umbrales fresco ≤15 min / utilizable ≤24 h). El handler de `/search` resuelve del caché lo fresco, cotiza en vivo lo restante con el mecanismo actual (sonda + ronda paralela), alimenta el caché con lo que vuelve, y cae al utilizable cuando un lote falla. La respuesta declara `precios_de_hace_min`; `buscar-productos-v2` lo propaga y el prompt del agente sabe qué decir.

**Tech Stack:** TypeScript (NodeNext), vitest 3, node:fs. Sin dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-08-31-cache-de-precios-design.md`

## Global Constraints

- **`/mejor-precio` y toda la cadena de cotización siguen 100% en vivo, sin excepciones.** Conversar sobre caché, comprometerse en vivo.
- La respuesta de `/search` solo **gana** un campo opcional (`precios_de_hace_min`); nada existente cambia de nombre ni de tipo.
- El mecanismo de sonda + ronda paralela y sus umbrales (`PRESUPUESTO_MS = 20000`, lotes de `maxSkusPerBatch`) no cambian.
- Umbrales del caché: **fresco ≤ 15 min** (se usa siempre), **utilizable ≤ 24 h** (solo como fallback de lote caído), más viejo se descarta. `cotizado_en` en el futuro = vencido.
- Un archivo de caché corrupto o ilegible parte con caché vacío; jamás es fatal.
- La suite tiene **729 pruebas**; las existentes siguen verdes. Solo pueden tocarse las de `/search` que afirmen conteos de llamadas a `getPrices`, y únicamente agregando un caché vacío explícito a su setup.
- `npm run typecheck` limpio. Identificadores en inglés; comentarios y documentación en español.
- **Nunca `git add -A` ni `git add .`** — hay directorios sin trackear del usuario en la raíz. Agregar por ruta explícita.
- No desplegar a Kapso ni pedir reinicios hasta la tarea final; el orden de despliegue es API primero, Kapso después.

---

## Estructura de archivos

| Archivo | Papel |
|---|---|
| `packages/providers/src/price-cache.ts` (crear) | El caché: umbrales, memoria, disco atómico, negativos |
| `packages/providers/tests/price-cache.test.ts` (crear) | Sus pruebas |
| `apps/pricing-api/src/handlers/search.ts` (modificar) | Fresco del caché → vivo → utilizable como fallback; `precios_de_hace_min` |
| `apps/pricing-api/tests/search-endpoint.test.ts` (modificar) | Pruebas de la integración + caché vacío en setups con conteo de llamadas |
| `apps/pricing-api/tests/best-price-endpoint.test.ts` (modificar) | La prueba que protege el principio |
| `apps/kapso-agent/functions/buscar-productos-v2.js` (modificar) | Propagar `precios_de_hace_min` |
| `apps/kapso-agent/tests/buscar-productos-v2.test.ts` (modificar) | Su prueba |
| `apps/kapso-agent/prompts/agente-descubrimiento/v-05.md` (crear) | La regla "precios por confirmar" |
| `docs/api/README.md`, `docs/api/openapi.yaml` (modificar) | Documentar el campo nuevo |

---

### Task 1: El módulo `price-cache`

**Files:**
- Create: `packages/providers/src/price-cache.ts`
- Test: `packages/providers/tests/price-cache.test.ts`

**Interfaces:**
- Consumes: `PriceInfo` de `@rr/domain/types` (`{ price: number; currency: string; inStock: number | null }`).
- Produces (las tareas 2 y 3 dependen de estos nombres y tipos exactos):

```ts
export interface CachedPrice {
  info: PriceInfo | null;      // null = el proveedor no devolvio precio (negativo cacheado)
  quotedAt: number;            // epoch ms
}

export interface CacheLookup {
  fresh: Map<string, CachedPrice>;   // edad <= FRESH_MS
  usable: Map<string, CachedPrice>;  // FRESH_MS < edad <= USABLE_MS
}

export const FRESH_MS = 15 * 60 * 1000;
export const USABLE_MS = 24 * 60 * 60 * 1000;

export class PriceCache {
  constructor(proveedor: string);           // el archivo es cache/prices-<proveedor>.json
  get(skus: string[]): CacheLookup;
  put(results: Map<string, PriceInfo>, requested: string[]): void;
  // `requested` permite cachear el negativo: todo SKU pedido que no vino en
  // `results` se guarda con info: null.
}

export function getPriceCache(proveedor: string): PriceCache;  // singleton por proveedor
export function resetPriceCachesForTests(): void;              // limpia singletons y memoria
```

- El directorio sale de `process.env.CATALOG_CACHE_DIR ?? 'cache'`, igual que el caché de catálogo (`packages/providers/src/catalog.ts:22-24`).
- Escritura **atómica**: `writeFileSync` a `<ruta>.tmp` y luego `renameSync` sobre la definitiva. Ojo: esto es distinto del caché de catálogo, que escribe directo — no copiar ese patrón.
- `put` poda al escribir: toda entrada con edad > `USABLE_MS` (o `quotedAt` futuro) se elimina.
- El constructor lee el archivo si existe; si está corrupto o ilegible, parte vacío sin lanzar.

- [ ] **Step 1: Escribir las pruebas (fallan porque el módulo no existe)**

```ts
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { FRESH_MS, PriceCache, USABLE_MS, getPriceCache, resetPriceCachesForTests } from '@rr/providers/price-cache';

const P = { price: 100, currency: 'USD', inStock: 5 };

let dir: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'price-cache-'));
  vi.stubEnv('CATALOG_CACHE_DIR', dir);
  resetPriceCachesForTests();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.useRealTimers();
  rmSync(dir, { recursive: true, force: true });
});

describe('PriceCache: umbrales por edad', () => {
  it('lo recien guardado sale como fresco', () => {
    const cache = new PriceCache('intcomex');
    cache.put(new Map([['A', P]]), ['A']);
    const { fresh, usable } = cache.get(['A']);
    expect(fresh.get('A')?.info).toEqual(P);
    expect(usable.size).toBe(0);
  });

  it('pasados 15 minutos deja de ser fresco pero sigue utilizable', () => {
    vi.useFakeTimers();
    const cache = new PriceCache('intcomex');
    cache.put(new Map([['A', P]]), ['A']);
    vi.advanceTimersByTime(FRESH_MS + 1000);
    const { fresh, usable } = cache.get(['A']);
    expect(fresh.size).toBe(0);
    expect(usable.get('A')?.info).toEqual(P);
  });

  it('pasadas 24 horas se descarta', () => {
    vi.useFakeTimers();
    const cache = new PriceCache('intcomex');
    cache.put(new Map([['A', P]]), ['A']);
    vi.advanceTimersByTime(USABLE_MS + 1000);
    const { fresh, usable } = cache.get(['A']);
    expect(fresh.size).toBe(0);
    expect(usable.size).toBe(0);
  });

  it('una entrada con quotedAt en el futuro se trata como vencida', () => {
    const cache = new PriceCache('intcomex');
    // Se escribe a mano un archivo con fecha futura y se lee con otra instancia.
    cache.put(new Map([['A', P]]), ['A']);
    const raw = JSON.parse(readFileSync(join(dir, 'prices-intcomex.json'), 'utf8'));
    raw.entries.A.quotedAt = Date.now() + 60 * 60 * 1000;
    writeFileSync(join(dir, 'prices-intcomex.json'), JSON.stringify(raw));
    const releida = new PriceCache('intcomex');
    const { fresh, usable } = releida.get(['A']);
    expect(fresh.size + usable.size).toBe(0);
  });
});

describe('PriceCache: negativos', () => {
  it('un SKU pedido que no vino en los resultados se cachea con info null', () => {
    const cache = new PriceCache('intcomex');
    cache.put(new Map([['A', P]]), ['A', 'MUERTO']);
    const { fresh } = cache.get(['MUERTO']);
    expect(fresh.get('MUERTO')?.info).toBeNull();
  });
});

describe('PriceCache: disco', () => {
  it('sobrevive un reinicio: otra instancia lee lo persistido', () => {
    const cache = new PriceCache('intcomex');
    cache.put(new Map([['A', P]]), ['A']);
    const releida = new PriceCache('intcomex');
    expect(releida.get(['A']).fresh.get('A')?.info).toEqual(P);
  });

  it('un archivo corrupto parte con cache vacio, sin lanzar', () => {
    writeFileSync(join(dir, 'prices-intcomex.json'), '{esto no es json');
    const cache = new PriceCache('intcomex');
    expect(cache.get(['A']).fresh.size).toBe(0);
  });

  it('escribe via temporal + rename: no queda archivo .tmp tras un put', () => {
    const cache = new PriceCache('intcomex');
    cache.put(new Map([['A', P]]), ['A']);
    expect(() => readFileSync(join(dir, 'prices-intcomex.json.tmp'))).toThrow();
  });
});

describe('getPriceCache', () => {
  it('devuelve el mismo singleton por proveedor', () => {
    expect(getPriceCache('intcomex')).toBe(getPriceCache('intcomex'));
    expect(getPriceCache('intcomex')).not.toBe(getPriceCache('ingram'));
  });
});
```

- [ ] **Step 2: Correr y ver que fallan**

Run: `npx vitest run packages/providers/tests/price-cache.test.ts`
Expected: FAIL — el módulo no existe.

- [ ] **Step 3: Implementar `price-cache.ts`**

```ts
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PriceInfo } from '@rr/domain/types';

// La busqueda conversa sobre estos precios; la cotizacion jamas los toca (ver
// docs/superpowers/specs/2026-08-31-cache-de-precios-design.md). Fresco se usa
// siempre; utilizable solo cuando el lote en vivo fallo.
export const FRESH_MS = 15 * 60 * 1000;
export const USABLE_MS = 24 * 60 * 60 * 1000;

export interface CachedPrice {
  info: PriceInfo | null; // null = el proveedor no devolvio precio para este SKU
  quotedAt: number;
}

export interface CacheLookup {
  fresh: Map<string, CachedPrice>;
  usable: Map<string, CachedPrice>;
}

interface DiskShape {
  entries: Record<string, CachedPrice>;
}

function cacheDir(): string {
  return process.env.CATALOG_CACHE_DIR ?? 'cache';
}

export class PriceCache {
  private entries = new Map<string, CachedPrice>();
  private readonly path: string;

  constructor(private readonly proveedor: string) {
    this.path = join(cacheDir(), `prices-${proveedor}.json`);
    try {
      const raw = JSON.parse(readFileSync(this.path, 'utf8')) as DiskShape;
      for (const [sku, entry] of Object.entries(raw.entries ?? {})) {
        if (typeof entry?.quotedAt === 'number') this.entries.set(sku, entry);
      }
    } catch {
      // Corrupto, ilegible o inexistente: se parte vacio. Jamas es fatal.
    }
  }

  private age(entry: CachedPrice): number {
    const age = Date.now() - entry.quotedAt;
    // Una fecha futura no es "muy fresca": es un reloj mentiroso. Vencida.
    return age >= 0 ? age : Number.POSITIVE_INFINITY;
  }

  get(skus: string[]): CacheLookup {
    const fresh = new Map<string, CachedPrice>();
    const usable = new Map<string, CachedPrice>();
    for (const sku of skus) {
      const entry = this.entries.get(sku);
      if (!entry) continue;
      const age = this.age(entry);
      if (age <= FRESH_MS) fresh.set(sku, entry);
      else if (age <= USABLE_MS) usable.set(sku, entry);
    }
    return { fresh, usable };
  }

  put(results: Map<string, PriceInfo>, requested: string[]): void {
    const quotedAt = Date.now();
    for (const sku of requested) {
      this.entries.set(sku, { info: results.get(sku) ?? null, quotedAt });
    }
    // Poda al escribir: lo vencido no merece disco.
    for (const [sku, entry] of this.entries) {
      if (this.age(entry) > USABLE_MS) this.entries.delete(sku);
    }
    this.persist();
  }

  private persist(): void {
    try {
      mkdirSync(cacheDir(), { recursive: true });
      const shape: DiskShape = { entries: Object.fromEntries(this.entries) };
      // Temporal + rename: dos procesos escribiendo a la vez pierden una
      // escritura como maximo, nunca dejan un archivo a medias. Ojo: el cache
      // de catalogo escribe directo; ese patron NO se copia aca.
      writeFileSync(`${this.path}.tmp`, JSON.stringify(shape));
      renameSync(`${this.path}.tmp`, this.path);
    } catch (error) {
      // Un disco que falla degrada a cache solo-memoria; no tumba la busqueda.
      console.error(`[price-cache] ${this.proveedor}: no se pudo persistir`, error);
    }
  }
}

const singletons = new Map<string, PriceCache>();

export function getPriceCache(proveedor: string): PriceCache {
  let cache = singletons.get(proveedor);
  if (!cache) {
    cache = new PriceCache(proveedor);
    singletons.set(proveedor, cache);
  }
  return cache;
}

export function resetPriceCachesForTests(): void {
  singletons.clear();
}
```

- [ ] **Step 4: Correr las pruebas del módulo**

Run: `npx vitest run packages/providers/tests/price-cache.test.ts`
Expected: PASS (9 pruebas).

- [ ] **Step 5: Typecheck y suite completa**

Run: `npm run typecheck && npm test`
Expected: limpio; 729 existentes + 9 nuevas = 738 verdes.

- [ ] **Step 6: Commit**

```bash
git add packages/providers/src/price-cache.ts packages/providers/tests/price-cache.test.ts
git commit -m "feat(providers): cache de precios con umbrales fresco/utilizable"
```

---

### Task 2: `/search` conversa sobre el caché

**Files:**
- Modify: `apps/pricing-api/src/handlers/search.ts`
- Test: `apps/pricing-api/tests/search-endpoint.test.ts`

**Interfaces:**
- Consumes: `getPriceCache`, `resetPriceCachesForTests`, `FRESH_MS`, `CachedPrice` de `@rr/providers/price-cache` (Task 1).
- Produces: el campo de respuesta `precios_de_hace_min?: number` que la Task 3 propaga.

Contexto del handler actual (`search.ts`): tras armar `candidates`, un closure `procesar(batch, prices)` empuja a `evaluados`/`productos`; luego la **sonda** (primer lote, secuencial, con try/catch que responde 502) y la **ronda paralela** (`Promise.allSettled` sobre los lotes restantes, un lote rechazado marca `truncadoPorTiempo = true`). La respuesta final arma `parcial` y `sin_resultados`.

Los cambios, en orden del flujo:

1. **Antes de la sonda**: `const cache = getPriceCache(provider.name); const { fresh, usable } = cache.get(candidates.map((p) => p.sku));`. Los candidatos con entrada en `fresh` se procesan de inmediato (los de `info: null` solo cuentan como evaluados-negativos: no van a `evaluados` porque nunca tuvieron precio — basta con excluirlos de la cotización en vivo). Los candidatos restantes (`pendientes`) son los que entran a sonda + ronda.
2. **Cada lote vivo que vuelve bien**: `cache.put(prices, batch.map((p) => p.sku))` — aciertos y negativos.
3. **Cada lote vivo que falla** (sonda incluida — ver punto 5): sus candidatos se buscan en `usable`; los que están se procesan desde ahí, los que no quedan sin cotizar → `truncadoPorTiempo = true` solo si quedó alguno sin resolver.
4. **Edad**: se lleva `let maxAgeMs = 0`, actualizado con la edad de **cada** entrada de caché usada (fresca o utilizable). Si `maxAgeMs > 0`, la respuesta incluye `precios_de_hace_min: Math.ceil(maxAgeMs / 60000)`.
5. **La sonda deja de responder 502 al primer fallo**: su catch ahora intenta el fallback a `usable` igual que la ronda. El 502 sobrevive solo para el caso "falló la sonda Y ningún candidato del lote tenía utilizable Y no había nada fresco" — es decir, cuando el caché no aportó absolutamente nada; ahí la respuesta honesta sigue siendo el error upstream de siempre.

- [ ] **Step 1: Agregar `resetPriceCachesForTests` + caché vacío al setup existente**

En `search-endpoint.test.ts`, todo `describe` que afirme conteos de `getPricesMock` necesita partir con caché vacío y aislado. En el/los `beforeEach` de esos bloques (los de "paginado con filtros", "sonda + ronda paralela" y "alternativa"):

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resetPriceCachesForTests } from '@rr/providers/price-cache';
// dentro del beforeEach, antes de los mocks:
vi.stubEnv('CATALOG_CACHE_DIR', mkdtempSync(join(tmpdir(), 'search-cache-')));
resetPriceCachesForTests();
```

(El `vi.unstubAllEnvs()` de los `afterEach` existentes ya limpia el env.)

- [ ] **Step 2: Escribir las pruebas nuevas de la integración (fallan)**

Al final de `search-endpoint.test.ts`:

```ts
// El principio del diseño: conversar sobre cache, comprometerse en vivo. Estas
// pruebas cubren la mitad "conversar"; la de best-price cubre la otra.
describe('GET /search — cache de precios', () => {
  const CATALOGO = Array.from({ length: 150 }, (_, i) =>
    makeProduct(`S${i}`, `Notebook generico ${i}`, 'HP', 'Computadores'),
  );

  beforeEach(() => {
    vi.stubEnv('API_SECRET_KEY', 'test-secret');
    vi.stubEnv('CATALOG_CACHE_DIR', mkdtempSync(join(tmpdir(), 'search-cache-')));
    resetPriceCachesForTests();
    getCatalogMock.mockReset().mockReturnValue(CATALOGO);
    getPricesMock.mockReset().mockImplementation((skus: string[]) =>
      Promise.resolve(new Map(skus.map((sku) => [sku, { price: 100, currency: 'us', inStock: 5 }]))),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('la segunda busqueda identica no llama a Intcomex', async () => {
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', limite: '3' }, AUTH), makeRes());
    const llamadasPrimera = getPricesMock.mock.calls.length;
    expect(llamadasPrimera).toBeGreaterThan(0);

    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', limite: '3' }, AUTH), res);
    expect(getPricesMock.mock.calls.length).toBe(llamadasPrimera); // ni una mas
    expect(res.body.productos).toHaveLength(3);
    // Uso datos de cache: la edad se declara aunque sean frescos.
    expect(res.body.precios_de_hace_min).toBeGreaterThanOrEqual(1);
  });

  it('solo cotiza en vivo los candidatos sin cache fresco', async () => {
    // Primera pasada con limite 3 y stock disponible: la sonda (100 SKUs)
    // basta, asi que SOLO esos 100 quedan cacheados — los otros 50 no.
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', limite: '3' }, AUTH), makeRes());
    expect(getPricesMock).toHaveBeenCalledTimes(1);
    getPricesMock.mockClear();
    // Segunda pasada pidiendo mas de lo que el cache cubre: 100 frescos se
    // resuelven del cache y SOLO los 50 restantes van en vivo.
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', limite: '200' }, AUTH), makeRes());
    const skusPedidos = getPricesMock.mock.calls.flatMap((c: any) => c[0] as string[]);
    expect(skusPedidos.length).toBe(50);
    expect(skusPedidos.every((sku: string) => Number(sku.slice(1)) >= 100)).toBe(true);
  });

  it('un lote caido se sirve del cache utilizable, declarando la edad', async () => {
    vi.useFakeTimers();
    // Puebla el cache...
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', limite: '3' }, AUTH), makeRes());
    // ...lo envejece mas alla de fresco (20 min) y tumba a Intcomex.
    vi.advanceTimersByTime(20 * 60 * 1000);
    getPricesMock.mockReset().mockRejectedValue(new Error('ECONNRESET'));

    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', limite: '3' }, AUTH), res);
    vi.useRealTimers();

    expect(res.statusCode).toBe(200);
    expect(res.body.productos).toHaveLength(3);
    expect(res.body.precios_de_hace_min).toBeGreaterThanOrEqual(20);
    expect(res.body.parcial).toBeUndefined(); // todo se resolvio, nada quedo sin cotizar
  });

  it('lote caido sin cache: parcial, como hoy', async () => {
    getPricesMock.mockReset().mockRejectedValue(new Error('ECONNRESET'));
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', limite: '3' }, AUTH), res);
    // Sin nada fresco ni utilizable y con la sonda caida, el upstream 502 de
    // siempre sigue siendo la respuesta honesta.
    expect(res.statusCode).toBe(502);
  });

  it('busqueda 100% en vivo no declara edad', async () => {
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', limite: '3' }, AUTH), res);
    expect(res.body.precios_de_hace_min).toBeUndefined();
  });
});
```

- [ ] **Step 3: Correr y ver que fallan**

Run: `npx vitest run apps/pricing-api/tests/search-endpoint.test.ts`
Expected: FAIL las cinco nuevas (el campo y el caché no existen).

- [ ] **Step 4: Implementar la integración en `search.ts`**

Aplicar los cinco cambios descritos en **Interfaces** (arriba). Guía concreta:

```ts
import { getPriceCache, FRESH_MS, type CachedPrice } from '@rr/providers/price-cache';

// tras armar `candidates`:
const cache = getPriceCache(provider.name);
const lookup = cache.get(candidates.map((p) => p.sku));
let maxAgeMs = 0;

const desdeCache = (p: NormalizedProduct, entry: CachedPrice): void => {
  maxAgeMs = Math.max(maxAgeMs, Date.now() - entry.quotedAt);
  if (entry.info) procesar([p], new Map([[p.sku, entry.info]]));
  // info null = negativo cacheado: ni evaluado ni cotizable, igual que un SKU
  // que la API viva no devuelve.
};

const pendientes: NormalizedProduct[] = [];
for (const p of candidates) {
  const entry = lookup.fresh.get(p.sku);
  if (entry) desdeCache(p, entry);
  else pendientes.push(p);
}
// La sonda y la ronda iteran sobre `pendientes` en vez de `candidates`.
// Fallback de lote caido (sonda y ronda comparten esto):
const rescatar = (batch: NormalizedProduct[]): void => {
  let sinResolver = 0;
  for (const p of batch) {
    const entry = lookup.usable.get(p.sku);
    if (entry) desdeCache(p, entry);
    else sinResolver++;
  }
  if (sinResolver > 0) truncadoPorTiempo = true;
};
// Lote vivo exitoso, ademas de procesar:
cache.put(prices, batch.map((p) => p.sku));
// En la respuesta final:
...(maxAgeMs > 0 ? { precios_de_hace_min: Math.ceil(maxAgeMs / 60000) } : {}),
```

En la **sonda**, el catch deja de responder 502 de inmediato: llama a `rescatar(first)` y responde 502 solo si tras el rescate `evaluados.length === 0 && productos.length === 0` (el caché no aportó nada). En la **ronda**, el `else` del lote rechazado pasa de marcar `truncadoPorTiempo = true` directo a llamar `rescatar(restantes[i])`.

Nota de orden: `productos` debe conservar el orden del ranking. Procesar primero todos los frescos en orden de `candidates` y después los vivos mantiene un orden estable; es aceptable que un candidato fresco de ranking bajo entre antes que uno vivo de ranking alto **dentro de la misma respuesta parcial**, pero si la prueba de orden existente (`productos` del primer lote) se rompe, la solución es procesar los frescos intercalados: recorrer `candidates` en orden y para los pendientes tomar el resultado vivo ya recolectado — no reordenar al final por score, que el handler no conserva.

- [ ] **Step 5: Correr todo el archivo de search**

Run: `npx vitest run apps/pricing-api/tests/search-endpoint.test.ts`
Expected: PASS — las 5 nuevas y las 43 existentes (con sus setups ya aislados por el Step 1).

- [ ] **Step 6: Typecheck y suite completa**

Run: `npm run typecheck && npm test`
Expected: limpio; 743 verdes.

- [ ] **Step 7: Commit**

```bash
git add apps/pricing-api/src/handlers/search.ts apps/pricing-api/tests/search-endpoint.test.ts
git commit -m "feat(search): conversar sobre el cache de precios, con edad declarada"
```

---

### Task 3: La prueba que protege el principio, y el campo hasta el agente

**Files:**
- Test: `apps/pricing-api/tests/best-price-endpoint.test.ts`
- Modify: `apps/kapso-agent/functions/buscar-productos-v2.js`
- Test: `apps/kapso-agent/tests/buscar-productos-v2.test.ts`
- Create: `apps/kapso-agent/prompts/agente-descubrimiento/v-05.md`
- Modify: `apps/kapso-agent/prompts/agente-descubrimiento/v-04.md` (solo `| **Estado** | vigente |` → `| **Estado** | reemplazado |`)
- Modify: `docs/api/README.md`, `docs/api/openapi.yaml`

**Interfaces:**
- Consumes: `precios_de_hace_min` de la Task 2; `getPriceCache` de la Task 1.
- Produces: nada que consuman tareas posteriores.

- [ ] **Step 1: La prueba de que `/mejor-precio` no toca el caché (falla si alguien lo conecta)**

En `best-price-endpoint.test.ts`. Contexto del archivo: mockea `@rr/providers/comparator` con `compareMock` (resuelve `COMPARISON`, cuyo `mejor.precio` es `100` para el SKU `IM1`), y ya define `makeReq`, `makeRes`, `AUTH` y un `beforeEach` que resetea los mocks. Agregar al final:

```ts
import { getPriceCache, resetPriceCachesForTests } from '@rr/providers/price-cache';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// El principio del diseño (spec 2026-08-31): la cotizacion se compromete en
// vivo, SIEMPRE. Esta prueba existe para que conectar el cache aqui sea un
// acto deliberado que rompa la suite, no un descuido.
describe('GET /mejor-precio ignora el cache de precios', () => {
  it('con el cache lleno igual cotiza en vivo', async () => {
    vi.stubEnv('CATALOG_CACHE_DIR', mkdtempSync(join(tmpdir(), 'bp-cache-')));
    resetPriceCachesForTests();
    // Cache lleno con un precio deliberadamente distinto al del mock vivo.
    getPriceCache('ingram').put(new Map([['IM1', { price: 1, currency: 'USD', inStock: 99 }]]), ['IM1']);
    getPriceCache('intcomex').put(new Map([['IM1', { price: 1, currency: 'USD', inStock: 99 }]]), ['IM1']);

    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1', marca: 'HP' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    // La comparacion EN VIVO fue llamada, y su precio (100) es el que responde
    // — no el 1 del cache.
    expect(compareMock).toHaveBeenCalled();
    expect(res.body.mejor.precio).toBe(100);
  });
});
```

(Los imports de `node:fs`/`node:os`/`node:path` van arriba del archivo junto a los existentes, no dentro del describe.)

- [ ] **Step 2: Propagar el campo en `buscar-productos-v2.js`**

En la respuesta `ok` (y también en la rama de lista vacía), junto a `...(rango ? ... : {})`:

```js
...(Number.isFinite(Number(datos.precios_de_hace_min)) && Number(datos.precios_de_hace_min) > 0
  ? { precios_de_hace_min: Number(datos.precios_de_hace_min) }
  : {}),
```

- [ ] **Step 3: Su prueba en `buscar-productos-v2.test.ts`**

```ts
describe('buscar-productos-v2: edad de los precios', () => {
  it('propaga precios_de_hace_min cuando la API lo declara', async () => {
    respondWith({ total: 2, productos: [/* copiar un producto valido del fixture search-intcomex.json */], precios_de_hace_min: 40 });
    const res = await handler(request({ input: { q: 'cinta' } }), env);
    const data = (await res.json()) as any;
    expect(data.precios_de_hace_min).toBe(40);
  });

  it('no inventa el campo cuando la API no lo trae', async () => {
    respondWith(search);
    const res = await handler(request({ input: { q: 'cinta epson' } }), env);
    const data = (await res.json()) as any;
    expect(data.precios_de_hace_min).toBeUndefined();
  });
});
```

- [ ] **Step 4: El prompt v-05**

Copiar `v-04.md` a `v-05.md`, marcar v-04 `reemplazado`, y en v-05: fecha `2026-08-31`, sección `## Qué cambió` que diga que se agregó la regla de precios por confirmar (el caché de precios existe y a veces la búsqueda responde con datos de hace un rato), y en la sección `## Precios: todo en pesos chilenos` agregar:

```markdown
- Si la respuesta trae `precios_de_hace_min` mayor a 60, agrega al mostrar los
  productos una línea simple: "precios por confirmar en la cotización". Sin
  drama, sin mencionar sistemas ni caídas: la cotización siempre trae el precio
  firme. Si es 60 o menos, no digas nada.
```

- [ ] **Step 5: Documentar el campo**

En `docs/api/README.md`, junto a la sección `### parcial`, una subsección breve `### precios_de_hace_min`: presente solo cuando la respuesta usó precios cacheados; es la edad en minutos del dato más viejo usado; la cotización (`/mejor-precio`) nunca usa caché. En `docs/api/openapi.yaml`, agregar la propiedad al schema de la respuesta de `/search`:

```yaml
        precios_de_hace_min:
          type: integer
          description: |
            Presente solo si la respuesta usó precios cacheados: edad en
            minutos del dato más viejo que participó. La cotización
            (/mejor-precio) nunca usa caché; esto aplica solo a la búsqueda.
```

(Ojo: `tests/docs.test.ts` valida documentación contra código; correr la suite dirá si el campo necesita mención en algún otro punto.)

- [ ] **Step 6: Suite completa y typecheck**

Run: `npm run typecheck && npm test`
Expected: limpio; 743 + las nuevas de esta tarea, todas verdes.

- [ ] **Step 7: Commit**

```bash
git add apps/pricing-api/tests/best-price-endpoint.test.ts apps/kapso-agent/functions/buscar-productos-v2.js apps/kapso-agent/tests/buscar-productos-v2.test.ts apps/kapso-agent/prompts/agente-descubrimiento/v-04.md apps/kapso-agent/prompts/agente-descubrimiento/v-05.md docs/api/README.md docs/api/openapi.yaml
git commit -m "feat(kapso): declarar la edad de los precios, y blindar mejor-precio contra el cache"
```

---

### Task 4: Verificación de punta a punta y despliegue

**Files:** ninguno nuevo — esta tarea ejecuta la sección "Verificación de punta a punta" del spec.

**Interfaces:**
- Consumes: todo lo anterior, ya commiteado.

**Orden obligatorio: API primero, Kapso después** (la function propaga un campo que la API vieja no emite — al revés no rompe, pero verifica menos).

- [ ] **Step 1: Verificar en un servidor local de prueba**

```bash
PORT=3210 npm run serve   # en background; usar otro puerto si esta ocupado
```

Contra `http://127.0.0.1:3210/api`, con `x-api-key` de `.env.local`:

1. La misma búsqueda dos veces (`q=notebook&marca=Lenovo&categoria=Computadores&solo_con_stock=true&precio_max=931`): la primera tarda lo normal; la segunda debe responder **< 1 s** y con `precios_de_hace_min` presente.
2. `/mejor-precio?mpn=<mpn de un resultado>&marca=<su marca>`: responde con forma de siempre (va en vivo; el caché no participa).
3. Detener el servidor de prueba al terminar.

- [ ] **Step 2: Pedir el reinicio de la API de oficina**

El controlador (no el subagente) le pide al usuario el reinicio de siempre:

```powershell
Stop-Process -Id (Get-NetTCPConnection -LocalPort 3000 -State Listen | Select-Object -First 1 -ExpandProperty OwningProcess) -Force
Start-ScheduledTask -TaskName "CaptadorPrecios-API"
```

- [ ] **Step 3: Con la API reiniciada, desplegar Kapso**

```bash
npm run kapso:functions
npm run kapso:workflow
```

- [ ] **Step 4: Verificar la cadena completa**

Invocar `isia-v2-buscar-productos` vía la Platform API dos veces con el mismo input; la segunda debe volver en ~1-2 s. Confirmar que `/mejor-precio` por el túnel sigue vivo. Reportar tiempos.

---

## Verificación final

```bash
npm test            # 729 existentes + todas las nuevas, verdes
npm run typecheck
grep -n "price-cache" apps/pricing-api/src/handlers/best-price.ts   # sin salida: la cotizacion no lo importa
```

Y contra producción: búsqueda repetida < 1 s con edad declarada; `/mejor-precio` en vivo.
