import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { CatalogUnavailableError } from '@rr/providers/catalog';
import { resetPriceCachesForTests } from '@rr/providers/price-cache';
import type { NormalizedProduct } from '@rr/domain/product';
import { ProviderError } from '@rr/domain/types';

const getCatalogMock = vi.fn();
const getPricesMock = vi.fn();

vi.mock('@rr/providers/catalog', async () => {
  const actual = await vi.importActual<typeof import('@rr/providers/catalog')>('@rr/providers/catalog');
  return { ...actual, getCatalog: () => getCatalogMock() };
});

vi.mock('@rr/providers/intcomex', () => ({
  getPrices: (skus: string[]) => getPricesMock(skus),
  loadIntcomexCatalog: async () => [],
  intcomex: {
    name: 'intcomex',
    maxSkusPerBatch: 100,
    isConfigured: () => true,
    loadCatalog: async () => [],
    getPrices: (skus: string[]) => getPricesMock(skus),
    getPrice: async () => {
      throw new Error('no usado');
    },
  },
}));

const { default: handler } = await import('../api/search.js');

function makeProduct(
  sku: string,
  name: string,
  brand: string,
  category: string,
): NormalizedProduct {
  return {
    sku,
    mpn: `MPN-${sku}`,
    nombre: name,
    marca: brand,
    categoria: category,
    subcategorias: [],
    tipo: null,
  };
}

const CATALOG = [
  makeProduct('HP1', 'HP ProBook 640 Notebook 14"', 'HP', 'Computadores'),
  makeProduct('HP2', 'HP EliteBook 840 Notebook 14"', 'HP', 'Computadores'),
  makeProduct('DE1', 'Dell Latitude Notebook 15"', 'Dell', 'Computadores'),
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
    vi.stubEnv('CATALOG_CACHE_DIR', mkdtempSync(join(tmpdir(), 'search-cache-')));
    resetPriceCachesForTests();
    getCatalogMock.mockReset().mockReturnValue(CATALOG);
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

  it('returns 401 with a wrong x-api-key and does not touch the catalog', async () => {
    const res = makeRes();
    await handler(makeReq({ q: 'hp' }, { 'x-api-key': 'nope' }), res);
    expect(res.statusCode).toBe(401);
    expect(getCatalogMock).not.toHaveBeenCalled();
  });

  it('returns 405 for non-GET methods', async () => {
    const res = makeRes();
    await handler({ ...makeReq({ q: 'hp' }, AUTH), method: 'POST' } as VercelRequest, res);
    expect(res.statusCode).toBe(405);
    expect(res.body).toMatchObject({ error: 'method_not_allowed' });
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
    const large = Array.from({ length: 30 }, (_, i) =>
      makeProduct(`S${i}`, `Notebook generico ${i}`, i % 2 === 0 ? 'HP' : 'Dell', 'Computadores'),
    );
    getCatalogMock.mockReturnValue(large);

    const res = makeRes();
    await handler(makeReq({ q: 'notebook' }, AUTH), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'demasiado_amplio', total: 30 });
    expect(res.body.facetas.marca).toContainEqual({ valor: 'HP', n: 15 });
    expect(getPricesMock).not.toHaveBeenCalled();
  });

  it('does not trigger 409 when marca is provided', async () => {
    const large = Array.from({ length: 30 }, (_, i) =>
      makeProduct(`S${i}`, `Notebook generico ${i}`, 'HP', 'Computadores'),
    );
    getCatalogMock.mockReturnValue(large);
    getPricesMock.mockResolvedValue(new Map());

    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP' }, AUTH), res);
    expect(res.statusCode).toBe(200);
  });

  it('returns 503 when the catalog is not loaded yet', async () => {
    getCatalogMock.mockImplementation(() => {
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

  // C2: precio_max vacío (comun en clientes HTTP / serializadores de tools de LLM)
  // no debe interpretarse como "precio_max=0" y filtrar todo.
  it('treats an empty precio_max as "no filter" instead of collapsing all results', async () => {
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', precio_max: '' }, AUTH), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.productos.length).toBeGreaterThan(0);
  });

  it('treats a whitespace-only precio_max as "no filter"', async () => {
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', precio_max: '   ' }, AUTH), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.productos.length).toBeGreaterThan(0);
  });

  it('returns 400 for a non-numeric precio_max and does not call getPrices', async () => {
    getPricesMock.mockClear();
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', precio_max: 'abc' }, AUTH), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request' });
    expect(getPricesMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a negative precio_max and does not call getPrices', async () => {
    getPricesMock.mockClear();
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', precio_max: '-5' }, AUTH), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request' });
    expect(getPricesMock).not.toHaveBeenCalled();
  });

  it('returns 400 for a zero precio_max and does not call getPrices', async () => {
    getPricesMock.mockClear();
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', precio_max: '0' }, AUTH), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request' });
    expect(getPricesMock).not.toHaveBeenCalled();
  });

  // I5: una consulta de solo puntuación tokeniza a [] y calzaría con todo el catálogo.
  it('returns 400 for a query that tokenizes to nothing (pure punctuation) and does not call getPrices', async () => {
    getPricesMock.mockClear();
    const res = makeRes();
    await handler(makeReq({ q: '---' }, AUTH), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request' });
    expect(getPricesMock).not.toHaveBeenCalled();
  });

  // I4: la faceta de precio, prometida por el spec, debe viajar en el 200.
  it('returns facetas.precio with the min/max of the returned products on a 200', async () => {
    const res = makeRes();
    await handler(makeReq({ q: 'notebook' }, AUTH), res);
    expect(res.statusCode).toBe(200);
    const prices = res.body.productos.map((p: any) => p.precio);
    expect(res.body.facetas.precio).toEqual({
      min: Math.min(...prices),
      max: Math.max(...prices),
    });
  });

  it('does not include facetas.precio on a 409 (no upstream calls happen on that path)', async () => {
    const large = Array.from({ length: 30 }, (_, i) =>
      makeProduct(`S${i}`, `Notebook generico ${i}`, i % 2 === 0 ? 'HP' : 'Dell', 'Computadores'),
    );
    getCatalogMock.mockReturnValue(large);

    const res = makeRes();
    await handler(makeReq({ q: 'notebook' }, AUTH), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.facetas.precio).toBeUndefined();
  });

  // I3: fallas upstream deben quedar logueadas y el detail debe conservar el
  // mensaje que trae el status (no solo el cuerpo crudo de Intcomex).
  it('logs upstream failures and keeps the status-bearing message in detail on 502', async () => {
    const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    getPricesMock.mockRejectedValue(
      new ProviderError('upstream', 'Intcomex responded with HTTP 500', 'raw body'),
    );

    const res = makeRes();
    await handler(makeReq({ q: 'notebook' }, AUTH), res);

    expect(res.statusCode).toBe(502);
    expect(res.body.detail).toContain('HTTP 500');
    expect(res.body.upstream).toBe('raw body');
    expect(consoleErrorSpy).toHaveBeenCalled();

    consoleErrorSpy.mockRestore();
  });

  // Ledger: el umbral de ambigüedad (25) debe ser estrictamente ">", no ">=".
  it('returns 200 (not 409) at exactly the ambiguity threshold (25 matches)', async () => {
    const exact = Array.from({ length: 25 }, (_, i) =>
      makeProduct(`T${i}`, `Notebook generico ${i}`, 'HP', 'Computadores'),
    );
    getCatalogMock.mockReturnValue(exact);
    getPricesMock.mockResolvedValue(new Map());

    const res = makeRes();
    await handler(makeReq({ q: 'notebook' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(25);
  });

  it('returns 409 just past the ambiguity threshold (26 matches)', async () => {
    const justPast = Array.from({ length: 26 }, (_, i) =>
      makeProduct(`T${i}`, `Notebook generico ${i}`, 'HP', 'Computadores'),
    );
    getCatalogMock.mockReturnValue(justPast);

    const res = makeRes();
    await handler(makeReq({ q: 'notebook' }, AUTH), res);

    expect(res.statusCode).toBe(409);
    expect(res.body.total).toBe(26);
  });
});

// --- Paginado de candidatos cuando hay filtros activos ---
//
// Los filtros de precio y stock solo pueden aplicarse despues de cotizar, asi
// que si solo miramos los primeros 50 candidatos una busqueda con filtros
// devuelve vacio aunque mas abajo si haya productos que cumplen. Medido contra
// el catalogo real: solo el 27% de los productos tiene stock.
describe('GET /search — paginado con filtros', () => {
  // 250 productos "notebook" de la misma marca: sin el paginado, los que
  // cumplen (los ultimos) quedan fuera de la ventana de candidatos.
  const LARGE_CATALOG = Array.from({ length: 250 }, (_, i) =>
    makeProduct(`S${i}`, `Notebook generico ${i}`, 'HP', 'Computadores'),
  );

  // Solo los SKUs a partir del 150 tienen stock; todos valen 100.
  function pricesForBatch(skus: string[]) {
    return new Map(
      skus.map((sku) => {
        const n = Number(sku.slice(1));
        return [sku, { price: 100, currency: 'us', inStock: n >= 150 ? 7 : 0 }];
      }),
    );
  }

  beforeEach(() => {
    vi.stubEnv('API_SECRET_KEY', 'test-secret');
    vi.stubEnv('CATALOG_CACHE_DIR', mkdtempSync(join(tmpdir(), 'search-cache-')));
    resetPriceCachesForTests();
    getCatalogMock.mockReset().mockReturnValue(LARGE_CATALOG);
    getPricesMock.mockReset().mockImplementation((skus: string[]) => Promise.resolve(pricesForBatch(skus)));
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sigue cotizando lotes hasta encontrar productos que pasen el filtro de stock', async () => {
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', limite: '3' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.productos).toHaveLength(3);
    expect(res.body.productos.every((p: any) => p.stock > 0)).toBe(true);
    // Necesita mas de un lote: los que tienen stock empiezan en el indice 150.
    expect(getPricesMock.mock.calls.length).toBeGreaterThan(1);
  });

  it('informa cuantos candidatos alcanzo a cotizar', async () => {
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', limite: '3' }, AUTH), res);
    expect(res.body.evaluados).toBeGreaterThanOrEqual(200);
  });

  it('no pagina cuando no hay filtros activos (una sola llamada)', async () => {
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', limite: '3' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(getPricesMock).toHaveBeenCalledTimes(1);
  });

  it('deja de cotizar apenas junta el limite pedido', async () => {
    // Con stock desde el indice 0, el primer lote basta.
    getPricesMock.mockImplementation((skus: string[]) =>
      Promise.resolve(new Map(skus.map((sku) => [sku, { price: 100, currency: 'us', inStock: 5 }]))),
    );
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', limite: '2' }, AUTH), res);

    expect(res.body.productos).toHaveLength(2);
    expect(getPricesMock).toHaveBeenCalledTimes(1);
  });

  it('cuando nada pasa los filtros explica por que y ofrece una alternativa', async () => {
    // Ningun producto tiene stock.
    getPricesMock.mockImplementation((skus: string[]) =>
      Promise.resolve(
        new Map(skus.map((sku) => [sku, { price: Number(sku.slice(1)) + 500, currency: 'us', inStock: 0 }])),
      ),
    );
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', limite: '3' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.productos).toHaveLength(0);
    expect(res.body.sin_resultados.motivo).toBe('sin_stock');
    // La alternativa es el mas barato de los evaluados, aunque no cumpla.
    expect(res.body.sin_resultados.alternativa.precio).toBe(500);
    expect(res.body.sin_resultados.alternativa.sku).toBe('S0');
  });

  it('distingue el caso de presupuesto insuficiente', async () => {
    // Hay stock, pero todos cuestan mas que el tope pedido.
    getPricesMock.mockImplementation((skus: string[]) =>
      Promise.resolve(new Map(skus.map((sku) => [sku, { price: 900, currency: 'us', inStock: 4 }]))),
    );
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', precio_max: '500', limite: '3' }, AUTH), res);

    expect(res.body.productos).toHaveLength(0);
    expect(res.body.sin_resultados.motivo).toBe('sobre_presupuesto');
    expect(res.body.sin_resultados.alternativa.precio).toBe(900);
    expect(res.body.sin_resultados.alternativa.stock).toBeGreaterThan(0);
  });
});

// --- Topes de cotizacion ---
//
// Los tres numeros que acotan cuanto le pedimos a Intcomex (lote de 100,
// 50 candidatos sin filtros, 300 con filtros) no se ven en la respuesta: solo
// se notan en la cuenta de llamadas. Sin estos tests, subir TAMANO_LOTE a 101
// pasa la suite entera y recien rompe en produccion, porque getPrices rechaza
// mas de 100 SKUs por llamada.
describe('GET /search — topes de cotizacion', () => {
  function catalogOf(n: number): NormalizedProduct[] {
    return Array.from({ length: n }, (_, i) =>
      makeProduct(`S${i}`, `Notebook generico ${i}`, 'HP', 'Computadores'),
    );
  }

  beforeEach(() => {
    vi.stubEnv('API_SECRET_KEY', 'test-secret');
    vi.stubEnv('CATALOG_CACHE_DIR', mkdtempSync(join(tmpdir(), 'search-cache-')));
    resetPriceCachesForTests();
    getCatalogMock.mockReset();
    // Sin stock: nada pasa el filtro, asi que el handler recorre todos los
    // candidatos que se permite y podemos contar las llamadas.
    getPricesMock.mockReset().mockImplementation((skus: string[]) =>
      Promise.resolve(new Map(skus.map((sku) => [sku, { price: 100, currency: 'us', inStock: 0 }]))),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function requestedBatches(): string[][] {
    return getPricesMock.mock.calls.map((call) => call[0] as string[]);
  }

  it('nunca pide mas de 100 SKUs por llamada, que es el maximo que acepta getPrices', async () => {
    getCatalogMock.mockReturnValue(catalogOf(500));

    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(requestedBatches().length).toBeGreaterThan(0);
    for (const batch of requestedBatches()) {
      expect(batch.length).toBeLessThanOrEqual(100);
    }
  });

  it('sin filtros corta en 50 candidatos aunque haya 300 coincidencias', async () => {
    getCatalogMock.mockReturnValue(catalogOf(300));

    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(300);
    // Un solo lote de 50: el orden por relevancia ya dejo arriba lo que sirve.
    expect(requestedBatches()).toHaveLength(1);
    expect(requestedBatches()[0]).toHaveLength(50);
    expect(res.body.evaluados).toBe(50);
  });

  it('con filtros llega hasta 300 candidatos y no mas, aunque haya 500 coincidencias', async () => {
    getCatalogMock.mockReturnValue(catalogOf(500));

    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(500);
    // 300 candidatos en lotes de 100.
    expect(requestedBatches()).toHaveLength(3);
    expect(res.body.evaluados).toBe(300);
  });

  it('precio_max tambien habilita el tope alto de candidatos', async () => {
    getCatalogMock.mockReturnValue(catalogOf(500));
    // Todos por sobre el tope: nada pasa el filtro, se recorren los 300.
    getPricesMock.mockImplementation((skus: string[]) =>
      Promise.resolve(new Map(skus.map((sku) => [sku, { price: 9000, currency: 'us', inStock: 5 }]))),
    );

    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', precio_max: '500' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.evaluados).toBe(300);
  });
});

// El reloj se acota con una sonda secuencial mas una ronda paralela. El usuario
// pidio explicito (2026-08-31): mejor demorar ~10-15s y responder con productos
// que responder rapido diciendo que no se alcanzo a revisar. El presupuesto
// (20s) solo impide lanzar la ronda cuando la sonda ya proyecta pasarse.
describe('GET /search — sonda + ronda paralela con presupuesto', () => {
  const LARGE_CATALOG = Array.from({ length: 250 }, (_, i) =>
    makeProduct(`S${i}`, `Notebook generico ${i}`, 'HP', 'Computadores'),
  );

  beforeEach(() => {
    vi.stubEnv('API_SECRET_KEY', 'test-secret');
    vi.stubEnv('CATALOG_CACHE_DIR', mkdtempSync(join(tmpdir(), 'search-cache-')));
    resetPriceCachesForTests();
    getCatalogMock.mockReset().mockReturnValue(LARGE_CATALOG);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.useRealTimers();
  });

  function batchesDe(ms: number, inStock = 0) {
    getPricesMock.mockReset().mockImplementation((skus: string[]) => {
      vi.advanceTimersByTime(ms);
      return Promise.resolve(new Map(skus.map((sku) => [sku, { price: 100, currency: 'us', inStock }])));
    });
  }

  it('con lotes de 5s cotiza TODO en una ronda paralela, sin marcar parcial', async () => {
    vi.useFakeTimers();
    batchesDe(5000);
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', limite: '3' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    // 250 candidatos = sonda de 100 + ronda de [100, 50]: tres llamadas.
    expect(getPricesMock).toHaveBeenCalledTimes(3);
    expect(res.body.evaluados).toBe(250);
    expect(res.body.parcial).toBeUndefined();
    // Se reviso todo, asi que sin_stock es una afirmacion comprobada.
    expect(res.body.sin_resultados.motivo).toBe('sin_stock');
  });

  it('si la sonda sola ya proyecta pasarse, no lanza la ronda y responde parcial', async () => {
    vi.useFakeTimers();
    batchesDe(15000);
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', limite: '3' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(getPricesMock).toHaveBeenCalledTimes(1);
    expect(res.body.parcial).toBe(true);
    expect(res.body.sin_resultados.motivo).toBe('busqueda_incompleta');
    expect(res.body.sin_resultados.alternativa).toBeTruthy();
  });

  it('la sonda siempre corre, aunque cueste mas que el presupuesto entero', async () => {
    vi.useFakeTimers();
    batchesDe(30000);
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', limite: '3' }, AUTH), res);

    expect(getPricesMock).toHaveBeenCalledTimes(1);
    expect(res.body.evaluados).toBeGreaterThan(0);
  });

  it('un lote que falla en la ronda paralela no tumba la respuesta: sale parcial', async () => {
    let llamada = 0;
    getPricesMock.mockReset().mockImplementation((skus: string[]) => {
      llamada++;
      if (llamada === 2) return Promise.reject(new Error('lote caido'));
      return Promise.resolve(new Map(skus.map((sku) => [sku, { price: 100, currency: 'us', inStock: 0 }])));
    });
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', limite: '3' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(getPricesMock).toHaveBeenCalledTimes(3);
    // Los 100 del lote caido quedaron sin cotizar: no se puede afirmar sin_stock.
    expect(res.body.parcial).toBe(true);
    expect(res.body.sin_resultados.motivo).toBe('busqueda_incompleta');
  });

  it('una busqueda rapida y satisfecha no lanza la ronda ni se marca parcial', async () => {
    vi.useFakeTimers();
    batchesDe(0, 5);
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', limite: '3' }, AUTH), res);

    expect(res.body.parcial).toBeUndefined();
    expect(res.body.productos).toHaveLength(3);
    expect(getPricesMock).toHaveBeenCalledTimes(1);
  });
});

// La alternativa de una busqueda vacia debe ser del tipo de producto buscado.
// En el catalogo real, "notebook" calza tambien con una mochila ("Notebook
// carrying backpack") que ademas es lo mas barato: cheapest() a secas la
// ofrecia como alternativa a quien pidio un notebook (produccion, 2026-08-31).
describe('GET /search — la alternativa respeta la categoria dominante', () => {
  const CATALOGO_CON_MOCHILA = [
    ...Array.from({ length: 10 }, (_, i) =>
      makeProduct(`N${i}`, `Lenovo Notebook 14 modelo ${i}`, 'Lenovo', 'Computadores'),
    ),
    makeProduct('M1', 'Lenovo Casual Backpack B210 Notebook carrying backpack', 'Lenovo', 'Maletines'),
  ];

  beforeEach(() => {
    vi.stubEnv('API_SECRET_KEY', 'test-secret');
    vi.stubEnv('CATALOG_CACHE_DIR', mkdtempSync(join(tmpdir(), 'search-cache-')));
    resetPriceCachesForTests();
    getCatalogMock.mockReset().mockReturnValue(CATALOGO_CON_MOCHILA);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('sin stock en nada, la alternativa es un notebook y no la mochila barata', async () => {
    // La mochila vale 11 y es lo mas barato; los notebooks 500. Nada tiene stock.
    getPricesMock.mockReset().mockImplementation((skus: string[]) =>
      Promise.resolve(new Map(skus.map((sku) => [sku, { price: sku === 'M1' ? 11 : 500, currency: 'us', inStock: 0 }]))),
    );
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'Lenovo', solo_con_stock: 'true', limite: '4' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.sin_resultados.motivo).toBe('sin_stock');
    expect(res.body.sin_resultados.alternativa.categoria).toBe('Computadores');
  });

  it('sobre presupuesto, la alternativa tambien sale de la categoria dominante', async () => {
    // La mochila (200) tambien queda sobre el tope de 100: todo sobre presupuesto,
    // pero la mochila sigue siendo lo mas barato — el cebo exacto del bug.
    getPricesMock.mockReset().mockImplementation((skus: string[]) =>
      Promise.resolve(new Map(skus.map((sku) => [sku, { price: sku === 'M1' ? 200 : 500, currency: 'us', inStock: 3 }]))),
    );
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'Lenovo', precio_max: '100', limite: '4' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.sin_resultados.motivo).toBe('sobre_presupuesto');
    expect(res.body.sin_resultados.alternativa.categoria).toBe('Computadores');
  });
});

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

  // Regresion: con limite=0, `productos.length < limit` (0 < 0) nunca es
  // cierto, asi que el guard que evita relanzar la sonda cuando el cache ya
  // satisfizo el limite no puede depender solo de esa comparacion — o la
  // sonda jamas correria y evaluados/sin_resultados quedarian vacios, algo
  // que el comportamiento pre-cache (sonda incondicional) nunca hacia.
  it('con limite=0 y sin cache la sonda corre igual, y sin_resultados se puebla', async () => {
    // Nada tiene stock: bajo limite=0 no hay productos por diseño (nunca se
    // alcanza a empujar ninguno), pero la sonda tiene que correr igual para
    // evaluar candidatos y poder explicar por que no hay resultados.
    getPricesMock.mockReset().mockImplementation((skus: string[]) =>
      Promise.resolve(new Map(skus.map((sku) => [sku, { price: 100, currency: 'us', inStock: 0 }]))),
    );
    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true', limite: '0' }, AUTH), res);

    // Solo la sonda: con limite=0 la ronda sigue sin lanzarse, igual que hoy.
    expect(getPricesMock).toHaveBeenCalledTimes(1);
    expect(res.body.productos).toHaveLength(0);
    expect(res.body.evaluados).toBeGreaterThan(0);
    expect(res.body.sin_resultados?.motivo).toBe('sin_stock');
  });
});
