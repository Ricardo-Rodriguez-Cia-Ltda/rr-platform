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
    // Lo que se cobra es del ganador; lo descriptivo, del representante (Intcomex).
    expect(r.body.productos[0]).toMatchObject({
      sku: 'G1', proveedor: 'ingram', precio: 93.49, stock: 16, moneda: 'USD',
      nombre: 'Intel Core i5 14100F', marca: 'Intel', categoria: 'Procesadores', mpn: 'BX8071514100F',
    });
  });

  it('completa el grupo con la misma clave aunque el otro mayorista no calce por texto ni categoria', async () => {
    catalogos.intcomex = [prod('I1', 'CF258A', 'Toner negro 58A', 'HP', 'Toner')];
    catalogos.ingram = [prod('G1', 'CF258A', 'HP 58A BLACK LJ CARTRIDGE', 'HP INC', 'Supplies & Accessories')];
    const ingram = proveedor('ingram', { G1: P(40, 5) });
    const h = createMultiSearchHandler({ intcomex: proveedor('intcomex', { I1: P(50, 3) }), ingram });
    const r = res();
    await h(req({ q: 'toner', categoria: 'Toner', solo_con_stock: 'true' }), r);
    expect(r.statusCode).toBe(200);
    expect(r.body.total).toBe(1);
    expect(r.body.productos[0]).toMatchObject({ sku: 'G1', proveedor: 'ingram', precio: 40, nombre: 'Toner negro 58A', categoria: 'Toner' });
    expect(ingram.getPrices).toHaveBeenCalledWith(['G1']);
  });

  it('no cotiza la segunda ronda si la sonda ya junta el limite', async () => {
    catalogos.intcomex = Array.from({ length: 80 }, (_, i) => prod(`I${i}`, `M${i}`, `Toner ${i}`, 'HP', 'Toner'));
    const precios = Object.fromEntries(catalogos.intcomex.map((p) => [p.sku, P(10, 5)]));
    const intcomex = proveedor('intcomex', precios);
    const r = res();
    await createMultiSearchHandler({ intcomex })(req({ q: 'toner', marca: 'HP', solo_con_stock: 'true', limite: '10' }), r);
    expect(r.body.productos).toHaveLength(10);
    expect(r.body.evaluados).toBe(50);
    expect(vi.mocked(intcomex.getPrices).mock.calls.flatMap(([skus]) => skus)).toHaveLength(50);
  });

  it('cotiza la segunda ronda si la sonda no junta el limite', async () => {
    catalogos.intcomex = Array.from({ length: 80 }, (_, i) => prod(`I${i}`, `M${i}`, `Toner ${i}`, 'HP', 'Toner'));
    // Los 50 primeros no tienen stock; recien en la segunda ronda aparecen.
    const precios = Object.fromEntries(catalogos.intcomex.map((p, i) => [p.sku, P(10, i < 50 ? 0 : 5)]));
    const intcomex = proveedor('intcomex', precios);
    const r = res();
    await createMultiSearchHandler({ intcomex })(req({ q: 'toner', marca: 'HP', solo_con_stock: 'true', limite: '10' }), r);
    expect(r.body.productos).toHaveLength(10);
    expect(r.body.evaluados).toBe(80);
    expect(vi.mocked(intcomex.getPrices).mock.calls.flatMap(([skus]) => skus)).toHaveLength(80);
  });

  it('ignora mayoristas sin configurar', async () => {
    catalogos.intcomex = [prod('I1', 'A1', 'Toner negro', 'HP', 'Toner')];
    catalogos.ingram = [prod('G1', 'A1', 'Toner negro', 'HP', 'Toner')];
    const ingram = { ...proveedor('ingram', { G1: P(1, 9) }), isConfigured: () => false } as Provider;
    const r = res();
    await createMultiSearchHandler({ intcomex: proveedor('intcomex', { I1: P(50, 3) }), ingram })(req({ q: 'toner' }), r);
    expect(r.body.productos[0].proveedor).toBe('intcomex');
    expect(r.body.parcial).toBeUndefined();
    expect(ingram.getPrices).not.toHaveBeenCalled();
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

  it('un mayorista caido no marca parcial si el ganador con stock lo tapa, pero avisa el proveedor incompleto', async () => {
    catalogos.intcomex = [prod('I1', 'A1', 'Toner negro', 'HP', 'Toner')];
    catalogos.ingram = [prod('G1', 'A1', 'Toner negro', 'HP', 'Toner')];
    const h = createMultiSearchHandler({
      intcomex: proveedor('intcomex', { I1: P(50, 3) }),
      ingram: proveedor('ingram', {}, true),
    });
    const r = res();
    await h(req({ q: 'toner' }), r);
    expect(r.statusCode).toBe(200);
    expect(r.body.parcial).toBeUndefined();
    expect(r.body.proveedores_incompletos).toEqual(['ingram']);
    expect(r.body.productos[0].proveedor).toBe('intcomex');
  });

  it('un mayorista caido SI marca parcial cuando el ganador no tiene stock', async () => {
    catalogos.intcomex = [prod('I1', 'A1', 'Toner negro', 'HP', 'Toner')];
    catalogos.ingram = [prod('G1', 'A1', 'Toner negro', 'HP', 'Toner')];
    const h = createMultiSearchHandler({
      intcomex: proveedor('intcomex', { I1: P(50, 0) }),
      ingram: proveedor('ingram', {}, true),
    });
    const r = res();
    await h(req({ q: 'toner' }), r);
    expect(r.statusCode).toBe(200);
    expect(r.body.parcial).toBe(true);
    expect(r.body.proveedores_incompletos).toEqual(['ingram']);
    expect(r.body.productos[0].proveedor).toBe('intcomex');
  });

  it('un mayorista caido SI marca parcial cuando un grupo solo existe en el que cayo', async () => {
    catalogos.intcomex = [prod('I1', 'A1', 'Toner negro', 'HP', 'Toner')];
    catalogos.ingram = [prod('G1', 'B2', 'Mouse inalambrico', 'HP', 'Perifericos')];
    const h = createMultiSearchHandler({
      intcomex: proveedor('intcomex', { I1: P(50, 3) }),
      ingram: proveedor('ingram', {}, true),
    });
    const r = res();
    await h(req({ q: 'toner mouse' }), r);
    expect(r.statusCode).toBe(200);
    expect(r.body.parcial).toBe(true);
    expect(r.body.proveedores_incompletos).toEqual(['ingram']);
    // El grupo de Intcomex sigue mostrandose, con o sin stock del caido.
    expect(r.body.productos.map((p: any) => p.proveedor)).toEqual(['intcomex']);
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
