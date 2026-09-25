import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { NormalizedProduct } from '@rr/domain/product';
import type { PriceInfo, Provider } from '@rr/domain/types';
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
