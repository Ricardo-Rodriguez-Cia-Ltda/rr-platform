# Banco de fotos de producto — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Juntar automáticamente una foto por producto desde Intcomex e Icecat, guardarla en Supabase Storage y mostrarla en la tienda, con una lista priorizada de lo que falte.

**Architecture:** Un recolector en `packages/providers/src/fotos/` (fuentes, storage, índice y orquestador, un archivo por responsabilidad) corre en la oficina junto a la `pricing-api`: a mano con `npm run fotos` y solo después de cada refresco diario de catálogos. Escribe `cache/fotos.json`; la `pricing-api` lo lee y agrega `foto` a cada producto; la tienda la muestra y cae a la ficha de texto cuando no hay.

**Tech Stack:** TypeScript (ESM, Node ≥20), vitest, `fetch` nativo contra las APIs REST de Supabase Storage e Icecat (sin SDK, como el resto del repo), Next.js 15 en la tienda.

**Spec:** `docs/superpowers/specs/2026-09-23-banco-fotos-design.md`

## Global Constraints

- Clave de un producto: `unionKey` de `packages/domain/src/product.ts` (`{mpn compactado}|{marca canónica}`). Sin clave, el producto queda fuera del banco.
- Una sola foto por producto (la principal).
- Bucket de Supabase: `fotos-productos`, público de lectura. Ruta: `{marca}/{mpn}.{ext}`, con las dos partes de la clave.
- Icecat: `https://live.icecat.biz/api?UserName=…&Language=es&Brand=…&ProductCode=…`; se usa `data.Image.Pic500x500` y, si falta, `data.Image.HighPic`. Solo activo si `ICECAT_USER` está definido. Concurrencia 4.
- Imagen válida: `content-type` `image/jpeg`, `image/png` o `image/webp`, y entre 2 KB y 5 MB.
- Lo marcado sin foto se reintenta recién a los 30 días. Motivos: `no_encontrado`, `icecat_full`, `descarga_fallida`.
- El índice se guarda cada 200 productos procesados y al final, con escritura atómica (temporal + rename).
- Directorio de cache: `process.env.CATALOG_CACHE_DIR ?? 'cache'` (mismo criterio que `catalog.ts` y `price-cache.ts`).
- Una foto ya obtenida nunca se vuelve a tocar en esta fase.
- Comentarios y mensajes en español, sin tildes en el código (convención del repo); tests con vitest en la carpeta `tests/` de cada paquete.
- Los commits terminan con:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0181D9EDBLHn8Srbz98ydxeb
  ```

## Mapa de archivos

| Archivo | Responsabilidad |
|---|---|
| `packages/providers/src/fotos/indice.ts` (nuevo) | Tipos del índice, leer/guardar `cache/fotos.json`, `fotoDe(producto)` con recarga por mtime |
| `packages/providers/src/fotos/intcomex.ts` (nuevo) | Catálogo extendido de Intcomex → mapa clave → URL |
| `packages/providers/src/fotos/icecat.ts` (nuevo) | Consulta a Icecat por marca + MPN |
| `packages/providers/src/fotos/storage.ts` (nuevo) | Bucket y subida a Supabase Storage |
| `packages/providers/src/fotos/banco.ts` (nuevo) | Orquestador, validación de imagen, armado de productos y CSV de faltantes |
| `packages/providers/src/fotos/correr.ts` (nuevo) | Cablea las dependencias reales y el candado de una corrida a la vez |
| `apps/pricing-api/scripts/banco-fotos.ts` (nuevo) | Entrada manual `npm run fotos` |
| `apps/pricing-api/server.ts` | Dispara el banco tras cada refresco |
| `apps/pricing-api/src/handlers/search.ts`, `product.ts` | Agregan `foto` |
| `apps/tienda/src/lib/catalogo.ts`, `app/componentes/TarjetaProducto.tsx`, `app/globals.css`, `src/lib/ficha.ts` | Muestran la foto |
| `package.json` (raíz), `apps/pricing-api/package.json` | Script `fotos` |

---

### Task 1: Índice de fotos

**Files:**
- Create: `packages/providers/src/fotos/indice.ts`
- Test: `packages/providers/tests/fotos-indice.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type FuenteFoto = 'intcomex' | 'icecat';
  export type MotivoSinFoto = 'no_encontrado' | 'icecat_full' | 'descarga_fallida';
  export interface EntradaFoto { url: string; fuente: FuenteFoto; obtenidaEn: string }
  export interface EntradaSinFoto { motivo: MotivoSinFoto; intentadoEn: string }
  export interface IndiceFotos { actualizadoEn: string; fotos: Record<string, EntradaFoto>; sinFoto: Record<string, EntradaSinFoto> }
  export function rutaIndice(): string;                     // join(cacheDir, 'fotos.json')
  export function indiceVacio(): IndiceFotos;
  export function leerIndice(ruta?: string): IndiceFotos;   // ausente o corrupto -> vacio
  export function guardarIndice(indice: IndiceFotos, ruta?: string): void; // atomico
  export function fotoDe(producto: NormalizedProduct): string | null;
  export function _resetFotosForTests(): void;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/providers/tests/fotos-indice.test.ts
import { mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { NormalizedProduct } from '@rr/domain/product';
import {
  _resetFotosForTests, fotoDe, guardarIndice, indiceVacio, leerIndice, rutaIndice,
} from '../src/fotos/indice.js';

function producto(mpn: string | null, marca: string | null): NormalizedProduct {
  return { sku: 'S1', mpn, nombre: 'x', marca, categoria: null, subcategorias: [], tipo: null };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'fotos-'));
  vi.stubEnv('CATALOG_CACHE_DIR', dir);
  _resetFotosForTests();
});
afterEach(() => { vi.unstubAllEnvs(); vi.useRealTimers(); });

describe('leerIndice / guardarIndice', () => {
  it('un indice ausente o corrupto se lee vacio', () => {
    expect(leerIndice()).toEqual(indiceVacio());
    writeFileSync(rutaIndice(), '{no es json');
    expect(leerIndice()).toEqual(indiceVacio());
  });

  it('guarda y relee lo mismo, sin dejar temporales', () => {
    const indice = indiceVacio();
    indice.fotos['ce310a|hp'] = { url: 'https://x/hp/ce310a.jpg', fuente: 'intcomex', obtenidaEn: '2026-09-24T00:00:00.000Z' };
    guardarIndice(indice);
    expect(leerIndice().fotos['ce310a|hp'].url).toBe('https://x/hp/ce310a.jpg');
    expect(JSON.parse(readFileSync(rutaIndice(), 'utf8')).fotos).toHaveProperty('ce310a|hp');
  });
});

describe('fotoDe', () => {
  it('resuelve por unionKey, aunque el MPN venga escrito distinto', () => {
    const indice = indiceVacio();
    indice.fotos['2n6g5ltabm|hp'] = { url: 'https://x/hp/2n6g5ltabm.jpg', fuente: 'icecat', obtenidaEn: 'x' };
    guardarIndice(indice);
    expect(fotoDe(producto('2N6G5LT#ABM', 'HP Inc.'))).toBe('https://x/hp/2n6g5ltabm.jpg');
    expect(fotoDe(producto('OTRO', 'HP'))).toBeNull();
    expect(fotoDe(producto(null, 'HP'))).toBeNull();
  });

  it('sin indice devuelve null sin lanzar', () => {
    expect(fotoDe(producto('CE310A', 'HP'))).toBeNull();
  });

  it('recarga cuando el archivo cambia, como mucho una vez por minuto', () => {
    vi.useFakeTimers({ now: new Date('2026-09-24T12:00:00Z'), toFake: ['Date'] });
    guardarIndice(indiceVacio());
    expect(fotoDe(producto('CE310A', 'HP'))).toBeNull();

    const indice = indiceVacio();
    indice.fotos['ce310a|hp'] = { url: 'https://x/nueva.jpg', fuente: 'intcomex', obtenidaEn: 'x' };
    guardarIndice(indice);
    const futuro = new Date('2026-09-24T12:05:00Z');
    utimesSync(rutaIndice(), futuro, futuro);

    // Dentro del minuto: sigue con lo cargado.
    expect(fotoDe(producto('CE310A', 'HP'))).toBeNull();
    vi.setSystemTime(new Date('2026-09-24T12:01:01Z'));
    expect(fotoDe(producto('CE310A', 'HP'))).toBe('https://x/nueva.jpg');
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/providers/tests/fotos-indice.test.ts`
Expected: FAIL — `Failed to resolve import "../src/fotos/indice.js"`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/providers/src/fotos/indice.ts
import { mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { unionKey, type NormalizedProduct } from '@rr/domain/product';

// El indice del banco de fotos: que clave tiene foto, de donde salio, y que
// claves se intentaron sin exito (y por que). Ver
// docs/superpowers/specs/2026-09-23-banco-fotos-design.md.

export type FuenteFoto = 'intcomex' | 'icecat';
export type MotivoSinFoto = 'no_encontrado' | 'icecat_full' | 'descarga_fallida';

export interface EntradaFoto { url: string; fuente: FuenteFoto; obtenidaEn: string }
export interface EntradaSinFoto { motivo: MotivoSinFoto; intentadoEn: string }
export interface IndiceFotos {
  actualizadoEn: string;
  fotos: Record<string, EntradaFoto>;
  sinFoto: Record<string, EntradaSinFoto>;
}

function cacheDir(): string {
  return process.env.CATALOG_CACHE_DIR ?? 'cache';
}

export function rutaIndice(): string {
  return join(cacheDir(), 'fotos.json');
}

export function indiceVacio(): IndiceFotos {
  return { actualizadoEn: new Date(0).toISOString(), fotos: {}, sinFoto: {} };
}

export function leerIndice(ruta: string = rutaIndice()): IndiceFotos {
  try {
    const raw = JSON.parse(readFileSync(ruta, 'utf8')) as Partial<IndiceFotos>;
    return {
      actualizadoEn: typeof raw.actualizadoEn === 'string' ? raw.actualizadoEn : indiceVacio().actualizadoEn,
      fotos: raw.fotos && typeof raw.fotos === 'object' ? raw.fotos : {},
      sinFoto: raw.sinFoto && typeof raw.sinFoto === 'object' ? raw.sinFoto : {},
    };
  } catch (error) {
    // Ausente o corrupto: se parte vacio. Jamas es fatal, pero corrupto se
    // registra: significa que la tienda quedo sin fotos hasta la proxima corrida.
    if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') {
      console.error(`[fotos] indice ilegible en ${ruta}; se usa vacio`, error);
    }
    return indiceVacio();
  }
}

export function guardarIndice(indice: IndiceFotos, ruta: string = rutaIndice()): void {
  mkdirSync(dirname(ruta), { recursive: true });
  // Temporal por pid + rename, como price-cache.ts: el servidor lee este
  // archivo mientras el recolector lo escribe, y jamas debe ver uno a medias.
  const tmp = `${ruta}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify({ ...indice, actualizadoEn: new Date().toISOString() }));
  renameSync(tmp, ruta);
}

// Lectura para la API: el indice cambia a lo sumo una vez por corrida, asi
// que basta revisar la fecha del archivo una vez por minuto.
const REVISION_MS = 60 * 1000;
let cargado: { mtimeMs: number; fotos: Record<string, EntradaFoto> } | null = null;
let revisadoEn = 0;

function fotosVigentes(): Record<string, EntradaFoto> {
  const ahora = Date.now();
  if (cargado && ahora - revisadoEn < REVISION_MS) return cargado.fotos;
  revisadoEn = ahora;
  try {
    const mtimeMs = statSync(rutaIndice()).mtimeMs;
    if (!cargado || cargado.mtimeMs !== mtimeMs) {
      cargado = { mtimeMs, fotos: leerIndice().fotos };
    }
  } catch {
    cargado = { mtimeMs: -1, fotos: {} };
  }
  return cargado.fotos;
}

export function fotoDe(producto: NormalizedProduct): string | null {
  const clave = unionKey(producto);
  if (!clave) return null;
  return fotosVigentes()[clave]?.url ?? null;
}

export function _resetFotosForTests(): void {
  cargado = null;
  revisadoEn = 0;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/providers/tests/fotos-indice.test.ts`
Expected: PASS (5 tests).

Nota: un indice corrupto deja un error en el log (lo que pide la spec) y la API sirve todo `null`; un indice ausente es el estado normal antes de la primera corrida y no se registra.

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src/fotos/indice.ts packages/providers/tests/fotos-indice.test.ts
git commit -m "feat(fotos): indice del banco de fotos con lectura por mtime"
```

---

### Task 2: Fuente Intcomex

**Files:**
- Create: `packages/providers/src/fotos/intcomex.ts`
- Test: `packages/providers/tests/fotos-intcomex.test.ts`

**Interfaces:**
- Consumes: `fetchIws(path, params)` de `packages/providers/src/intcomex.ts`; `unionKey` de `@rr/domain/product`.
- Produces:
  ```ts
  export interface ItemExtendido { mpn?: unknown; DescripcionMarca?: unknown; Imagenes?: unknown }
  export function mapaFotosIntcomex(items: ItemExtendido[]): Map<string, string>;
  export function fotosIntcomex(): Promise<Map<string, string>>; // lanza si Intcomex falla
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/providers/tests/fotos-intcomex.test.ts
import { describe, expect, it } from 'vitest';
import { mapaFotosIntcomex } from '../src/fotos/intcomex.js';

// Forma real de downloadextendedcatalog?format=json (medida el 2026-09-22).
const ITEMS = [
  {
    mpn: 'V13H010L57', DescripcionMarca: 'Epson',
    Imagenes: [
      { angulo: null, isMainImage: false, url: 'https://intcomexpim.blob.core.windows.net/assets/images/lateral.jpg' },
      { angulo: null, isMainImage: true, url: 'https://intcomexpim.blob.core.windows.net/assets/images/principal.jpg' },
    ],
  },
  { mpn: 'AB355NXT07', DescripcionMarca: 'Nexxt Solutions Infrastructure',
    Imagenes: [{ isMainImage: false, url: 'https://intcomexpim.blob.core.windows.net/assets/images/unica.png' }] },
  { mpn: 'CE310A', DescripcionMarca: 'HP', Imagenes: [] },
  { mpn: '', DescripcionMarca: 'HP', Imagenes: [{ isMainImage: true, url: 'https://x/sin-mpn.jpg' }] },
  { mpn: 'X1', DescripcionMarca: 'HP', Imagenes: [{ isMainImage: true, url: 'http://inseguro/x.jpg' }] },
];

describe('mapaFotosIntcomex', () => {
  it('toma la imagen principal, o la primera si ninguna lo es', () => {
    const mapa = mapaFotosIntcomex(ITEMS);
    expect(mapa.get('v13h010l57|epson')).toBe('https://intcomexpim.blob.core.windows.net/assets/images/principal.jpg');
    expect(mapa.get('ab355nxt07|nexxt')).toBe('https://intcomexpim.blob.core.windows.net/assets/images/unica.png');
  });

  it('descarta productos sin imagen, sin clave o con URL que no es https', () => {
    const mapa = mapaFotosIntcomex(ITEMS);
    expect(mapa.has('ce310a|hp')).toBe(false);
    expect(mapa.has('x1|hp')).toBe(false);
    expect(mapa.size).toBe(2);
  });

  it('tolera items malformados', () => {
    expect(mapaFotosIntcomex([{}, { Imagenes: 'no-es-arreglo' }, null as never]).size).toBe(0);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/providers/tests/fotos-intcomex.test.ts`
Expected: FAIL — no se resuelve `../src/fotos/intcomex.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/providers/src/fotos/intcomex.ts
import { unionKey } from '@rr/domain/product';
import { fetchIws } from '../intcomex.js';

// El catalogo extendido de Intcomex trae fichas y un arreglo `Imagenes` que
// el catalogo normal (getcatalog) no tiene. Cubre ~21% de la union de los
// tres catalogos (medido el 2026-09-22).

export interface ItemExtendido { mpn?: unknown; DescripcionMarca?: unknown; Imagenes?: unknown }
interface ImagenCruda { url?: unknown; isMainImage?: unknown }

function urlPrincipal(imagenes: unknown): string | null {
  if (!Array.isArray(imagenes) || imagenes.length === 0) return null;
  const lista = imagenes as ImagenCruda[];
  const elegida = lista.find((i) => i?.isMainImage === true) ?? lista[0];
  const url = typeof elegida?.url === 'string' ? elegida.url : '';
  return url.startsWith('https://') ? url : null;
}

export function mapaFotosIntcomex(items: ItemExtendido[]): Map<string, string> {
  const mapa = new Map<string, string>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const url = urlPrincipal(item.Imagenes);
    if (!url) continue;
    const clave = unionKey({
      sku: '', nombre: null, categoria: null, subcategorias: [], tipo: null,
      mpn: typeof item.mpn === 'string' ? item.mpn : null,
      marca: typeof item.DescripcionMarca === 'string' ? item.DescripcionMarca : null,
    });
    if (clave && !mapa.has(clave)) mapa.set(clave, url);
  }
  return mapa;
}

export async function fotosIntcomex(): Promise<Map<string, string>> {
  const res = await fetchIws('downloadextendedcatalog', { format: 'json', locale: 'es' });
  if (!res.ok) throw new Error(`Intcomex respondio HTTP ${res.status} al bajar el catalogo extendido`);
  const data = (await res.json()) as unknown;
  if (!Array.isArray(data)) throw new Error('El catalogo extendido de Intcomex no es un arreglo');
  return mapaFotosIntcomex(data as ItemExtendido[]);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/providers/tests/fotos-intcomex.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src/fotos/intcomex.ts packages/providers/tests/fotos-intcomex.test.ts
git commit -m "feat(fotos): fuente Intcomex desde el catalogo extendido"
```

---

### Task 3: Fuente Icecat

**Files:**
- Create: `packages/providers/src/fotos/icecat.ts`
- Test: `packages/providers/tests/fotos-icecat.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type ResultadoIcecat =
    | { url: string }
    | { motivo: 'no_encontrado' | 'icecat_full' }
    | { reintentar: true };
  export function crearIcecat(usuario: string, fetchImpl?: typeof fetch):
    (mpn: string, marca: string) => Promise<ResultadoIcecat>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/providers/tests/fotos-icecat.test.ts
import { describe, expect, it, vi } from 'vitest';
import { crearIcecat } from '../src/fotos/icecat.js';

function responde(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL) => new Response(JSON.stringify(body), { status }));
}

describe('crearIcecat', () => {
  it('pide con el usuario, marca = primera palabra y MPN sin sufijo regional', async () => {
    const f = responde(200, { data: { Image: { Pic500x500: 'https://images.icecat.biz/img/500.jpg' } } });
    const buscar = crearIcecat('pyxis.latam', f as unknown as typeof fetch);
    await buscar('D66U4AT#ABM', 'Hp Inc');
    const url = new URL(String(f.mock.calls[0][0]));
    expect(url.origin + url.pathname).toBe('https://live.icecat.biz/api');
    expect(url.searchParams.get('UserName')).toBe('pyxis.latam');
    expect(url.searchParams.get('Language')).toBe('es');
    expect(url.searchParams.get('Brand')).toBe('Hp');
    expect(url.searchParams.get('ProductCode')).toBe('D66U4AT');
  });

  it('usa Pic500x500 y cae a HighPic', async () => {
    expect(await crearIcecat('u', responde(200, { data: { Image: { Pic500x500: 'https://a/500.jpg', HighPic: 'https://a/hi.jpg' } } }) as never)('X', 'HP'))
      .toEqual({ url: 'https://a/500.jpg' });
    expect(await crearIcecat('u', responde(200, { data: { Image: { HighPic: 'https://a/hi.jpg' } } }) as never)('X', 'HP'))
      .toEqual({ url: 'https://a/hi.jpg' });
  });

  it('404 es no_encontrado, 403 es icecat_full, 200 sin imagen es no_encontrado', async () => {
    expect(await crearIcecat('u', responde(404, { Code: 404 }) as never)('X', 'HP')).toEqual({ motivo: 'no_encontrado' });
    expect(await crearIcecat('u', responde(403, { Code: 403 }) as never)('X', 'HP')).toEqual({ motivo: 'icecat_full' });
    expect(await crearIcecat('u', responde(200, { data: {} }) as never)('X', 'HP')).toEqual({ motivo: 'no_encontrado' });
  });

  it('cuota, 5xx o red caida se reintentan en otra corrida', async () => {
    expect(await crearIcecat('u', responde(429, {}) as never)('X', 'HP')).toEqual({ reintentar: true });
    expect(await crearIcecat('u', responde(503, {}) as never)('X', 'HP')).toEqual({ reintentar: true });
    const caida = vi.fn(async () => { throw new TypeError('fetch failed'); });
    expect(await crearIcecat('u', caida as never)('X', 'HP')).toEqual({ reintentar: true });
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/providers/tests/fotos-icecat.test.ts`
Expected: FAIL — no se resuelve `../src/fotos/icecat.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/providers/src/fotos/icecat.ts

// Open Icecat: catalogo abierto de fichas por marca + part number. Cubre ~40%
// de lo que Intcomex no tiene; otro ~15% son marcas "Full Icecat" (de pago),
// que responden 403. Cuenta de Pyxis: pyxis.latam (no exige token ni IP).

export type ResultadoIcecat =
  | { url: string }
  | { motivo: 'no_encontrado' | 'icecat_full' }
  | { reintentar: true };

const API = 'https://live.icecat.biz/api';
const TIMEOUT_MS = 20000;

interface RespuestaIcecat { data?: { Image?: { Pic500x500?: unknown; HighPic?: unknown } } }

export function crearIcecat(usuario: string, fetchImpl: typeof fetch = fetch) {
  return async function buscar(mpn: string, marca: string): Promise<ResultadoIcecat> {
    const url = new URL(API);
    url.searchParams.set('UserName', usuario);
    url.searchParams.set('Language', 'es');
    // Icecat conoce al fabricante por su nombre corto; el catalogo le pega la
    // unidad de negocio ("EPSON COMMERCIAL HW"), igual que en canonicalBrand.
    url.searchParams.set('Brand', marca.trim().split(/\s+/)[0] ?? '');
    // El sufijo regional de HP (#ABM) no existe en Icecat.
    url.searchParams.set('ProductCode', mpn.replace(/#.*$/, '').trim());

    let res: Response;
    try {
      res = await fetchImpl(url, { signal: AbortSignal.timeout(TIMEOUT_MS) });
    } catch {
      return { reintentar: true };
    }
    if (res.status === 404) return { motivo: 'no_encontrado' };
    if (res.status === 403) return { motivo: 'icecat_full' };
    if (!res.ok) return { reintentar: true };

    const body = (await res.json().catch(() => ({}))) as RespuestaIcecat;
    const img = body.data?.Image;
    const elegida = [img?.Pic500x500, img?.HighPic].find(
      (u): u is string => typeof u === 'string' && u.startsWith('https://'),
    );
    return elegida ? { url: elegida } : { motivo: 'no_encontrado' };
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/providers/tests/fotos-icecat.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src/fotos/icecat.ts packages/providers/tests/fotos-icecat.test.ts
git commit -m "feat(fotos): fuente Icecat por marca y part number"
```

---

### Task 4: Storage de Supabase

**Files:**
- Create: `packages/providers/src/fotos/storage.ts`
- Test: `packages/providers/tests/fotos-storage.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface StorageFotos {
    asegurarBucket(): Promise<void>;                 // crea el bucket publico si no existe
    subir(ruta: string, bytes: Uint8Array, contentType: string): Promise<string>; // URL publica
  }
  export function crearStorage(cfg: { url: string; key: string; bucket?: string; fetchImpl?: typeof fetch }): StorageFotos;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/providers/tests/fotos-storage.test.ts
import { describe, expect, it, vi } from 'vitest';
import { crearStorage } from '../src/fotos/storage.js';

const CFG = { url: 'https://proyecto.supabase.co/', key: 'service-key' };

describe('crearStorage', () => {
  it('sube con upsert y devuelve la URL publica', async () => {
    const f = vi.fn(async () => new Response('{}', { status: 200 }));
    const storage = crearStorage({ ...CFG, fetchImpl: f as unknown as typeof fetch });
    const url = await storage.subir('hp/ce310a.jpg', new Uint8Array([1, 2, 3]), 'image/jpeg');

    expect(url).toBe('https://proyecto.supabase.co/storage/v1/object/public/fotos-productos/hp/ce310a.jpg');
    const [destino, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(destino).toBe('https://proyecto.supabase.co/storage/v1/object/fotos-productos/hp/ce310a.jpg');
    expect(init.method).toBe('POST');
    const h = init.headers as Record<string, string>;
    expect(h.authorization).toBe('Bearer service-key');
    expect(h.apikey).toBe('service-key');
    expect(h['x-upsert']).toBe('true');
    expect(h['content-type']).toBe('image/jpeg');
  });

  it('una subida rechazada lanza con el status', async () => {
    const f = vi.fn(async () => new Response('{"error":"x"}', { status: 401 }));
    await expect(crearStorage({ ...CFG, fetchImpl: f as never }).subir('a/b.jpg', new Uint8Array(), 'image/jpeg'))
      .rejects.toThrow(/401/);
  });

  it('asegurarBucket crea un bucket publico y acepta que ya exista', async () => {
    const f = vi.fn(async () => new Response('{"error":"Duplicate","message":"The resource already exists"}', { status: 409 }));
    await crearStorage({ ...CFG, fetchImpl: f as never }).asegurarBucket();
    const [destino, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(destino).toBe('https://proyecto.supabase.co/storage/v1/bucket');
    expect(JSON.parse(String(init.body))).toEqual({ id: 'fotos-productos', name: 'fotos-productos', public: true });
  });

  it('asegurarBucket lanza ante credenciales invalidas', async () => {
    const f = vi.fn(async () => new Response('{"message":"Invalid JWT"}', { status: 403 }));
    await expect(crearStorage({ ...CFG, fetchImpl: f as never }).asegurarBucket()).rejects.toThrow(/403/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/providers/tests/fotos-storage.test.ts`
Expected: FAIL — no se resuelve `../src/fotos/storage.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/providers/src/fotos/storage.ts

// Supabase Storage por su API REST, sin SDK, igual que el resto del repo habla
// con Supabase (apps/mailer/src/pago/datos.ts). Bucket publico de lectura: la
// tienda enlaza las fotos directo.

export interface StorageFotos {
  asegurarBucket(): Promise<void>;
  subir(ruta: string, bytes: Uint8Array, contentType: string): Promise<string>;
}

const TIMEOUT_MS = 30000;

export function crearStorage(cfg: {
  url: string; key: string; bucket?: string; fetchImpl?: typeof fetch;
}): StorageFotos {
  const base = cfg.url.replace(/\/+$/, '');
  const bucket = cfg.bucket ?? 'fotos-productos';
  const f = cfg.fetchImpl ?? fetch;
  const auth = { authorization: `Bearer ${cfg.key}`, apikey: cfg.key };

  return {
    async asegurarBucket() {
      const res = await f(`${base}/storage/v1/bucket`, {
        method: 'POST',
        headers: { ...auth, 'content-type': 'application/json' },
        body: JSON.stringify({ id: bucket, name: bucket, public: true }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) return;
      const texto = await res.text().catch(() => '');
      // Supabase responde 409 (o 400 con "already exists") si ya existe.
      if (res.status === 409 || /already exists|duplicate/i.test(texto)) return;
      throw new Error(`Supabase Storage respondio HTTP ${res.status} al crear el bucket: ${texto.slice(0, 200)}`);
    },

    async subir(ruta, bytes, contentType) {
      const res = await f(`${base}/storage/v1/object/${bucket}/${ruta}`, {
        method: 'POST',
        headers: { ...auth, 'content-type': contentType, 'x-upsert': 'true' },
        body: bytes,
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (!res.ok) {
        const texto = await res.text().catch(() => '');
        throw new Error(`Supabase Storage respondio HTTP ${res.status} al subir ${ruta}: ${texto.slice(0, 200)}`);
      }
      return `${base}/storage/v1/object/public/${bucket}/${ruta}`;
    },
  };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/providers/tests/fotos-storage.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src/fotos/storage.ts packages/providers/tests/fotos-storage.test.ts
git commit -m "feat(fotos): subida a Supabase Storage por REST"
```

---

### Task 5: Orquestador

**Files:**
- Create: `packages/providers/src/fotos/banco.ts`
- Test: `packages/providers/tests/fotos-banco.test.ts`

**Interfaces:**
- Consumes: `IndiceFotos`, `MotivoSinFoto`, `FuenteFoto` (Task 1); `ResultadoIcecat` (Task 3); `unionKey` de `@rr/domain/product`.
- Produces:
  ```ts
  export interface ProductoBanco { clave: string; mpn: string; marca: string; nombre: string; proveedores: string[]; conStock: boolean }
  export interface Descarga { bytes: Uint8Array; contentType: string }
  export interface DepsBanco {
    productos: ProductoBanco[];
    indice: IndiceFotos;                                   // se muta en el lugar
    guardar(indice: IndiceFotos): void;
    fotosIntcomex(): Promise<Map<string, string>>;
    icecat: ((mpn: string, marca: string) => Promise<ResultadoIcecat>) | null;
    descargar(url: string): Promise<Descarga | null>;
    subir(ruta: string, bytes: Uint8Array, contentType: string): Promise<string>;
    ahora?: () => Date;
    limite?: number;         // tope de claves pendientes a procesar (muestra)
    concurrencia?: number;   // default 4
  }
  export interface ResumenBanco {
    procesados: number;
    nuevas: Record<FuenteFoto, number>;
    sinFoto: Record<MotivoSinFoto, number>;
    pendientes: number;          // quedaron para otra corrida (reintentar o Intcomex caido)
    intcomexCaido: boolean;
  }
  export const REINTENTO_MS: number;                 // 30 dias
  export const GUARDAR_CADA: number;                 // 200
  export function imagenValida(contentType: string, bytes: number): boolean;
  export function extension(contentType: string): 'jpg' | 'png' | 'webp';
  export function rutaFoto(clave: string, contentType: string): string; // "hp/ce310a.jpg"
  export function productosDesdeCatalogos(
    catalogos: Record<string, NormalizedProduct[]>,
    conStock: (proveedor: string, sku: string) => boolean,
  ): ProductoBanco[];
  export function csvFaltantes(productos: ProductoBanco[], indice: IndiceFotos): string;
  export function actualizarBancoFotos(deps: DepsBanco): Promise<ResumenBanco>;
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/providers/tests/fotos-banco.test.ts
import { describe, expect, it, vi } from 'vitest';
import type { NormalizedProduct } from '@rr/domain/product';
import {
  GUARDAR_CADA, actualizarBancoFotos, csvFaltantes, imagenValida, productosDesdeCatalogos, rutaFoto,
  type DepsBanco, type ProductoBanco,
} from '../src/fotos/banco.js';
import { indiceVacio } from '../src/fotos/indice.js';

const AHORA = new Date('2026-09-24T12:00:00Z');
const JPG = { bytes: new Uint8Array(4000), contentType: 'image/jpeg' };

function prod(clave: string, extra: Partial<ProductoBanco> = {}): ProductoBanco {
  const [mpn, marca] = clave.split('|');
  return { clave, mpn: mpn.toUpperCase(), marca: marca.toUpperCase(), nombre: `Producto ${mpn}`, proveedores: ['intcomex'], conStock: false, ...extra };
}

function deps(over: Partial<DepsBanco> = {}): DepsBanco {
  return {
    productos: [],
    indice: indiceVacio(),
    guardar: vi.fn(),
    fotosIntcomex: async () => new Map(),
    icecat: async () => ({ motivo: 'no_encontrado' }),
    descargar: async () => JPG,
    subir: async (ruta) => `https://storage/${ruta}`,
    ahora: () => AHORA,
    ...over,
  };
}

describe('validaciones', () => {
  it('imagenValida: tipo de imagen y entre 2 KB y 5 MB', () => {
    expect(imagenValida('image/jpeg', 4000)).toBe(true);
    expect(imagenValida('image/png; charset=binary', 4000)).toBe(true);
    expect(imagenValida('text/html', 4000)).toBe(false);
    expect(imagenValida('image/jpeg', 1000)).toBe(false);
    expect(imagenValida('image/jpeg', 6 * 1024 * 1024)).toBe(false);
  });

  it('rutaFoto arma {marca}/{mpn}.{ext} desde la clave', () => {
    expect(rutaFoto('ce310a|hp', 'image/jpeg')).toBe('hp/ce310a.jpg');
    expect(rutaFoto('ab355nxt07|nexxt', 'image/png')).toBe('nexxt/ab355nxt07.png');
  });
});

describe('actualizarBancoFotos', () => {
  it('Intcomex primero; si no tiene, Icecat', async () => {
    const icecat = vi.fn(async () => ({ url: 'https://icecat/b.jpg' }));
    const d = deps({
      productos: [prod('a1|hp'), prod('b2|hp')],
      fotosIntcomex: async () => new Map([['a1|hp', 'https://intcomex/a.jpg']]),
      icecat,
    });
    const r = await actualizarBancoFotos(d);
    expect(d.indice.fotos['a1|hp']).toEqual({ url: 'https://storage/hp/a1.jpg', fuente: 'intcomex', obtenidaEn: AHORA.toISOString() });
    expect(d.indice.fotos['b2|hp'].fuente).toBe('icecat');
    expect(icecat).toHaveBeenCalledTimes(1);
    expect(icecat).toHaveBeenCalledWith('B2', 'HP');
    expect(r.nuevas).toEqual({ intcomex: 1, icecat: 1 });
  });

  it('no vuelve a tocar lo que ya tiene foto', async () => {
    const d = deps({ productos: [prod('a1|hp')], descargar: vi.fn(async () => JPG) });
    d.indice.fotos['a1|hp'] = { url: 'https://vieja', fuente: 'intcomex', obtenidaEn: 'x' };
    await actualizarBancoFotos(d);
    expect(d.descargar).not.toHaveBeenCalled();
    expect(d.indice.fotos['a1|hp'].url).toBe('https://vieja');
  });

  it('reintenta lo marcado sin foto recien despues de 30 dias', async () => {
    const icecat = vi.fn(async () => ({ motivo: 'no_encontrado' as const }));
    const d = deps({ productos: [prod('a1|hp'), prod('b2|hp')], icecat });
    d.indice.sinFoto['a1|hp'] = { motivo: 'no_encontrado', intentadoEn: '2026-09-10T00:00:00Z' };
    d.indice.sinFoto['b2|hp'] = { motivo: 'no_encontrado', intentadoEn: '2026-08-01T00:00:00Z' };
    await actualizarBancoFotos(d);
    expect(icecat).toHaveBeenCalledTimes(1);
    expect(icecat).toHaveBeenCalledWith('B2', 'HP');
    expect(d.indice.sinFoto['b2|hp'].intentadoEn).toBe(AHORA.toISOString());
  });

  it('registra el motivo: no_encontrado, icecat_full y descarga_fallida', async () => {
    const d = deps({
      productos: [prod('a1|hp'), prod('b2|cisco'), prod('c3|hp')],
      fotosIntcomex: async () => new Map([['c3|hp', 'https://intcomex/rota.jpg']]),
      icecat: async (mpn) => (mpn === 'B2' ? { motivo: 'icecat_full' } : { motivo: 'no_encontrado' }),
      descargar: async () => ({ bytes: new Uint8Array(10), contentType: 'text/html' }),
    });
    const r = await actualizarBancoFotos(d);
    expect(d.indice.sinFoto['a1|hp'].motivo).toBe('no_encontrado');
    expect(d.indice.sinFoto['b2|cisco'].motivo).toBe('icecat_full');
    expect(d.indice.sinFoto['c3|hp'].motivo).toBe('descarga_fallida');
    expect(r.sinFoto).toEqual({ no_encontrado: 1, icecat_full: 1, descarga_fallida: 1 });
  });

  it('si la foto de Intcomex no baja, prueba Icecat antes de rendirse', async () => {
    const d = deps({
      productos: [prod('a1|hp')],
      fotosIntcomex: async () => new Map([['a1|hp', 'https://intcomex/rota.jpg']]),
      icecat: async () => ({ url: 'https://icecat/ok.jpg' }),
      descargar: async (url) => (url.includes('rota') ? null : JPG),
    });
    await actualizarBancoFotos(d);
    expect(d.indice.fotos['a1|hp'].fuente).toBe('icecat');
  });

  it('Intcomex caido: sigue con Icecat y no marca nada como no_encontrado', async () => {
    const d = deps({
      productos: [prod('a1|hp'), prod('b2|hp')],
      fotosIntcomex: async () => { throw new Error('Intcomex caido'); },
      icecat: async (mpn) => (mpn === 'A1' ? { url: 'https://icecat/a.jpg' } : { motivo: 'no_encontrado' }),
    });
    const r = await actualizarBancoFotos(d);
    expect(r.intcomexCaido).toBe(true);
    expect(d.indice.fotos['a1|hp'].fuente).toBe('icecat');
    expect(d.indice.sinFoto['b2|hp']).toBeUndefined();
    expect(r.pendientes).toBe(1);
  });

  it('Icecat con cuota o 5xx deja la clave pendiente, sin motivo', async () => {
    const d = deps({ productos: [prod('a1|hp')], icecat: async () => ({ reintentar: true }) });
    const r = await actualizarBancoFotos(d);
    expect(d.indice.sinFoto['a1|hp']).toBeUndefined();
    expect(r.pendientes).toBe(1);
  });

  it('sin Icecat configurado, lo que Intcomex no tiene queda no_encontrado', async () => {
    const d = deps({ productos: [prod('a1|hp')], icecat: null });
    await actualizarBancoFotos(d);
    expect(d.indice.sinFoto['a1|hp'].motivo).toBe('no_encontrado');
  });

  it('guarda el indice por lotes y al final', async () => {
    const productos = Array.from({ length: GUARDAR_CADA * 2 + 5 }, (_, i) => prod(`m${i}|hp`));
    const d = deps({ productos });
    await actualizarBancoFotos(d);
    expect(d.guardar).toHaveBeenCalledTimes(3);
  });

  it('respeta el limite de la muestra, con stock primero', async () => {
    const d = deps({ productos: [prod('a1|hp'), prod('b2|hp', { conStock: true }), prod('c3|hp')], limite: 1 });
    const r = await actualizarBancoFotos(d);
    expect(r.procesados).toBe(1);
    expect(Object.keys(d.indice.sinFoto)).toEqual(['b2|hp']);
  });

  it('si el storage falla, guarda lo hecho y relanza', async () => {
    const d = deps({
      productos: [prod('a1|hp'), prod('b2|hp')],
      icecat: async () => ({ url: 'https://icecat/x.jpg' }),
      subir: async () => { throw new Error('HTTP 500'); },
      concurrencia: 1,
    });
    await expect(actualizarBancoFotos(d)).rejects.toThrow(/500/);
    expect(d.guardar).toHaveBeenCalled();
  });
});

describe('productosDesdeCatalogos', () => {
  const p = (sku: string, mpn: string | null, marca: string): NormalizedProduct =>
    ({ sku, mpn, nombre: `N ${sku}`, marca, categoria: null, subcategorias: [], tipo: null });

  it('une por clave, junta proveedores y marca stock si alguno lo tiene', () => {
    const out = productosDesdeCatalogos(
      { intcomex: [p('I1', 'CE310A', 'HP')], tecnoglobal: [p('T1', 'CE-310A', 'HP INC'), p('T2', null, 'HP')] },
      (prov, sku) => prov === 'tecnoglobal' && sku === 'T1',
    );
    expect(out).toEqual([
      { clave: 'ce310a|hp', mpn: 'CE310A', marca: 'HP', nombre: 'N I1', proveedores: ['intcomex', 'tecnoglobal'], conStock: true },
    ]);
  });
});

describe('csvFaltantes', () => {
  it('lista lo que no tiene foto: stock primero, luego mas proveedores', () => {
    const indice = indiceVacio();
    indice.fotos['a1|hp'] = { url: 'x', fuente: 'intcomex', obtenidaEn: 'x' };
    indice.sinFoto['c3|hp'] = { motivo: 'icecat_full', intentadoEn: 'x' };
    const csv = csvFaltantes([
      prod('a1|hp'),
      prod('b2|hp', { proveedores: ['intcomex', 'ingram'] }),
      prod('c3|hp', { conStock: true, nombre: 'Toner "negro", XL' }),
      prod('d4|hp'),
    ], indice);
    expect(csv.split('\n')).toEqual([
      'clave,mpn,marca,nombre,proveedores,con_stock,motivo',
      'c3|hp,C3,HP,"Toner ""negro"", XL",intcomex,si,icecat_full',
      'b2|hp,B2,HP,Producto b2,intcomex ingram,no,pendiente',
      'd4|hp,D4,HP,Producto d4,intcomex,no,pendiente',
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/providers/tests/fotos-banco.test.ts`
Expected: FAIL — no se resuelve `../src/fotos/banco.js`.

- [ ] **Step 3: Write minimal implementation**

```ts
// packages/providers/src/fotos/banco.ts
import { unionKey, type NormalizedProduct } from '@rr/domain/product';
import type { FuenteFoto, IndiceFotos, MotivoSinFoto } from './indice.js';
import type { ResultadoIcecat } from './icecat.js';

// Orquestador del banco de fotos. Recibe todo lo que toca red o disco como
// dependencia, asi se prueba sin red. Reglas en
// docs/superpowers/specs/2026-09-23-banco-fotos-design.md.

export interface ProductoBanco {
  clave: string; mpn: string; marca: string; nombre: string; proveedores: string[]; conStock: boolean;
}
export interface Descarga { bytes: Uint8Array; contentType: string }

export interface DepsBanco {
  productos: ProductoBanco[];
  indice: IndiceFotos;
  guardar(indice: IndiceFotos): void;
  fotosIntcomex(): Promise<Map<string, string>>;
  icecat: ((mpn: string, marca: string) => Promise<ResultadoIcecat>) | null;
  descargar(url: string): Promise<Descarga | null>;
  subir(ruta: string, bytes: Uint8Array, contentType: string): Promise<string>;
  ahora?: () => Date;
  limite?: number;
  concurrencia?: number;
}

export interface ResumenBanco {
  procesados: number;
  nuevas: Record<FuenteFoto, number>;
  sinFoto: Record<MotivoSinFoto, number>;
  pendientes: number;
  intcomexCaido: boolean;
}

export const REINTENTO_MS = 30 * 24 * 60 * 60 * 1000;
export const GUARDAR_CADA = 200;
const MIN_BYTES = 2 * 1024;
const MAX_BYTES = 5 * 1024 * 1024;
const TIPOS = ['image/jpeg', 'image/png', 'image/webp'];

function tipoBase(contentType: string): string {
  return contentType.split(';')[0].trim().toLowerCase();
}

export function imagenValida(contentType: string, bytes: number): boolean {
  return TIPOS.includes(tipoBase(contentType)) && bytes >= MIN_BYTES && bytes <= MAX_BYTES;
}

export function extension(contentType: string): 'jpg' | 'png' | 'webp' {
  const t = tipoBase(contentType);
  return t === 'image/png' ? 'png' : t === 'image/webp' ? 'webp' : 'jpg';
}

export function rutaFoto(clave: string, contentType: string): string {
  const [mpn, marca] = clave.split('|');
  return `${marca}/${mpn}.${extension(contentType)}`;
}

export function productosDesdeCatalogos(
  catalogos: Record<string, NormalizedProduct[]>,
  conStock: (proveedor: string, sku: string) => boolean,
): ProductoBanco[] {
  const porClave = new Map<string, ProductoBanco>();
  for (const [proveedor, productos] of Object.entries(catalogos)) {
    for (const p of productos) {
      const clave = unionKey(p);
      if (!clave || !p.mpn || !p.marca) continue;
      let e = porClave.get(clave);
      if (!e) {
        e = { clave, mpn: p.mpn, marca: p.marca, nombre: p.nombre ?? '', proveedores: [], conStock: false };
        porClave.set(clave, e);
      }
      if (!e.proveedores.includes(proveedor)) e.proveedores.push(proveedor);
      if (conStock(proveedor, p.sku)) e.conStock = true;
    }
  }
  return [...porClave.values()];
}

// Prioridad para procesar y para la lista de faltantes: lo que se puede
// vender hoy primero, despues lo que mas mayoristas ofrecen.
function prioridad(a: ProductoBanco, b: ProductoBanco): number {
  if (a.conStock !== b.conStock) return a.conStock ? -1 : 1;
  return b.proveedores.length - a.proveedores.length;
}

type Resultado =
  | { tipo: 'foto'; url: string; fuente: FuenteFoto }
  | { tipo: 'sin_foto'; motivo: MotivoSinFoto }
  | { tipo: 'pendiente' };

export async function actualizarBancoFotos(deps: DepsBanco): Promise<ResumenBanco> {
  const ahora = deps.ahora ?? (() => new Date());
  const { indice } = deps;
  const resumen: ResumenBanco = {
    procesados: 0,
    nuevas: { intcomex: 0, icecat: 0 },
    sinFoto: { no_encontrado: 0, icecat_full: 0, descarga_fallida: 0 },
    pendientes: 0,
    intcomexCaido: false,
  };

  const inicio = ahora().getTime();
  let pendientes = deps.productos
    .filter((p) => !indice.fotos[p.clave])
    .filter((p) => {
      const previo = indice.sinFoto[p.clave];
      return !previo || inicio - new Date(previo.intentadoEn).getTime() >= REINTENTO_MS;
    })
    .sort(prioridad);
  if (deps.limite !== undefined) pendientes = pendientes.slice(0, deps.limite);

  let deIntcomex = new Map<string, string>();
  try {
    deIntcomex = await deps.fotosIntcomex();
  } catch (error) {
    resumen.intcomexCaido = true;
    console.error('[fotos] no se pudo bajar el catalogo extendido de Intcomex; se sigue con Icecat', error);
  }

  // Descarga, valida y sube. null = la imagen no sirvio. Un fallo del storage
  // lanza: no tiene sentido seguir descargando fotos que no se pueden guardar.
  const guardarFoto = async (clave: string, url: string): Promise<string | null> => {
    const d = await deps.descargar(url).catch(() => null);
    if (!d || !imagenValida(d.contentType, d.bytes.byteLength)) return null;
    return deps.subir(rutaFoto(clave, d.contentType), d.bytes, tipoBase(d.contentType));
  };

  const resolver = async (p: ProductoBanco): Promise<Resultado> => {
    let hayCandidata = false;
    const urlIntcomex = deIntcomex.get(p.clave);
    if (urlIntcomex) {
      hayCandidata = true;
      const url = await guardarFoto(p.clave, urlIntcomex);
      if (url) return { tipo: 'foto', url, fuente: 'intcomex' };
    }
    let motivoIcecat: MotivoSinFoto = 'no_encontrado';
    if (deps.icecat) {
      const r = await deps.icecat(p.mpn, p.marca);
      if ('reintentar' in r) return { tipo: 'pendiente' };
      if ('url' in r) {
        hayCandidata = true;
        const url = await guardarFoto(p.clave, r.url);
        if (url) return { tipo: 'foto', url, fuente: 'icecat' };
      } else {
        motivoIcecat = r.motivo;
      }
    }
    if (hayCandidata) return { tipo: 'sin_foto', motivo: 'descarga_fallida' };
    // Con Intcomex caido, "no encontrado" no es cierto: puede tener foto alla.
    if (resumen.intcomexCaido && motivoIcecat === 'no_encontrado') return { tipo: 'pendiente' };
    return { tipo: 'sin_foto', motivo: motivoIcecat };
  };

  const registrar = (p: ProductoBanco, r: Resultado): void => {
    const cuando = ahora().toISOString();
    if (r.tipo === 'foto') {
      indice.fotos[p.clave] = { url: r.url, fuente: r.fuente, obtenidaEn: cuando };
      delete indice.sinFoto[p.clave];
      resumen.nuevas[r.fuente]++;
    } else if (r.tipo === 'sin_foto') {
      indice.sinFoto[p.clave] = { motivo: r.motivo, intentadoEn: cuando };
      resumen.sinFoto[r.motivo]++;
    } else {
      resumen.pendientes++;
    }
    resumen.procesados++;
    if (resumen.procesados % GUARDAR_CADA === 0) deps.guardar(indice);
  };

  let siguiente = 0;
  const trabajador = async (): Promise<void> => {
    while (siguiente < pendientes.length) {
      const p = pendientes[siguiente++];
      registrar(p, await resolver(p));
    }
  };

  try {
    await Promise.all(Array.from({ length: deps.concurrencia ?? 4 }, trabajador));
  } catch (error) {
    deps.guardar(indice);
    throw error;
  }
  if (resumen.procesados % GUARDAR_CADA !== 0 || resumen.procesados === 0) deps.guardar(indice);
  return resumen;
}

function celda(valor: string): string {
  return /[",\n]/.test(valor) ? `"${valor.replace(/"/g, '""')}"` : valor;
}

export function csvFaltantes(productos: ProductoBanco[], indice: IndiceFotos): string {
  const filas = productos
    .filter((p) => !indice.fotos[p.clave])
    .sort(prioridad)
    .map((p) => [
      p.clave, p.mpn, p.marca, p.nombre, p.proveedores.join(' '),
      p.conStock ? 'si' : 'no', indice.sinFoto[p.clave]?.motivo ?? 'pendiente',
    ].map(celda).join(','));
  return ['clave,mpn,marca,nombre,proveedores,con_stock,motivo', ...filas].join('\n');
}
```


- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run packages/providers/tests/fotos-banco.test.ts`
Expected: PASS (14 tests).

Nota sobre "guarda el indice por lotes y al final": con 405 productos se guarda en 200, 400 y al final (405) = 3 llamadas. Si `procesados` cae justo en múltiplo de 200, el guardado del lote ya cubre el final y no se repite.

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src/fotos/banco.ts packages/providers/tests/fotos-banco.test.ts
git commit -m "feat(fotos): orquestador del banco con reintento a 30 dias y lista de faltantes"
```

---

### Task 6: Cableado real, script manual y disparo tras el refresco

**Files:**
- Create: `packages/providers/src/fotos/correr.ts`
- Create: `apps/pricing-api/scripts/banco-fotos.ts`
- Modify: `apps/pricing-api/server.ts` (función `refresh`, líneas 47-59)
- Modify: `apps/pricing-api/package.json` (scripts), `package.json` raíz (scripts)
- Test: `packages/providers/tests/fotos-correr.test.ts`

**Interfaces:**
- Consumes: todo lo de Tasks 1–5; `loadCatalog`/`getCatalog` de `packages/providers/src/catalog.ts`.
- Produces:
  ```ts
  export function skusConStock(dir: string, proveedores: string[]): Set<string>; // "proveedor:sku"
  export function correrBancoFotos(
    catalogos: Record<string, NormalizedProduct[]>,
    opciones?: { limite?: number },
  ): Promise<ResumenBanco | null>;   // null = ya habia una corrida en curso
  ```

- [ ] **Step 1: Write the failing test**

```ts
// packages/providers/tests/fotos-correr.test.ts
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { skusConStock } from '../src/fotos/correr.js';

describe('skusConStock', () => {
  it('lee el cache de precios y devuelve los SKU con stock > 0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'stock-'));
    writeFileSync(join(dir, 'prices-intcomex.json'), JSON.stringify({ entries: {
      I1: { info: { price: 1, currency: 'USD', inStock: 3 }, quotedAt: 1 },
      I2: { info: { price: 1, currency: 'USD', inStock: 0 }, quotedAt: 1 },
      I3: { info: null, quotedAt: 1 },
    } }));
    writeFileSync(join(dir, 'prices-ingram.json'), '{corrupto');
    const s = skusConStock(dir, ['intcomex', 'ingram', 'tecnoglobal']);
    expect([...s]).toEqual(['intcomex:I1']);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run packages/providers/tests/fotos-correr.test.ts`
Expected: FAIL — no se resuelve `../src/fotos/correr.js`.

- [ ] **Step 3: Write the implementation**

```ts
// packages/providers/src/fotos/correr.ts
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { NormalizedProduct } from '@rr/domain/product';
import {
  actualizarBancoFotos, csvFaltantes, productosDesdeCatalogos, type Descarga, type ResumenBanco,
} from './banco.js';
import { crearIcecat } from './icecat.js';
import { guardarIndice, leerIndice } from './indice.js';
import { fotosIntcomex } from './intcomex.js';
import { crearStorage } from './storage.js';

function cacheDir(): string {
  return process.env.CATALOG_CACHE_DIR ?? 'cache';
}

export function skusConStock(dir: string, proveedores: string[]): Set<string> {
  const out = new Set<string>();
  for (const prov of proveedores) {
    try {
      const raw = JSON.parse(readFileSync(join(dir, `prices-${prov}.json`), 'utf8')) as {
        entries?: Record<string, { info?: { inStock?: number | null } | null }>;
      };
      for (const [sku, e] of Object.entries(raw.entries ?? {})) {
        if ((e?.info?.inStock ?? 0) > 0) out.add(`${prov}:${sku}`);
      }
    } catch {
      // Sin cache de precios para ese proveedor: sin datos de stock, no es error.
    }
  }
  return out;
}

async function descargar(url: string): Promise<Descarga | null> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(20000) });
    if (!res.ok) return null;
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') ?? '' };
  } catch {
    return null;
  }
}

// Candado de proceso: el servidor dispara el banco tras cada refresco y la
// primera corrida dura horas; dos a la vez duplicarian llamadas a Icecat.
let enCurso = false;

export async function correrBancoFotos(
  catalogos: Record<string, NormalizedProduct[]>,
  opciones: { limite?: number } = {},
): Promise<ResumenBanco | null> {
  if (enCurso) {
    console.log('[fotos] ya hay una corrida en curso; se omite');
    return null;
  }
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) throw new Error('Faltan SUPABASE_URL o SUPABASE_SERVICE_KEY para el banco de fotos');

  enCurso = true;
  try {
    const storage = crearStorage({ url, key });
    // Si el storage no responde se corta aca, antes de tocar el indice.
    await storage.asegurarBucket();

    const dir = cacheDir();
    const stock = skusConStock(dir, Object.keys(catalogos));
    const productos = productosDesdeCatalogos(catalogos, (prov, sku) => stock.has(`${prov}:${sku}`));
    const indice = leerIndice();
    const usuario = process.env.ICECAT_USER?.trim();
    if (!usuario) console.log('[fotos] sin ICECAT_USER: solo se usan fotos de Intcomex');

    const resumen = await actualizarBancoFotos({
      productos,
      indice,
      guardar: (i) => guardarIndice(i),
      fotosIntcomex,
      icecat: usuario ? crearIcecat(usuario) : null,
      descargar,
      subir: (ruta, bytes, tipo) => storage.subir(ruta, bytes, tipo),
      limite: opciones.limite,
    });

    writeFileSync(join(dir, 'fotos-faltantes.csv'), csvFaltantes(productos, indice));
    const conFoto = Object.keys(indice.fotos).length;
    console.log(
      `[fotos] ${resumen.procesados} procesados · nuevas intcomex ${resumen.nuevas.intcomex}, icecat ${resumen.nuevas.icecat}` +
        ` · sin foto ${JSON.stringify(resumen.sinFoto)} · pendientes ${resumen.pendientes}` +
        (resumen.intcomexCaido ? ' · INTCOMEX CAIDO' : '') +
        ` · total con foto ${conFoto}/${productos.length}`,
    );
    return resumen;
  } finally {
    enCurso = false;
  }
}
```

```ts
// apps/pricing-api/scripts/banco-fotos.ts
import { fileURLToPath } from 'node:url';

// Mismo cache que server.ts: la raiz del repo.
process.env.CATALOG_CACHE_DIR ??= fileURLToPath(new URL('../../../cache', import.meta.url));

import { loadCatalog } from '@rr/providers/catalog';
import { PROVIDERS } from '@rr/providers';
import { configuredProviders } from '@rr/domain/refresh';
import { correrBancoFotos } from '@rr/providers/fotos/correr';
import type { NormalizedProduct } from '@rr/domain/product';

// Uso: npm run fotos             -> corrida completa (la primera tarda horas)
//      npm run fotos -- 200      -> solo las 200 claves pendientes de mas prioridad
const limite = process.argv[2] ? Number(process.argv[2]) : undefined;
if (limite !== undefined && !(Number.isInteger(limite) && limite > 0)) {
  console.error('El argumento debe ser un entero positivo (tope de productos).');
  process.exit(1);
}

const catalogos: Record<string, NormalizedProduct[]> = {};
for (const nombre of configuredProviders(PROVIDERS)) {
  try {
    catalogos[nombre] = await loadCatalog(nombre);
  } catch (error) {
    console.error(`[fotos] ${nombre}: sin catalogo, queda fuera de esta corrida`, error);
  }
}

await correrBancoFotos(catalogos, { limite });
```

En `apps/pricing-api/server.ts`, reemplazar la función `refresh` (líneas 47-56) por:

```ts
import { getCatalog } from '@rr/providers/catalog';
import { correrBancoFotos } from '@rr/providers/fotos/correr';
// (sumar ambos imports junto a los existentes, arriba del archivo)

function refresh(): void {
  const names = configuredProviders(PROVIDERS);
  const pending = Object.keys(PROVIDERS).filter((n) => !names.includes(n));
  if (pending.length > 0) {
    console.log(`[catalog] sin credenciales, no se refrescan: ${pending.join(', ')}`);
  }
  void refreshAll(names, loadCatalog, retry).then(() => {
    // El banco de fotos va despues del refresco y en segundo plano: nunca
    // retrasa ni tumba al servidor. Usa los catalogos que hayan quedado en
    // memoria; un proveedor caido simplemente no aporta claves esta vez.
    const catalogos: Record<string, ReturnType<typeof getCatalog>> = {};
    for (const n of names) {
      try { catalogos[n] = getCatalog(n); } catch { /* sin catalogo todavia */ }
    }
    correrBancoFotos(catalogos).catch((error) => console.error('[fotos] la corrida fallo', error));
  });
}
```

En `apps/pricing-api/package.json`, agregar al bloque `scripts`:

```json
"fotos": "tsx --conditions=development --env-file=../../.env.local scripts/banco-fotos.ts"
```

En el `package.json` raíz, agregar al bloque `scripts`:

```json
"fotos": "npm run fotos -w @rr/pricing-api --"
```

- [ ] **Step 4: Run tests and typecheck**

Run: `npx vitest run packages/providers/tests/fotos-correr.test.ts && npx vitest run apps/pricing-api/tests/server.test.ts && npm run typecheck`
Expected: PASS y typecheck sin errores. (`server.test.ts` usa `createApp()`, no `server.ts`, asi que el disparo nuevo no lo afecta.)

- [ ] **Step 5: Commit**

```bash
git add packages/providers/src/fotos/correr.ts packages/providers/tests/fotos-correr.test.ts apps/pricing-api/scripts/banco-fotos.ts apps/pricing-api/server.ts apps/pricing-api/package.json package.json
git commit -m "feat(fotos): npm run fotos y corrida automatica tras cada refresco"
```

---

### Task 7: La pricing-api devuelve `foto`

**Files:**
- Modify: `apps/pricing-api/src/handlers/search.ts` (interfaz `Cotizado` ~línea 29 y `procesar` ~línea 176)
- Modify: `apps/pricing-api/src/handlers/product.ts` (respuesta 200, ~línea 68)
- Test: `apps/pricing-api/tests/search-endpoint.test.ts`, `apps/pricing-api/tests/product-endpoint.test.ts`

**Interfaces:**
- Consumes: `fotoDe(producto: NormalizedProduct): string | null` y `_resetFotosForTests()` (Task 1), `guardarIndice`, `indiceVacio`.
- Produces: cada producto en `productos` (y en `sin_resultados`) de `/search`, y la respuesta de `/product`, incluyen `foto: string | null`.

- [ ] **Step 1: Write the failing tests**

En `apps/pricing-api/tests/search-endpoint.test.ts`, agregar el import arriba:

```ts
import { _resetFotosForTests, guardarIndice, indiceVacio } from '@rr/providers/fotos/indice';
```

sumar `_resetFotosForTests();` al final del `beforeEach` de `describe('GET /search')` (cada test usa otro `CATALOG_CACHE_DIR` y el indice se cachea en memoria), y agregar dentro de ese mismo `describe`:

```ts
  it('cada producto trae la foto del indice, o null', async () => {
    const indice = indiceVacio();
    // makeProduct usa mpn "MPN-<sku>" -> clave "mpnhp1|hp"
    indice.fotos['mpnhp1|hp'] = { url: 'https://storage/hp/mpnhp1.jpg', fuente: 'intcomex', obtenidaEn: 'x' };
    guardarIndice(indice);

    const res = makeRes();
    await handler(makeReq({ q: 'notebook' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    const fotos = Object.fromEntries(res.body.productos.map((p: { sku: string; foto: unknown }) => [p.sku, p.foto]));
    expect(fotos).toEqual({ HP1: 'https://storage/hp/mpnhp1.jpg', HP2: null, DE1: null });
  });
```

En `apps/pricing-api/tests/product-endpoint.test.ts`, agregar los imports:

```ts
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { _resetFotosForTests, guardarIndice, indiceVacio } from '@rr/providers/fotos/indice';
```

y dentro de `describe('GET /product/{sku}')`:

```ts
  it('la respuesta incluye la foto del indice, o null', async () => {
    vi.stubEnv('CATALOG_CACHE_DIR', mkdtempSync(join(tmpdir(), 'product-fotos-')));
    _resetFotosForTests();

    let res = makeRes();
    await productHandler(makeReq({ sku: 'HP1' }, AUTH), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.foto).toBeNull();

    const indice = indiceVacio();
    indice.fotos['2n6g5lt|hp'] = { url: 'https://storage/hp/2n6g5lt.jpg', fuente: 'icecat', obtenidaEn: 'x' };
    guardarIndice(indice);
    _resetFotosForTests();

    res = makeRes();
    await productHandler(makeReq({ sku: 'HP1' }, AUTH), res);
    expect(res.body.foto).toBe('https://storage/hp/2n6g5lt.jpg');
  });
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/pricing-api/tests/search-endpoint.test.ts apps/pricing-api/tests/product-endpoint.test.ts`
Expected: FAIL — `foto` es `undefined`.

- [ ] **Step 3: Implement**

En `search.ts`:

```ts
import { fotoDe } from '@rr/providers/fotos/indice';
// ...
interface Cotizado {
  sku: string;
  mpn: string | null;
  nombre: string | null;
  marca: string | null;
  categoria: string | null;
  precio: number;
  moneda: string;
  stock: number | null;
  foto: string | null;
}
// ... dentro de procesar(), al armar `quote`:
          stock: price.inStock,
          foto: fotoDe(p),
```

En `product.ts`, en la respuesta 200:

```ts
import { fotoDe } from '@rr/providers/fotos/indice';
// ...
      stock: price.inStock,
      foto: fotoDe(product),
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/pricing-api && npm run typecheck`
Expected: PASS todo `apps/pricing-api` (ningun test existente compara la respuesta completa, asi que el campo nuevo no rompe ninguno).

- [ ] **Step 5: Commit**

```bash
git add apps/pricing-api/src/handlers/search.ts apps/pricing-api/src/handlers/product.ts apps/pricing-api/tests/search-endpoint.test.ts apps/pricing-api/tests/product-endpoint.test.ts
git commit -m "feat(fotos): la pricing-api agrega foto a cada producto"
```

---

### Task 8: La tienda muestra la foto

**Files:**
- Modify: `apps/tienda/src/lib/catalogo.ts` (interfaz `ProductoTienda`, línea 9; `.map` ~línea 120)
- Modify: `apps/tienda/app/componentes/TarjetaProducto.tsx`
- Modify: `apps/tienda/app/globals.css` (bloque `.ficha`, ~línea 256)
- Modify: `apps/tienda/src/lib/ficha.ts` (comentario, línea 9)
- Test: `apps/tienda/tests/catalogo.test.ts`

**Interfaces:**
- Consumes: campo `foto` de la respuesta de `/search` (Task 7).
- Produces: `ProductoTienda.foto: string | null`.

- [ ] **Step 1: Write the failing test**

En `apps/tienda/tests/catalogo.test.ts`:
1. En el test de invariante (línea 47), agregar `'foto'` a la lista esperada, que queda:
   `['categoria', 'disponible', 'foto', 'marca', 'mpn', 'nombre', 'precioClp', 'precioFmt', 'precioNetoClp', 'sku']`
2. Agregar:

```ts
describe('foto', () => {
  it('pasa solo URLs https; lo demas queda null', async () => {
    conEnv();
    const productos = [
      { ...RESPUESTA.productos[0], sku: 'F1', foto: 'https://proyecto.supabase.co/storage/v1/object/public/fotos-productos/hp/x100.jpg' },
      { ...RESPUESTA.productos[0], sku: 'F2', foto: 'javascript:alert(1)' },
      { ...RESPUESTA.productos[0], sku: 'F3', foto: 'http://inseguro/x.jpg' },
      { ...RESPUESTA.productos[0], sku: 'F4' },
    ];
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...RESPUESTA, productos }), { status: 200 })));
    const r = await buscarCatalogo({ q: 'notebook' });
    expect(r?.productos.map((p) => p.foto)).toEqual([
      'https://proyecto.supabase.co/storage/v1/object/public/fotos-productos/hp/x100.jpg', null, null, null,
    ]);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/tienda/tests/catalogo.test.ts`
Expected: FAIL — el invariante no encuentra `foto` y el test nuevo recibe `undefined`.

- [ ] **Step 3: Implement**

En `catalogo.ts`, en `ProductoTienda`:

```ts
  disponible: boolean;
  /** URL publica de la foto del banco (Supabase Storage), o null: la tarjeta cae a la ficha. */
  foto: string | null;
```

y en el `.map` de `buscarCatalogo`, después de `disponible`:

```ts
          disponible: Number(p.stock ?? 0) > 0,
          // Solo https: la URL termina en un <img src>, y cualquier otra cosa
          // que llegue por la API (http, javascript:) no se pinta.
          foto: typeof p.foto === 'string' && p.foto.startsWith('https://') ? p.foto : null,
```

`TarjetaProducto.tsx` completo:

```tsx
import type { ProductoTienda } from '../../src/lib/catalogo.js';
import { leerFicha } from '../../src/lib/ficha.js';
import { BotonAgregar } from './BotonAgregar.js';

/**
 * La tarjeta: arriba la foto del banco cuando existe; debajo, la ficha. El
 * nombre del catalogo se lee como lo que ya era (identificador + specs +
 * resto) y cada pieza ocupa su lugar: marca y disponibilidad arriba, el
 * equipo al medio, el identificador y el precio abajo. Sin foto, la ficha
 * sola sigue sosteniendo la tarjeta.
 */
export function TarjetaProducto({ producto }: { producto: ProductoTienda }) {
  const ficha = leerFicha(producto.nombre, producto.marca);

  return (
    <article className="ficha">
      {producto.foto ? (
        <div className="foto">
          {/* <img> y no next/image: las fotos ya vienen a 500-640 px desde el
              banco y asi no dependemos de la optimizacion de Vercel. */}
          <img src={producto.foto} alt={ficha.titulo || producto.nombre} loading="lazy" decoding="async" />
        </div>
      ) : null}

      <div className="encabezado">
        <span className="marca-prod">{producto.marca ?? 'Sin marca'}</span>
        <span className={producto.disponible ? 'estado hay' : 'estado no'}>
          {producto.disponible ? 'En stock' : 'Por encargo'}
        </span>
      </div>

      <h3 className="titulo">{ficha.titulo || producto.nombre}</h3>

      {ficha.specs.length > 0 ? (
        <div className="specs">
          {ficha.specs.map((s) => (
            <span key={s}>{s}</span>
          ))}
        </div>
      ) : null}

      {ficha.detalle ? <p className="detalle">{ficha.detalle}</p> : null}

      <div className="pie">
        <div>
          <div className="mpn">{producto.mpn ?? producto.sku}</div>
          <div className="precio">{producto.precioFmt}</div>
          <div className="leyenda-iva">IVA incluido</div>
        </div>
        <BotonAgregar producto={producto} />
      </div>
    </article>
  );
}
```

En `globals.css`, justo después de `.ficha:hover { ... }`:

```css
/* Foto del banco: caja cuadrada con fondo blanco fijo (las fotos de catalogo
   vienen sobre blanco, tambien en tema oscuro) y contain para no recortar. */
.ficha .foto {
  aspect-ratio: 1 / 1; max-width: 100%;
  background: #fff; border-radius: var(--r-elemento);
  display: grid; place-items: center; overflow: hidden;
}
.ficha .foto img { width: 100%; height: 100%; object-fit: contain; padding: 14px; }
```

En `ficha.ts`, línea 9, reemplazar `no tiene fotos — la ficha ES la imagen del producto.` por:

```ts
 * tiene fotos para cerca de la mitad del catalogo (banco de fotos, ver
 * docs/superpowers/specs/2026-09-23-banco-fotos-design.md); para el resto, la
 * ficha sigue siendo la imagen del producto.
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/tienda && npm run typecheck`
Expected: PASS y typecheck sin errores.

- [ ] **Step 5: Commit**

```bash
git add apps/tienda/src/lib/catalogo.ts apps/tienda/app/componentes/TarjetaProducto.tsx apps/tienda/app/globals.css apps/tienda/src/lib/ficha.ts apps/tienda/tests/catalogo.test.ts
git commit -m "feat(tienda): la tarjeta muestra la foto del banco y cae a la ficha"
```

---

### Task 9: Verificación real (muestra, masiva, tienda)

**Files:** ninguno nuevo; solo ejecución y comprobación.

- [ ] **Step 1: Suite completa**

Run: `npm test && npm run typecheck`
Expected: todo PASS.

- [ ] **Step 2: Corrida de muestra**

Run: `npm run fotos -- 200`
Expected: log final `[fotos] 200 procesados · nuevas intcomex N, icecat M · …` con N + M del orden de 100 (la prueba del 22-09 proyecta ~52%). Verificar:
- `cache/fotos.json` existe y tiene ~100 entradas en `fotos`.
- `cache/fotos-faltantes.csv` existe y su primera fila de datos es un producto con `con_stock` = `si` si hay alguno.
- Abrir 3 URLs de `fotos.json` en el navegador: cargan como imagen desde `…supabase.co/storage/v1/object/public/fotos-productos/…`.

- [ ] **Step 3: Tienda local con fotos**

Con la `pricing-api` corriendo (`npm run serve`) y la tienda apuntando a ella (`PRICING_API_URL`, `PRICING_API_KEY` en su entorno), levantar `npm run dev -w @rr/tienda` y buscar una marca con fotos en la muestra (por ejemplo, un MPN de `fotos.json`). Expected: la tarjeta muestra la foto sobre fondo blanco; una tarjeta sin foto se ve igual que antes.

- [ ] **Step 4: Corrida masiva**

Run: `npm run fotos` (en segundo plano; la primera tarda horas por Icecat).
Expected: al terminar, `total con foto` cerca del 50% de las claves; el conteo `icecat_full` dice cuánto aportaría Icecat pagado. Anotar estos números en la memoria del proyecto.

- [ ] **Step 5: Reinicio del servidor de oficina**

Reiniciar la tarea `CaptadorPrecios-API` (ver memoria "Reinicio de la API de oficina": las tareas se ven solo con PowerShell elevado) para que el servidor cargue el código nuevo y dispare el banco tras su próximo refresco. Verificar en el log la línea `[fotos] …` después de `[catalog] … productos disponibles`.
