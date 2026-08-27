import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import type { ProductoNormalizado } from '@rr/domain/product';

const obtenerCatalogoMock = vi.fn();
const getPreciosMock = vi.fn();

vi.mock('@rr/domain/catalog', async () => {
  const actual = await vi.importActual<typeof import('@rr/domain/catalog')>('@rr/domain/catalog');
  return { ...actual, obtenerCatalogo: () => obtenerCatalogoMock() };
});

vi.mock('../lib/providers/intcomex.js', () => ({
  cargarCatalogoIntcomex: async () => [],
  getPrices: (skus: string[]) => getPreciosMock(skus),
  intcomex: {
    nombre: 'intcomex',
    maxSkusPorLote: 100,
    estaConfigurado: () =>
      Boolean(
        process.env.INTCOMEX_API_KEY &&
          process.env.INTCOMEX_ACCESS_KEY &&
          process.env.INTCOMEX_BASE_URL,
      ),
    cargarCatalogo: async () => [],
    getPrecios: (skus: string[]) => getPreciosMock(skus),
    getPrecio: async () => {
      throw new Error('no usado');
    },
  },
}));

const { default: aliasSearch } = await import('../api/search.js');
const { default: porRutaSearch } = await import('../api/[proveedor]/search.js');
const { default: porRutaProduct } = await import('../api/[proveedor]/product.js');
const { default: porRutaFacetas } = await import('../api/[proveedor]/facetas.js');

function producto(sku: string, nombre: string): ProductoNormalizado {
  return {
    sku,
    mpn: `MPN-${sku}`,
    nombre,
    marca: 'HP',
    categoria: 'Computadores',
    subcategorias: [],
    tipo: null,
  };
}

const CATALOGO = [producto('HP1', 'HP ProBook 640 Notebook 14"')];

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
  obtenerCatalogoMock.mockReset().mockReturnValue(CATALOGO);
  getPreciosMock
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

    const resRuta = makeRes();
    await porRutaSearch(makeReq({ proveedor: 'intcomex', q: 'probook' }, AUTH), resRuta);

    expect(resRuta.statusCode).toBe(resAlias.statusCode);
    expect(resRuta.body).toEqual(resAlias.body);
  });

  it('404 proveedor_desconocido para un proveedor que no existe', async () => {
    const res = makeRes();
    await porRutaSearch(makeReq({ proveedor: 'nadie', q: 'notebook' }, AUTH), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'proveedor_desconocido', proveedor: 'nadie' });
  });

  // Va a pasar todo el tiempo mientras TI no entregue credenciales: tiene que
  // distinguirse de "el proveedor esta caido", que es 502.
  it('503 proveedor_no_configurado cuando faltan credenciales', async () => {
    vi.stubEnv('INTCOMEX_API_KEY', '');
    const res = makeRes();
    await porRutaSearch(makeReq({ proveedor: 'intcomex', q: 'notebook' }, AUTH), res);
    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'proveedor_no_configurado', proveedor: 'intcomex' });
  });

  it('valida la api key antes de mirar el proveedor', async () => {
    const res = makeRes();
    await porRutaSearch(makeReq({ proveedor: 'nadie', q: 'notebook' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('rechaza metodos que no son GET antes de resolver el proveedor', async () => {
    const res = makeRes();
    await porRutaSearch(makeReq({ proveedor: 'nadie', q: 'x' }, AUTH, 'POST'), res);
    expect(res.statusCode).toBe(405);
  });

  it('/api/{proveedor}/product responde la ficha del proveedor de la ruta', async () => {
    const res = makeRes();
    await porRutaProduct(makeReq({ proveedor: 'intcomex', sku: 'HP1' }, AUTH), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toMatchObject({ sku: 'HP1', precio: 1000 });
  });

  it('/api/{proveedor}/facetas responde las facetas del proveedor de la ruta', async () => {
    const res = makeRes();
    await porRutaFacetas(makeReq({ proveedor: 'intcomex' }, AUTH), res);
    expect(res.statusCode).toBe(200);
    expect(res.body.total_productos).toBe(1);
  });

  it.each([
    ['product', porRutaProduct],
    ['facetas', porRutaFacetas],
  ])('%s tambien devuelve proveedor_desconocido con el proveedor en el cuerpo', async (_n, h) => {
    const res = makeRes();
    await h(makeReq({ proveedor: 'nadie', sku: 'HP1' }, AUTH), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'proveedor_desconocido', proveedor: 'nadie' });
  });
});
