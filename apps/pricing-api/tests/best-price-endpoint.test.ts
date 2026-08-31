import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getPriceCache, resetPriceCachesForTests } from '@rr/providers/price-cache';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const compareMock = vi.fn();
const resolveKeysMock = vi.fn();
const skuKeyMock = vi.fn();
const hasAnyCatalogMock = vi.fn();
const unavailableCatalogsMock = vi.fn();

vi.mock('@rr/providers/comparator', () => ({
  compareByKey: (...a: unknown[]) => compareMock(...a),
  resolveKeys: (...a: unknown[]) => resolveKeysMock(...a),
  skuKey: (...a: unknown[]) => skuKeyMock(...a),
  hasAnyCatalog: () => hasAnyCatalogMock(),
  unavailableCatalogs: () => unavailableCatalogsMock(),
}));

const { default: handler } = await import('../api/mejor-precio.js');

const COMPARISON = {
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
  compareMock.mockReset().mockResolvedValue(COMPARISON);
  resolveKeysMock.mockReset().mockReturnValue(['mpn1|hp']);
  skuKeyMock.mockReset().mockReturnValue({ estado: 'ok', clave: 'mpn1|hp' });
  hasAnyCatalogMock.mockReset().mockReturnValue(true);
  unavailableCatalogsMock.mockReset().mockReturnValue([]);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /mejor-precio', () => {
  it('devuelve 401 sin x-api-key y no toca los catalogos', async () => {
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }), res);
    expect(res.statusCode).toBe(401);
    expect(resolveKeysMock).not.toHaveBeenCalled();
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
    expect(res.body).toEqual(COMPARISON);
    expect(compareMock).toHaveBeenCalledWith('mpn1|hp');
  });

  it('pasa la marca a la resolucion cuando viene', async () => {
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1', marca: 'HP' }, AUTH), res);
    expect(resolveKeysMock).toHaveBeenCalledWith('MPN1', 'HP');
  });

  it('resuelve por proveedor + sku', async () => {
    const res = makeRes();
    await handler(makeReq({ proveedor: 'intcomex', sku: 'A1' }, AUTH), res);

    expect(skuKeyMock).toHaveBeenCalledWith('intcomex', 'A1');
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
    resolveKeysMock.mockReturnValue(['98pt0g1299|trendnet', '98pt0g1299|msi']);
    const res = makeRes();
    await handler(makeReq({ mpn: '98PT0G1299' }, AUTH), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'ambiguo', marcas: ['trendnet', 'msi'] });
    expect(compareMock).not.toHaveBeenCalled();
  });

  it('devuelve 404 cuando ningun proveedor tiene ese MPN', async () => {
    resolveKeysMock.mockReturnValue([]);
    const res = makeRes();
    await handler(makeReq({ mpn: 'NOEXISTE' }, AUTH), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found', incompleta: [] });
  });

  // Un catalogo caido no puede afirmar "nadie lo vende": ese proveedor no se
  // pudo consultar. El 404 tiene que decirlo, igual que ya lo hace el otro.
  it('devuelve 404 con incompleta cuando un catalogo no se pudo consultar', async () => {
    resolveKeysMock.mockReturnValue([]);
    unavailableCatalogsMock.mockReturnValue([
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
    resolveKeysMock.mockReturnValue([]);
    hasAnyCatalogMock.mockReturnValue(false);
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }, AUTH), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'catalogo_no_disponible' });
  });

  it('devuelve 503 cuando el catalogo de ese proveedor no esta cargado', async () => {
    skuKeyMock.mockReturnValue({ estado: 'catalogo_no_disponible' });
    const res = makeRes();
    await handler(makeReq({ proveedor: 'intcomex', sku: 'A1' }, AUTH), res);
    expect(res.statusCode).toBe(503);
  });

  it('devuelve 404 para un SKU que ese proveedor no conoce', async () => {
    skuKeyMock.mockReturnValue({ estado: 'sku_desconocido' });
    const res = makeRes();
    await handler(makeReq({ proveedor: 'intcomex', sku: 'NOEXISTE' }, AUTH), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found' });
  });

  // Un 404 sugeriria que el producto no existe; existe, pero sin MPN o sin
  // marca no se puede comparar con nadie.
  it('devuelve 409 no_comparable para un producto sin clave de union', async () => {
    skuKeyMock.mockReturnValue({ estado: 'no_comparable' });
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
    compareMock.mockResolvedValue({
      ...COMPARISON,
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
    compareMock.mockResolvedValue({
      ...COMPARISON,
      mejor: null,
      ofertas: [],
      incompleta: [],
    });
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }, AUTH), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found', incompleta: [] });
  });

  // sin_precio es un estado determinista (precio 0, o directamente sin
  // precio): reintentar no lo va a cambiar. Distinto de upstream, que si
  // amerita reintento. Nadie "fallo" aca, simplemente no hay precio.
  it('devuelve 404 (no 502) cuando la unica causa en incompleta es sin_precio', async () => {
    compareMock.mockResolvedValue({
      ...COMPARISON,
      mejor: null,
      ofertas: [],
      incompleta: [{ proveedor: 'ingram', error: 'sin_precio', detail: 'precio 0' }],
    });
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }, AUTH), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({
      error: 'not_found',
      incompleta: [{ proveedor: 'ingram', error: 'sin_precio' }],
    });
  });

  // Con una causa transitoria de por medio, todavia vale la pena reintentar
  // aunque otra de las causas sea permanente.
  it('devuelve 502 cuando incompleta mezcla una causa transitoria con una permanente', async () => {
    compareMock.mockResolvedValue({
      ...COMPARISON,
      mejor: null,
      ofertas: [],
      incompleta: [
        { proveedor: 'ingram', error: 'sin_precio', detail: 'precio 0' },
        { proveedor: 'tecnoglobal', error: 'upstream', detail: 'cuota' },
      ],
    });
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }, AUTH), res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ error: 'upstream' });
  });

  // Las dos causas transitorias son independientes: catalogo_no_disponible
  // por si sola, sin upstream de por medio, tambien tiene que disparar 502.
  it('devuelve 502 cuando la unica causa transitoria es catalogo_no_disponible', async () => {
    compareMock.mockResolvedValue({
      ...COMPARISON,
      mejor: null,
      ofertas: [],
      incompleta: [
        { proveedor: 'tecnoglobal', error: 'catalogo_no_disponible', detail: 'aun no carga' },
      ],
    });
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }, AUTH), res);

    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({
      error: 'upstream',
      incompleta: [{ proveedor: 'tecnoglobal', error: 'catalogo_no_disponible' }],
    });
  });

  it('responde 200 aunque la comparacion sea parcial', async () => {
    compareMock.mockResolvedValue({
      ...COMPARISON,
      incompleta: [{ proveedor: 'tecnoglobal', error: 'upstream', detail: 'cuota' }],
    });
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.incompleta).toHaveLength(1);
  });
});

// El principio del diseno (spec 2026-08-31): la cotizacion se compromete en
// vivo, SIEMPRE. Esta prueba existe para que conectar el cache aqui sea un
// acto deliberado que rompa la suite, no un descuido.
describe('GET /mejor-precio ignora el cache de precios', () => {
  it('con el cache lleno igual cotiza en vivo', async () => {
    vi.stubEnv('CATALOG_CACHE_DIR', mkdtempSync(join(tmpdir(), 'bp-cache-')));
    resetPriceCachesForTests();
    // Cache lleno con un precio deliberadamente distinto al del mock vivo.
    getPriceCache('ingram').put(new Map([['IM1', { price: 1, currency: 'USD', inStock: 99 }]]), ['IM1']);
    getPriceCache('intcomex').put(new Map([['IM1', { price: 1, currency: 'USD', inStock: 99 }]]), ['IM1']);

    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1', marca: 'HP' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    // La comparacion EN VIVO fue llamada, y su precio (100) es el que responde
    // — no el 1 del cache.
    expect(compareMock).toHaveBeenCalled();
    expect(res.body.mejor.precio).toBe(100);
  });
});
