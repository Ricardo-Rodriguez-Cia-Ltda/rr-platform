import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { resetPriceCachesForTests } from '@rr/providers/price-cache';
import type { NormalizedProduct } from '@rr/domain/product';

const getCatalogMock = vi.fn();
const getPricesMock = vi.fn();

vi.mock('@rr/providers/catalog', async () => {
  const actual = await vi.importActual<typeof import('@rr/providers/catalog')>('@rr/providers/catalog');
  return { ...actual, getCatalog: () => getCatalogMock() };
});

vi.mock('@rr/providers/intcomex', () => ({
  loadIntcomexCatalog: async () => [],
  getPrices: (skus: string[]) => getPricesMock(skus),
  intcomex: {
    name: 'intcomex',
    maxSkusPerBatch: 100,
    isConfigured: () =>
      Boolean(
        process.env.INTCOMEX_API_KEY &&
          process.env.INTCOMEX_ACCESS_KEY &&
          process.env.INTCOMEX_BASE_URL,
      ),
    loadCatalog: async () => [],
    getPrices: (skus: string[]) => getPricesMock(skus),
    getPrice: async () => {
      throw new Error('no usado');
    },
  },
}));

const { default: aliasSearch } = await import('../api/search.js');
const { default: searchByRoute } = await import('../api/[proveedor]/search.js');
const { default: productByRoute } = await import('../api/[proveedor]/product.js');
const { default: facetasByRoute } = await import('../api/[proveedor]/facetas.js');

function makeProduct(sku: string, name: string): NormalizedProduct {
  return {
    sku,
    mpn: `MPN-${sku}`,
    nombre: name,
    marca: 'HP',
    categoria: 'Computadores',
    subcategorias: [],
    tipo: null,
  };
}

const CATALOG = [makeProduct('HP1', 'HP ProBook 640 Notebook 14"')];

function makeReq(
  query: Record<string, string>,
  headers: Record<string, string> = {},
  method = 'GET',
): VercelRequest {
  return { query, headers, method } as unknown as VercelRequest;
}

function makeRes(): VercelResponse & { statusCode: number; body: any } {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

const AUTH = { 'x-api-key': 'test-secret' };

beforeEach(() => {
  vi.stubEnv('API_SECRET_KEY', 'test-secret');
  vi.stubEnv('INTCOMEX_API_KEY', 'pub');
  vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret');
  vi.stubEnv('INTCOMEX_BASE_URL', 'https://x/');
  // search ahora conversa con el cache de precios en disco; aislado para no
  // leer ni escribir el cache real del repo durante los tests.
  vi.stubEnv('CATALOG_CACHE_DIR', mkdtempSync(join(tmpdir(), 'provider-routes-cache-')));
  resetPriceCachesForTests();
  getCatalogMock.mockReset().mockReturnValue(CATALOG);
  getPricesMock
    .mockReset()
    .mockResolvedValue(new Map([['HP1', { price: 1000, currency: 'us', inStock: 5 }]]));
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('rutas /api/{proveedor}/...', () => {
  // El alias existe para que Rayo no se entere del cambio: si las dos rutas
  // divergen, el agente empieza a recibir algo distinto sin que nadie lo pida.
  it('sirve /api/intcomex/search identico al alias /api/search', async () => {
    const resAlias = makeRes();
    await aliasSearch(makeReq({ q: 'probook' }, AUTH), resAlias);

    // La primera llamada dejo HP1 en cache: sin reaislar, la segunda lo
    // serviria fresco y ganaria `precios_de_hace_min`, que no es lo que esta
    // prueba compara (paridad de rutas, no el cache).
    vi.stubEnv('CATALOG_CACHE_DIR', mkdtempSync(join(tmpdir(), 'provider-routes-cache-')));
    resetPriceCachesForTests();

    const resByRoute = makeRes();
    await searchByRoute(makeReq({ proveedor: 'intcomex', q: 'probook' }, AUTH), resByRoute);

    expect(resByRoute.statusCode).toBe(resAlias.statusCode);
    expect(resByRoute.body).toEqual(resAlias.body);
  });

  it('404 proveedor_desconocido para un proveedor que no existe', async () => {
    const res = makeRes();
    await searchByRoute(makeReq({ proveedor: 'nadie', q: 'notebook' }, AUTH), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'proveedor_desconocido', proveedor: 'nadie' });
  });

  // Va a pasar todo el tiempo mientras TI no entregue credenciales: tiene que
  // distinguirse de "el proveedor esta caido", que es 502.
  it('503 proveedor_no_configurado cuando faltan credenciales', async () => {
    vi.stubEnv('INTCOMEX_API_KEY', '');
    const res = makeRes();
    await searchByRoute(makeReq({ proveedor: 'intcomex', q: 'notebook' }, AUTH), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'proveedor_no_configurado', proveedor: 'intcomex' });
  });

  it('valida la api key antes de mirar el proveedor', async () => {
    const res = makeRes();
    await searchByRoute(makeReq({ proveedor: 'nadie', q: 'notebook' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('rechaza metodos que no son GET antes de resolver el proveedor', async () => {
    const res = makeRes();
    await searchByRoute(makeReq({ proveedor: 'nadie', q: 'x' }, AUTH, 'POST'), res);
    expect(res.statusCode).toBe(405);
  });

  it('/api/{proveedor}/product responde la ficha del proveedor de la ruta', async () => {
    const res = makeRes();
    await productByRoute(makeReq({ proveedor: 'intcomex', sku: 'HP1' }, AUTH), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ sku: 'HP1', precio: 1000 });
  });

  it('/api/{proveedor}/facetas responde las facetas del proveedor de la ruta', async () => {
    const res = makeRes();
    await facetasByRoute(makeReq({ proveedor: 'intcomex' }, AUTH), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.total_productos).toBe(1);
  });

  it.each([
    ['product', productByRoute],
    ['facetas', facetasByRoute],
  ])('%s tambien devuelve proveedor_desconocido con el proveedor en el cuerpo', async (_n, h) => {
    const res = makeRes();
    await h(makeReq({ proveedor: 'nadie', sku: 'HP1' }, AUTH), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'proveedor_desconocido', proveedor: 'nadie' });
  });
});
