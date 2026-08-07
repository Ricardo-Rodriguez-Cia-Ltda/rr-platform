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
