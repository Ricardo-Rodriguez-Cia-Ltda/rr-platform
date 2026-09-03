import { afterEach, describe, expect, it, vi } from 'vitest';
import { buscarCatalogo, cargarPortada } from '../src/lib/catalogo.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function conEnv() {
  vi.stubEnv('PRICING_API_URL', 'https://oficina.test/api');
  vi.stubEnv('PRICING_API_KEY', 'clave-api');
  vi.stubEnv('MARGEN', '0.13'); vi.stubEnv('TIPO_CAMBIO_CLP_USD', '950'); vi.stubEnv('IVA_RATE', '0.19');
}
// La API entrega COSTO en USD; 100 USD costo => 107.350 neto => 127.747 tienda.
const RESPUESTA = {
  total: 40, evaluados: 12,
  productos: [
    { sku: 'INT-1', mpn: 'X-100', nombre: 'Notebook Pro', marca: 'HP', categoria: 'Computadores', precio: 100, moneda: 'USD', stock: 5 },
    { sku: 'INT-2', mpn: null, nombre: 'Mouse', marca: 'Logitech', categoria: 'Accesorios', precio: 2, moneda: 'USD', stock: 0 },
  ],
  facetas: { categorias: ['Computadores', 'Accesorios'], marcas: ['HP', 'Logitech'], precio: { min: 2, max: 100 } },
};

describe('buscarCatalogo', () => {
  it('convierte a precio tienda y NUNCA expone costo USD ni moneda', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(RESPUESTA), { status: 200 })));
    const r = await buscarCatalogo({ q: 'notebook' });
    expect(r?.productos[0].precioClp).toBe(127747);
    expect(r?.productos[0].precioFmt).toBe('$127.747');
    expect(r?.productos[0].disponible).toBe(true);
    expect(r?.productos[1].disponible).toBe(false);
    // Invariante anti-fuga: ni claves ni valores del costo crudo.
    const json = JSON.stringify(r);
    expect(json).not.toContain('moneda');
    expect(json).not.toContain('"precio":');
    expect(json).not.toContain('USD');
    for (const p of r!.productos) expect(Object.keys(p).sort()).toEqual(['categoria', 'disponible', 'marca', 'mpn', 'nombre', 'precioClp', 'precioFmt', 'sku']);
  });
  it('manda la api key y traduce precioMaxClp al costo USD que la API espera', async () => {
    conEnv();
    const spy = vi.fn(async () => new Response(JSON.stringify(RESPUESTA), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await buscarCatalogo({ q: 'notebook', precioMaxClp: 127747, marca: 'HP' });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('clave-api');
    expect(url).toContain('https://oficina.test/api/search?');
    expect(url).toContain('marca=HP');
    const precioMax = Number(new URL(url).searchParams.get('precio_max'));
    expect(precioMax).toBeGreaterThan(99); expect(precioMax).toBeLessThanOrEqual(100.01);
  });
  it('parcial:true se propaga; API caida o sin env => null', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...RESPUESTA, parcial: true }), { status: 200 })));
    expect((await buscarCatalogo({ q: 'x' }))?.parcial).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('tunel caido'); }));
    expect(await buscarCatalogo({ q: 'x' })).toBeNull();
    vi.unstubAllEnvs();
    expect(await buscarCatalogo({ q: 'x' })).toBeNull();
  });
});

describe('cargarPortada', () => {
  it('devuelve las categorias de /facets', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ total_productos: 100, categorias: ['A', 'B'] }), { status: 200 })));
    expect(await cargarPortada()).toEqual({ categorias: ['A', 'B'] });
  });
});
