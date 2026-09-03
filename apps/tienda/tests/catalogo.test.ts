import { afterEach, describe, expect, it, vi } from 'vitest';
import { buscarCatalogo, cargarPortada } from '../src/lib/catalogo.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function conEnv() {
  vi.stubEnv('PRICING_API_URL', 'https://oficina.test/api');
  vi.stubEnv('PRICING_API_KEY', 'clave-api');
  vi.stubEnv('MARGEN', '0.13'); vi.stubEnv('TIPO_CAMBIO_CLP_USD', '950'); vi.stubEnv('IVA_RATE', '0.19');
}

// Forma REAL del productor (computeFacets, packages/domain/src/search.ts:171-177):
// claves en SINGULAR y cada una es {valor, n}[]. Los fixtures viejos usaban
// `categorias`/`marcas` como string[] — un contrato inventado que dejaba las
// facetas de la tienda siempre vacias contra la API de verdad.
const FACETAS = {
  marca: [{ valor: 'HP', n: 1 }, { valor: 'Logitech', n: 1 }],
  categoria: [{ valor: 'Computadores', n: 1 }, { valor: 'Accesorios', n: 1 }],
  subcategoria: [{ valor: 'Notebooks', n: 1 }],
};
const RESPUESTA = {
  total: 2, evaluados: 12,
  productos: [
    { sku: 'INT-1', mpn: 'X-100', nombre: 'Notebook Pro', marca: 'HP', categoria: 'Computadores', precio: 100, moneda: 'USD', stock: 5 },
    { sku: 'INT-2', mpn: null, nombre: 'Mouse', marca: 'Logitech', categoria: 'Accesorios', precio: 2, moneda: 'USD', stock: 0 },
  ],
  facetas: { ...FACETAS, precio: { min: 2, max: 100 } },
};

describe('buscarCatalogo', () => {
  it('convierte a precio tienda y NUNCA expone costo USD ni moneda', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(RESPUESTA), { status: 200 })));
    const r = await buscarCatalogo({ q: 'notebook' });
    expect(r?.demasiadoAmplio).toBe(false);
    expect(r?.productos[0].precioClp).toBe(127747);
    expect(r?.productos[0].precioNetoClp).toBe(107350);
    expect(r?.productos[0].precioFmt).toBe('$127.747');
    expect(r?.productos[0].disponible).toBe(true);
    expect(r?.productos[1].disponible).toBe(false);
    // Invariante anti-fuga: ni claves ni valores del costo crudo.
    const json = JSON.stringify(r);
    expect(json).not.toContain('moneda');
    expect(json).not.toContain('"precio":');
    expect(json).not.toContain('USD');
    for (const p of r!.productos) {
      expect(Object.keys(p).sort()).toEqual(['categoria', 'disponible', 'marca', 'mpn', 'nombre', 'precioClp', 'precioFmt', 'precioNetoClp', 'sku']);
    }
  });
  it('lee las facetas en la forma real {valor,n} y saca los nombres', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(RESPUESTA), { status: 200 })));
    const r = await buscarCatalogo({ q: 'notebook' });
    expect(r?.marcas).toEqual(['HP', 'Logitech']);
    expect(r?.categorias).toEqual(['Computadores', 'Accesorios']);
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
  it('409 demasiado_amplio NO es una caida: devuelve el aviso con facetas y total', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: 'demasiado_amplio',
      detail: '312 coincidencias. Acota con marca o categoria.',
      total: 312,
      facetas: FACETAS,
    }), { status: 409 })));
    const r = await buscarCatalogo({ q: 'hp' });
    expect(r).not.toBeNull();
    expect(r?.demasiadoAmplio).toBe(true);
    expect(r?.total).toBe(312);
    expect(r?.productos).toEqual([]);
    expect(r?.marcas).toEqual(['HP', 'Logitech']);
    expect(r?.categorias).toEqual(['Computadores', 'Accesorios']);
  });
  it('otros errores HTTP siguen siendo caida (null)', async () => {
    conEnv();
    for (const status of [401, 500, 503]) {
      vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'x' }), { status })));
      expect(await buscarCatalogo({ q: 'x' })).toBeNull();
    }
    // Un 409 que NO es demasiado_amplio tampoco se disfraza de exito.
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ error: 'otra_cosa' }), { status: 409 })));
    expect(await buscarCatalogo({ q: 'x' })).toBeNull();
  });
  it('descarta productos sin precio numerico; resultado sin NaN', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ...RESPUESTA,
      productos: [
        RESPUESTA.productos[0],
        { sku: 'INT-2', mpn: null, nombre: 'Mouse Broken', marca: 'Logitech', categoria: 'Accesorios', precio: undefined, moneda: 'USD', stock: 0 },
      ],
    }), { status: 200 })));
    const r = await buscarCatalogo({ q: 'test' });
    expect(r?.productos).toHaveLength(1);
    expect(r?.productos[0].sku).toBe('INT-1');
    expect(JSON.stringify(r)).not.toContain('NaN');
  });
  it('falla cerrado ante moneda distinta de USD (el precio se multiplica por el tipo de cambio)', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ...RESPUESTA,
      productos: [
        RESPUESTA.productos[0],
        { sku: 'INT-3', mpn: 'Y', nombre: 'Teclado CLP', marca: 'HP', categoria: 'Accesorios', precio: 9990, moneda: 'CLP', stock: 3 },
        { sku: 'INT-4', mpn: 'Z', nombre: 'Sin moneda', marca: 'HP', categoria: 'Accesorios', precio: 5, stock: 3 },
      ],
    }), { status: 200 })));
    const r = await buscarCatalogo({ q: 'test' });
    expect(r?.productos.map((p) => p.sku)).toEqual(['INT-1']);
  });
  it('descarta precio 0 o negativo (no se regala nada)', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      ...RESPUESTA,
      productos: [
        RESPUESTA.productos[0],
        { sku: 'INT-5', mpn: 'A', nombre: 'Gratis', marca: 'HP', categoria: 'Accesorios', precio: 0, moneda: 'USD', stock: 3 },
        { sku: 'INT-6', mpn: 'B', nombre: 'Negativo', marca: 'HP', categoria: 'Accesorios', precio: -4, moneda: 'USD', stock: 3 },
      ],
    }), { status: 200 })));
    const r = await buscarCatalogo({ q: 'test' });
    expect(r?.productos.map((p) => p.sku)).toEqual(['INT-1']);
  });
});

describe('cargarPortada', () => {
  it('pega a /facetas (no /facets) y lee categoria en singular', async () => {
    conEnv();
    const spy = vi.fn(async () => new Response(JSON.stringify({ total_productos: 100, ...FACETAS }), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    expect(await cargarPortada()).toEqual({ categorias: ['Computadores', 'Accesorios'] });
    expect(String((spy.mock.calls[0] as unknown as [string])[0])).toBe('https://oficina.test/api/facetas');
  });
  it('API caida => null', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    expect(await cargarPortada()).toBeNull();
  });
});
