import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { CatalogUnavailableError } from '@rr/providers/catalog';
import { resetPriceCachesForTests } from '@rr/providers/price-cache';
import type { NormalizedProduct } from '@rr/domain/product';
import { ProviderError } from '@rr/domain/types';

// Contrato transversal de errores.
//
// Los cuatro endpoints GET responden el mismo sobre { error, detail } y el
// agente que los consume decide que hacer mirando `error`. Cada test de
// endpoint verifica su propio caso, pero nadie verificaba la forma comun: un
// handler nuevo puede devolver { message } o { error: 'Bad Request' } y toda
// la suite sigue verde mientras el consumidor se rompe.

const getCatalogMock = vi.fn();
const getPricesMock = vi.fn();
const getPriceMock = vi.fn();

vi.mock('@rr/providers/catalog', async () => {
  const actual = await vi.importActual<typeof import('@rr/providers/catalog')>('@rr/providers/catalog');
  return { ...actual, getCatalog: () => getCatalogMock() };
});

vi.mock('@rr/providers/intcomex', () => ({
  loadIntcomexCatalog: async () => [],
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
    getPrice: (query: unknown) => getPriceMock(query),
  },
  getPrices: (skus: string[]) => getPricesMock(skus),
}));

const { default: searchHandler } = await import('../api/search.js');
const { default: productHandler } = await import('../api/product.js');
const { default: facetasHandler } = await import('../api/facetas.js');
const { default: priceHandler } = await import('../api/price.js');
const { default: searchByRouteHandler } = await import('../api/[proveedor]/search.js');
const { default: mejorPrecioHandler } = await import('../api/mejor-precio.js');

type Handler = (req: VercelRequest, res: VercelResponse) => Promise<void>;

// Una clave con forma de secreto real: si algun handler la refleja en la
// respuesta, el assert de fuga lo detecta.
const SECRET = 'k3y-de-prueba-no-filtrar';
const AUTH = { 'x-api-key': SECRET };

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
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
  };
  return res;
}

function catalogNotLoaded(): void {
  getCatalogMock.mockImplementation(() => {
    throw new CatalogUnavailableError();
  });
}

interface Case {
  name: string;
  handler: Handler;
  req: VercelRequest;
  status: number;
  error: string;
  before?: () => void;
}

const CASES: Case[] = [
  // --- /api/price ---
  { name: 'price sin x-api-key', handler: priceHandler, req: makeReq({ sku: 'HP1' }), status: 401, error: 'unauthorized' },
  { name: 'price con x-api-key incorrecta', handler: priceHandler, req: makeReq({ sku: 'HP1' }, { 'x-api-key': 'nope' }), status: 401, error: 'unauthorized' },
  { name: 'price sin identificador', handler: priceHandler, req: makeReq({}, AUTH), status: 400, error: 'bad_request' },
  { name: 'price con dos identificadores', handler: priceHandler, req: makeReq({ sku: 'HP1', mpn: 'X' }, AUTH), status: 400, error: 'bad_request' },
  { name: 'price con proveedor desconocido', handler: priceHandler, req: makeReq({ sku: 'HP1', provider: 'nadie' }, AUTH), status: 400, error: 'bad_request' },
  {
    name: 'price cuando el proveedor no encuentra el producto',
    handler: priceHandler,
    req: makeReq({ sku: 'HP1' }, AUTH),
    status: 404,
    error: 'not_found',
    before: () => getPriceMock.mockRejectedValue(new ProviderError('not_found', 'Product not found at Intcomex')),
  },
  {
    name: 'price cuando el proveedor falla',
    handler: priceHandler,
    req: makeReq({ sku: 'HP1' }, AUTH),
    status: 502,
    error: 'upstream',
    before: () => getPriceMock.mockRejectedValue(new ProviderError('upstream', 'Intcomex responded with HTTP 500')),
  },
  {
    name: 'price ante un error inesperado',
    handler: priceHandler,
    req: makeReq({ sku: 'HP1' }, AUTH),
    status: 502,
    error: 'upstream',
    before: () => getPriceMock.mockRejectedValue(new Error('ECONNRESET')),
  },
  { name: 'price con metodo POST', handler: priceHandler, req: makeReq({ sku: 'HP1' }, AUTH, 'POST'), status: 405, error: 'method_not_allowed' },

  // --- /api/search ---
  { name: 'search sin x-api-key', handler: searchHandler, req: makeReq({ q: 'notebook' }), status: 401, error: 'unauthorized' },
  { name: 'search sin q', handler: searchHandler, req: makeReq({}, AUTH), status: 400, error: 'bad_request' },
  { name: 'search con q sin terminos buscables', handler: searchHandler, req: makeReq({ q: '---' }, AUTH), status: 400, error: 'bad_request' },
  { name: 'search con limite invalido', handler: searchHandler, req: makeReq({ q: 'notebook', limite: '-1' }, AUTH), status: 400, error: 'bad_request' },
  { name: 'search con precio_max invalido', handler: searchHandler, req: makeReq({ q: 'notebook', precio_max: 'abc' }, AUTH), status: 400, error: 'bad_request' },
  {
    name: 'search con una consulta demasiado amplia',
    handler: searchHandler,
    req: makeReq({ q: 'notebook' }, AUTH),
    status: 409,
    error: 'demasiado_amplio',
    before: () =>
      getCatalogMock.mockReturnValue(
        Array.from({ length: 30 }, (_, i) => makeProduct(`S${i}`, `Notebook generico ${i}`)),
      ),
  },
  { name: 'search con el catalogo sin cargar', handler: searchHandler, req: makeReq({ q: 'notebook' }, AUTH), status: 503, error: 'catalogo_no_disponible', before: catalogNotLoaded },
  {
    name: 'search cuando el proveedor falla',
    handler: searchHandler,
    req: makeReq({ q: 'notebook' }, AUTH),
    status: 502,
    error: 'upstream',
    before: () => getPricesMock.mockRejectedValue(new ProviderError('upstream', 'Intcomex responded with HTTP 500')),
  },
  { name: 'search con metodo POST', handler: searchHandler, req: makeReq({ q: 'notebook' }, AUTH, 'POST'), status: 405, error: 'method_not_allowed' },

  // --- /api/product ---
  { name: 'product sin x-api-key', handler: productHandler, req: makeReq({ sku: 'HP1' }), status: 401, error: 'unauthorized' },
  { name: 'product sin sku', handler: productHandler, req: makeReq({}, AUTH), status: 400, error: 'bad_request' },
  { name: 'product con un sku desconocido', handler: productHandler, req: makeReq({ sku: 'NOEXISTE' }, AUTH), status: 404, error: 'not_found' },
  {
    name: 'product cuando el proveedor no entrega precio',
    handler: productHandler,
    req: makeReq({ sku: 'HP1' }, AUTH),
    status: 404,
    error: 'not_found',
    before: () => getPricesMock.mockResolvedValue(new Map()),
  },
  { name: 'product con el catalogo sin cargar', handler: productHandler, req: makeReq({ sku: 'HP1' }, AUTH), status: 503, error: 'catalogo_no_disponible', before: catalogNotLoaded },
  {
    name: 'product cuando el proveedor falla',
    handler: productHandler,
    req: makeReq({ sku: 'HP1' }, AUTH),
    status: 502,
    error: 'upstream',
    before: () => getPricesMock.mockRejectedValue(new ProviderError('upstream', 'Intcomex responded with HTTP 500')),
  },
  { name: 'product con metodo POST', handler: productHandler, req: makeReq({ sku: 'HP1' }, AUTH, 'POST'), status: 405, error: 'method_not_allowed' },

  // --- /api/facetas ---
  { name: 'facetas sin x-api-key', handler: facetasHandler, req: makeReq({}), status: 401, error: 'unauthorized' },
  { name: 'facetas con el catalogo sin cargar', handler: facetasHandler, req: makeReq({}, AUTH), status: 503, error: 'catalogo_no_disponible', before: catalogNotLoaded },
  { name: 'facetas con metodo POST', handler: facetasHandler, req: makeReq({}, AUTH, 'POST'), status: 405, error: 'method_not_allowed' },

  // --- /api/{proveedor}/... ---
  // El prefijo 'search' no es decorativo: el test de cobertura de abajo deriva
  // el endpoint del primer token del nombre.
  {
    name: 'search proveedor desconocido en la ruta',
    handler: searchByRouteHandler,
    req: makeReq({ proveedor: 'nadie', q: 'notebook' }, AUTH),
    status: 404,
    error: 'proveedor_desconocido',
  },
  {
    name: 'search proveedor sin credenciales',
    handler: searchByRouteHandler,
    req: makeReq({ proveedor: 'intcomex', q: 'notebook' }, AUTH),
    status: 503,
    error: 'proveedor_no_configurado',
    before: () => vi.stubEnv('INTCOMEX_API_KEY', ''),
  },

  // --- /api/mejor-precio ---
  { name: 'mejor-precio sin x-api-key', handler: mejorPrecioHandler, req: makeReq({ mpn: 'X' }), status: 401, error: 'unauthorized' },
  { name: 'mejor-precio sin identificador', handler: mejorPrecioHandler, req: makeReq({}, AUTH), status: 400, error: 'bad_request' },
  { name: 'mejor-precio con metodo POST', handler: mejorPrecioHandler, req: makeReq({ mpn: 'X' }, AUTH, 'POST'), status: 405, error: 'method_not_allowed' },
];

describe('contrato de errores de la API', () => {
  beforeEach(() => {
    vi.stubEnv('API_SECRET_KEY', SECRET);
    vi.stubEnv('INTCOMEX_API_KEY', 'pub');
    vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret');
    vi.stubEnv('INTCOMEX_BASE_URL', 'https://x/');
    // search ahora conversa con el cache de precios en disco; sin aislarlo,
    // el cache real del repo (cache/prices-intcomex.json) puede filtrar HP1
    // como "fresco" y esconder el 502 que este contrato verifica.
    vi.stubEnv('CATALOG_CACHE_DIR', mkdtempSync(join(tmpdir(), 'error-contract-cache-')));
    resetPriceCachesForTests();
    // Silencia los console.error de los caminos 502, que son esperados aca.
    vi.spyOn(console, 'error').mockImplementation(() => {});

    getCatalogMock.mockReset().mockReturnValue([makeProduct('HP1', 'HP ProBook 640 Notebook 14"')]);
    getPricesMock.mockReset().mockResolvedValue(
      new Map([['HP1', { price: 1000, currency: 'us', inStock: 5 }]]),
    );
    getPriceMock.mockReset().mockResolvedValue({
      provider: 'intcomex',
      sku: 'HP1',
      mpn: 'MPN-HP1',
      description: 'HP ProBook 640 Notebook 14"',
      price: 1000,
      currency: 'US',
      inStock: 5,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each(CASES)('$name responde $status con el sobre { error, detail }', async (testCase) => {
    testCase.before?.();

    const res = makeRes();
    await testCase.handler(testCase.req, res);

    expect(res.statusCode).toBe(testCase.status);
    expect(res.body.error).toBe(testCase.error);

    // `error` es un codigo estable en snake_case, no una frase para humanos:
    // el consumidor ramifica sobre el.
    expect(res.body.error).toMatch(/^[a-z][a-z0-9_]*$/);

    // `detail` es la explicacion legible, y siempre viene.
    expect(typeof res.body.detail).toBe('string');
    expect(res.body.detail.length).toBeGreaterThan(0);

    // Ninguna respuesta de error puede devolver la clave de la API.
    expect(JSON.stringify(res.body)).not.toContain(SECRET);
  });

  it('cubre los cinco endpoints GET', () => {
    const covered = new Set(CASES.map((c) => c.name.split(' ')[0]));
    expect([...covered].sort()).toEqual(['facetas', 'mejor-precio', 'price', 'product', 'search']);
  });
});
