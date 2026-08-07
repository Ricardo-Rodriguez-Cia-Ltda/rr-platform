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

  it('accepts limite=0 and returns empty productos with total count', async () => {
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', limite: '0' }, AUTH), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.productos).toHaveLength(0);
    expect(res.body.total).toBe(3);
  });

  it('returns 400 for negative limite', async () => {
    getPricesMock.mockClear();
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', limite: '-1' }, AUTH), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request' });
    expect(getPricesMock).not.toHaveBeenCalled();
  });

  it('returns 400 for non-integer limite', async () => {
    getPricesMock.mockClear();
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', limite: 'abc' }, AUTH), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request' });
    expect(getPricesMock).not.toHaveBeenCalled();
  });
});
