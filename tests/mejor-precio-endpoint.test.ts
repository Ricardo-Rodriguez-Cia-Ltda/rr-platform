import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const compararMock = vi.fn();
const resolverClavesMock = vi.fn();
const claveDeSkuMock = vi.fn();
const hayAlgunCatalogoMock = vi.fn();
const catalogosNoDisponiblesMock = vi.fn();

vi.mock('../lib/comparador.js', () => ({
  compararPorClave: (...a: unknown[]) => compararMock(...a),
  resolverClaves: (...a: unknown[]) => resolverClavesMock(...a),
  claveDeSku: (...a: unknown[]) => claveDeSkuMock(...a),
  hayAlgunCatalogo: () => hayAlgunCatalogoMock(),
  catalogosNoDisponibles: () => catalogosNoDisponiblesMock(),
}));

const { default: handler } = await import('../api/mejor-precio.js');

const COMPARACION = {
  clave: 'mpn1|hp',
  mpn: 'MPN1',
  marca: 'HP',
  nombre: 'Notebook HP',
  mejor: {
    proveedor: 'ingram',
    sku: 'IM1',
    precio: 100,
    moneda: 'USD',
    stock: 4,
    criterio: 'mas_barato_con_stock',
  },
  ofertas: [{ proveedor: 'ingram', sku: 'IM1', precio: 100, moneda: 'USD', stock: 4 }],
  incompleta: [],
};

function makeReq(query: Record<string, string>, headers: Record<string, string> = {}, method = 'GET'): VercelRequest {
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

const AUTH = { 'x-api-key': 'test-secret' };

beforeEach(() => {
  vi.stubEnv('API_SECRET_KEY', 'test-secret');
  vi.stubEnv('INTCOMEX_API_KEY', 'pub');
  vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret');
  vi.stubEnv('INTCOMEX_BASE_URL', 'https://x/');
  compararMock.mockReset().mockResolvedValue(COMPARACION);
  resolverClavesMock.mockReset().mockReturnValue(['mpn1|hp']);
  claveDeSkuMock.mockReset().mockReturnValue({ estado: 'ok', clave: 'mpn1|hp' });
  hayAlgunCatalogoMock.mockReset().mockReturnValue(true);
  catalogosNoDisponiblesMock.mockReset().mockReturnValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /mejor-precio', () => {
  it('devuelve 401 sin x-api-key y no toca los catalogos', async () => {
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }), res);
    expect(res.statusCode).toBe(401);
    expect(resolverClavesMock).not.toHaveBeenCalled();
  });

  it('devuelve 405 para metodos que no son GET', async () => {
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }, AUTH, 'POST'), res);
    expect(res.statusCode).toBe(405);
  });

  it('devuelve 400 sin identificador', async () => {
    const res = makeRes();
    await handler(makeReq({}, AUTH), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request' });
  });

  // Pedir por los dos caminos a la vez es ambiguo: no se adivina cual gana.
  it('devuelve 400 con mpn y proveedor+sku a la vez', async () => {
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1', proveedor: 'intcomex', sku: 'A1' }, AUTH), res);
    expect(res.statusCode).toBe(400);
  });

  it('devuelve 400 con el par proveedor+sku incompleto', async () => {
    const res = makeRes();
    await handler(makeReq({ proveedor: 'intcomex' }, AUTH), res);
    expect(res.statusCode).toBe(400);
  });

  it('devuelve la comparacion completa por mpn', async () => {
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(COMPARACION);
    expect(compararMock).toHaveBeenCalledWith('mpn1|hp');
  });

  it('pasa la marca a la resolucion cuando viene', async () => {
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1', marca: 'HP' }, AUTH), res);
    expect(resolverClavesMock).toHaveBeenCalledWith('MPN1', 'HP');
  });

  it('resuelve por proveedor + sku', async () => {
    const res = makeRes();
    await handler(makeReq({ proveedor: 'intcomex', sku: 'A1' }, AUTH), res);

    expect(claveDeSkuMock).toHaveBeenCalledWith('intcomex', 'A1');
    expect(res.statusCode).toBe(200);
  });

  it('devuelve 404 proveedor_desconocido para un proveedor que no existe', async () => {
    const res = makeRes();
    await handler(makeReq({ proveedor: 'nadie', sku: 'A1' }, AUTH), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'proveedor_desconocido' });
  });

  // Elegir una marca por el consumidor es cotizarle un producto que no pidio.
  it('devuelve 409 ambiguo cuando el MPN existe bajo varias marcas', async () => {
    resolverClavesMock.mockReturnValue(['98pt0g1299|trendnet', '98pt0g1299|msi']);
    const res = makeRes();
    await handler(makeReq({ mpn: '98PT0G1299' }, AUTH), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'ambiguo', marcas: ['trendnet', 'msi'] });
    expect(compararMock).not.toHaveBeenCalled();
  });

  it('devuelve 404 cuando ningun proveedor tiene ese MPN', async () => {
    resolverClavesMock.mockReturnValue([]);
    const res = makeRes();
    await handler(makeReq({ mpn: 'NOEXISTE' }, AUTH), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found', incompleta: [] });
  });

  // Un catalogo caido no puede afirmar "nadie lo vende": ese proveedor no se
  // pudo consultar. El 404 tiene que decirlo, igual que ya lo hace el otro.
  it('devuelve 404 con incompleta cuando un catalogo no se pudo consultar', async () => {
    resolverClavesMock.mockReturnValue([]);
    catalogosNoDisponiblesMock.mockReturnValue([
      { proveedor: 'tecnoglobal', error: 'catalogo_no_disponible', detail: 'no cargo' },
    ]);
    const res = makeRes();
    await handler(makeReq({ mpn: 'NOEXISTE' }, AUTH), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({
      error: 'not_found',
      incompleta: [{ proveedor: 'tecnoglobal', error: 'catalogo_no_disponible' }],
    });
  });

  // Sin ningun catalogo la respuesta no es "no existe", es "todavia no se".
  it('devuelve 503 cuando no hay ningun catalogo cargado', async () => {
    resolverClavesMock.mockReturnValue([]);
    hayAlgunCatalogoMock.mockReturnValue(false);
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }, AUTH), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'catalogo_no_disponible' });
  });

  it('devuelve 503 cuando el catalogo de ese proveedor no esta cargado', async () => {
    claveDeSkuMock.mockReturnValue({ estado: 'catalogo_no_disponible' });
    const res = makeRes();
    await handler(makeReq({ proveedor: 'intcomex', sku: 'A1' }, AUTH), res);
    expect(res.statusCode).toBe(503);
  });

  it('devuelve 404 para un SKU que ese proveedor no conoce', async () => {
    claveDeSkuMock.mockReturnValue({ estado: 'sku_desconocido' });
    const res = makeRes();
    await handler(makeReq({ proveedor: 'intcomex', sku: 'NOEXISTE' }, AUTH), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found' });
  });

  // Un 404 sugeriria que el producto no existe; existe, pero sin MPN o sin
  // marca no se puede comparar con nadie.
  it('devuelve 409 no_comparable para un producto sin clave de union', async () => {
    claveDeSkuMock.mockReturnValue({ estado: 'no_comparable' });
    const res = makeRes();
    await handler(makeReq({ proveedor: 'intcomex', sku: 'A1' }, AUTH), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'no_comparable' });
  });

  // La clave se resolvio -algun proveedor tiene el producto en catalogo- pero
  // cotizar fallo en todos: eso es transitorio (cuota, un 500), no "no
  // existe". Devolver 404 aca le diria al cliente que no vendemos algo que si
  // vendemos, y sin reintento que lo corrija.
  it('devuelve 502 upstream conservando incompleta cuando fallaron todos los proveedores', async () => {
    compararMock.mockResolvedValue({
      ...COMPARACION,
      mejor: null,
      ofertas: [],
      incompleta: [{ proveedor: 'ingram', error: 'upstream', detail: 'se cayo' }],
    });
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }, AUTH), res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({
      error: 'upstream',
      incompleta: [{ proveedor: 'ingram', error: 'upstream' }],
    });
  });

  // Sin ofertas y sin nadie que fallara si es definitivo: se revisaron todos
  // los catalogos y ninguno lo vende.
  it('devuelve 404 not_found cuando nadie lo vende y nadie fallo', async () => {
    compararMock.mockResolvedValue({
      ...COMPARACION,
      mejor: null,
      ofertas: [],
      incompleta: [],
    });
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }, AUTH), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found', incompleta: [] });
  });

  it('responde 200 aunque la comparacion sea parcial', async () => {
    compararMock.mockResolvedValue({
      ...COMPARACION,
      incompleta: [{ proveedor: 'tecnoglobal', error: 'upstream', detail: 'cuota' }],
    });
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.incompleta).toHaveLength(1);
  });
});
