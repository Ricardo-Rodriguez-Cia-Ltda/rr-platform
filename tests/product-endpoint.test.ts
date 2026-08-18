import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { CatalogUnavailableError } from '../lib/catalog.js';
import type { ProductoNormalizado } from '../lib/producto.js';
import { ProviderError } from '../lib/types.js';

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

const PRODUCTO: ProductoNormalizado = {
  sku: 'HP1',
  mpn: '2N6G5LT',
  nombre: 'HP ProBook 640 G8 - Notebook - 14"',
  tipo: 'Physical',
  marca: 'HP',
  categoria: 'Computadores',
  subcategorias: ['Notebooks'],
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

  it('returns 401 with a wrong x-api-key and does not touch the catalog', async () => {
    const res = makeRes();
    await productHandler(makeReq({ sku: 'HP1' }, { 'x-api-key': 'nope' }), res);
    expect(res.statusCode).toBe(401);
    expect(obtenerCatalogoMock).not.toHaveBeenCalled();
  });

  it('returns 405 for non-GET methods', async () => {
    const res = makeRes();
    await productHandler({ ...makeReq({ sku: 'HP1' }, AUTH), method: 'POST' } as VercelRequest, res);
    expect(res.statusCode).toBe(405);
    expect(res.body).toMatchObject({ error: 'method_not_allowed' });
  });

  it('returns 400 without sku', async () => {
    const res = makeRes();
    await productHandler(makeReq({}, AUTH), res);
    expect(res.statusCode).toBe(400);
  });

  // Un sku de puros espacios llega asi desde clientes que serializan campos
  // vacios; no debe pasar la validacion y caer despues como 404.
  it('returns 400 for a whitespace-only sku', async () => {
    const res = makeRes();
    await productHandler(makeReq({ sku: '   ' }, AUTH), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request' });
  });

  it('returns 503 when the catalog is not loaded yet', async () => {
    obtenerCatalogoMock.mockImplementation(() => {
      throw new CatalogUnavailableError();
    });

    const res = makeRes();
    await productHandler(makeReq({ sku: 'HP1' }, AUTH), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'catalogo_no_disponible' });
    expect(getPricesMock).not.toHaveBeenCalled();
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

  // I3: fallas upstream deben quedar logueadas y el detail debe conservar el
  // mensaje que trae el status (no solo el cuerpo crudo de Intcomex).
  it('logs upstream failures and keeps the status-bearing message in detail on 502', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getPricesMock.mockRejectedValue(
      new ProviderError('upstream', 'Intcomex responded with HTTP 500', 'raw body'),
    );

    const res = makeRes();
    await productHandler(makeReq({ sku: 'HP1' }, AUTH), res);

    expect(res.statusCode).toBe(502);
    expect(res.body.detail).toContain('HTTP 500');
    expect(res.body.upstream).toBe('raw body');
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
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

  it('returns 401 with a wrong x-api-key and does not touch the catalog', async () => {
    const res = makeRes();
    await facetasHandler(makeReq({}, { 'x-api-key': 'nope' }), res);
    expect(res.statusCode).toBe(401);
    expect(obtenerCatalogoMock).not.toHaveBeenCalled();
  });

  it('returns 405 for non-GET methods', async () => {
    const res = makeRes();
    await facetasHandler({ ...makeReq({}, AUTH), method: 'POST' } as VercelRequest, res);
    expect(res.statusCode).toBe(405);
    expect(res.body).toMatchObject({ error: 'method_not_allowed' });
  });

  it('returns 503 when the catalog is not loaded yet', async () => {
    obtenerCatalogoMock.mockImplementation(() => {
      throw new CatalogUnavailableError();
    });

    const res = makeRes();
    await facetasHandler(makeReq({}, AUTH), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'catalogo_no_disponible' });
  });
});
