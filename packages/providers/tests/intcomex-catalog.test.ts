import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cargarCatalogoIntcomex, normalizarProducto } from '@rr/providers/intcomex';

beforeEach(() => {
  vi.stubEnv('INTCOMEX_API_KEY', 'pub');
  vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret-key');
  vi.stubEnv('INTCOMEX_BASE_URL', 'https://intcomex-prod.apigee.net/v1/');
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

const CRUDO = {
  Sku: 'NT016HPQ53',
  Mpn: '2N6G5LT#ABM',
  Description: 'HP ProBook 640 G8 - Notebook - 14"',
  Type: 'Physical',
  Brand: { Description: 'HP' },
  Category: { Description: 'Computadores', Subcategories: [{ Description: 'Notebooks' }] },
};

describe('normalizarProducto', () => {
  it('traduce la forma de Intcomex a la forma comun', () => {
    expect(normalizarProducto(CRUDO)).toEqual({
      sku: 'NT016HPQ53',
      mpn: '2N6G5LT#ABM',
      nombre: 'HP ProBook 640 G8 - Notebook - 14"',
      marca: 'HP',
      categoria: 'Computadores',
      subcategorias: ['Notebooks'],
      tipo: 'Physical',
    });
  });

  it('convierte los campos ausentes en null, no en undefined', () => {
    const p = normalizarProducto({ Sku: 'X1' });
    expect(p).toEqual({
      sku: 'X1',
      mpn: null,
      nombre: null,
      marca: null,
      categoria: null,
      subcategorias: [],
      tipo: null,
    });
  });

  it('descarta subcategorias sin descripcion en vez de dejar huecos', () => {
    const p = normalizarProducto({
      Sku: 'X1',
      Category: { Description: 'C', Subcategories: [{ Description: null }, { Description: 'Buena' }] },
    });
    expect(p.subcategorias).toEqual(['Buena']);
  });
});

describe('cargarCatalogoIntcomex', () => {
  it('pide getcatalog y devuelve productos ya normalizados', async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify([CRUDO]), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const productos = await cargarCatalogoIntcomex();

    expect((fetchMock.mock.calls[0][0] as URL).href).toContain('/v1/getcatalog');
    expect(productos).toHaveLength(1);
    expect(productos[0].marca).toBe('HP');
  });

  it('rechaza un 200 que no es un arreglo (rate limit de apigee)', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ Message: 'Rate limit exceeded' }), { status: 200 }),
    ));
    await expect(cargarCatalogoIntcomex()).rejects.toThrow();
  });

  it('rechaza un arreglo vacio', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('[]', { status: 200 })));
    await expect(cargarCatalogoIntcomex()).rejects.toThrow();
  });

  it('rechaza un HTTP no-ok', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));
    await expect(cargarCatalogoIntcomex()).rejects.toThrow();
  });
});
