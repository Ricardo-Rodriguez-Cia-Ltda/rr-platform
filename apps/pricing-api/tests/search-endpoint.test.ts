import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { CatalogUnavailableError } from '@rr/providers/catalog';
import type { NormalizedProduct } from '@rr/domain/product';
import { ProviderError } from '@rr/domain/types';

const obtenerCatalogoMock = vi.fn();
const getPricesMock = vi.fn();

vi.mock('@rr/providers/catalog', async () => {
  const actual = await vi.importActual<typeof import('@rr/providers/catalog')>('@rr/providers/catalog');
  return { ...actual, getCatalog: () => obtenerCatalogoMock() };
});

vi.mock('@rr/providers/intcomex', () => ({
  getPrices: (skus: string[]) => getPricesMock(skus),
  cargarCatalogoIntcomex: async () => [],
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

function producto(
  sku: string,
  nombre: string,
  marca: string,
  categoria: string,
): NormalizedProduct {
  return { sku, mpn: `MPN-${sku}`, nombre, marca, categoria, subcategorias: [], tipo: null };
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

  it('returns 401 with a wrong x-api-key and does not touch the catalog', async () => {
    const res = makeRes();
    await handler(makeReq({ q: 'hp' }, { 'x-api-key': 'nope' }), res);
    expect(res.statusCode).toBe(401);
    expect(obtenerCatalogoMock).not.toHaveBeenCalled();
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
    const precios = res.body.productos.map((p: any) => p.precio);
    expect(res.body.facetas.precio).toEqual({
      min: Math.min(...precios),
      max: Math.max(...precios),
    });
  });

  it('does not include facetas.precio on a 409 (no upstream calls happen on that path)', async () => {
    const grande = Array.from({ length: 30 }, (_, i) =>
      producto(`S${i}`, `Notebook generico ${i}`, i % 2 === 0 ? 'HP' : 'Dell', 'Computadores'),
    );
    obtenerCatalogoMock.mockReturnValue(grande);

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
    const exacto = Array.from({ length: 25 }, (_, i) =>
      producto(`T${i}`, `Notebook generico ${i}`, 'HP', 'Computadores'),
    );
    obtenerCatalogoMock.mockReturnValue(exacto);
    getPricesMock.mockResolvedValue(new Map());

    const res = makeRes();
    await handler(makeReq({ q: 'notebook' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(25);
  });

  it('returns 409 just past the ambiguity threshold (26 matches)', async () => {
    const pasado = Array.from({ length: 26 }, (_, i) =>
      producto(`T${i}`, `Notebook generico ${i}`, 'HP', 'Computadores'),
    );
    obtenerCatalogoMock.mockReturnValue(pasado);

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
  const CATALOGO_GRANDE = Array.from({ length: 250 }, (_, i) =>
    producto(`S${i}`, `Notebook generico ${i}`, 'HP', 'Computadores'),
  );

  // Solo los SKUs a partir del 150 tienen stock; todos valen 100.
  function preciosPorLote(skus: string[]) {
    return new Map(
      skus.map((sku) => {
        const n = Number(sku.slice(1));
        return [sku, { price: 100, currency: 'us', inStock: n >= 150 ? 7 : 0 }];
      }),
    );
  }

  beforeEach(() => {
    vi.stubEnv('API_SECRET_KEY', 'test-secret');
    obtenerCatalogoMock.mockReset().mockReturnValue(CATALOGO_GRANDE);
    getPricesMock.mockReset().mockImplementation((skus: string[]) => Promise.resolve(preciosPorLote(skus)));
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
  function catalogoDe(n: number): NormalizedProduct[] {
    return Array.from({ length: n }, (_, i) =>
      producto(`S${i}`, `Notebook generico ${i}`, 'HP', 'Computadores'),
    );
  }

  beforeEach(() => {
    vi.stubEnv('API_SECRET_KEY', 'test-secret');
    obtenerCatalogoMock.mockReset();
    // Sin stock: nada pasa el filtro, asi que el handler recorre todos los
    // candidatos que se permite y podemos contar las llamadas.
    getPricesMock.mockReset().mockImplementation((skus: string[]) =>
      Promise.resolve(new Map(skus.map((sku) => [sku, { price: 100, currency: 'us', inStock: 0 }]))),
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  function lotesPedidos(): string[][] {
    return getPricesMock.mock.calls.map((call) => call[0] as string[]);
  }

  it('nunca pide mas de 100 SKUs por llamada, que es el maximo que acepta getPrices', async () => {
    obtenerCatalogoMock.mockReturnValue(catalogoDe(500));

    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(lotesPedidos().length).toBeGreaterThan(0);
    for (const lote of lotesPedidos()) {
      expect(lote.length).toBeLessThanOrEqual(100);
    }
  });

  it('sin filtros corta en 50 candidatos aunque haya 300 coincidencias', async () => {
    obtenerCatalogoMock.mockReturnValue(catalogoDe(300));

    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(300);
    // Un solo lote de 50: el orden por relevancia ya dejo arriba lo que sirve.
    expect(lotesPedidos()).toHaveLength(1);
    expect(lotesPedidos()[0]).toHaveLength(50);
    expect(res.body.evaluados).toBe(50);
  });

  it('con filtros llega hasta 300 candidatos y no mas, aunque haya 500 coincidencias', async () => {
    obtenerCatalogoMock.mockReturnValue(catalogoDe(500));

    const res = makeRes();
    await handler(makeReq({ q: 'notebook', marca: 'HP', solo_con_stock: 'true' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.total).toBe(500);
    // 300 candidatos en lotes de 100.
    expect(lotesPedidos()).toHaveLength(3);
    expect(res.body.evaluados).toBe(300);
  });

  it('precio_max tambien habilita el tope alto de candidatos', async () => {
    obtenerCatalogoMock.mockReturnValue(catalogoDe(500));
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
