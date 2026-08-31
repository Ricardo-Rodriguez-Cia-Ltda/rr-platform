import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadHandler, request } from './load.js';

const handler = loadHandler('apps/kapso-agent/functions/buscar-productos-v2.js');
const search = JSON.parse(readFileSync('apps/kapso-agent/tests/fixtures/search-intcomex.json', 'utf8'));
const env = { API_PRECIOS_KEY: 'clave', MARGEN: '0.13', TIPO_CAMBIO_CLP_USD: '950' };

function respondWith(payload: unknown, status = 200) {
  const spy = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe('buscar-productos-v2', () => {
  it('propaga mpn y marca de cada producto', async () => {
    respondWith(search);
    const res = await handler(request({ input: { q: 'cinta epson' } }), env);
    const data = (await res.json()) as any;
    expect(data.estado).toBe('ok');
    expect(data.productos[0].mpn).toBe('ERC-38B');
    expect(data.productos[0].marca).toBe('Epson');
  });

  it('aplica 13% de margen sobre el costo y entrega el precio en pesos', async () => {
    respondWith(search);
    const res = await handler(request({ input: { q: 'cinta epson' } }), env);
    const data = (await res.json()) as any;
    // 11 USD de costo -> 12.43 con margen -> 11809 pesos a 950.
    expect(data.productos[0].precio).toBe(11809);
    expect(data.productos[0].moneda).toBe('CLP');
  });

  it('convierte precio_max de pesos de venta a costo en dolares antes de consultar', async () => {
    const spy = respondWith(search);
    // 107350 pesos de venta = 113 USD de venta = 100 USD de costo.
    await handler(request({ input: { q: 'cinta', precio_max: 107350 } }), env);
    const url = new URL((spy.mock.calls[0] as any)?.[0] as string);
    expect(Number(url.searchParams.get('precio_max'))).toBeCloseTo(100, 2);
  });

  it('traduce el 409 en demasiado_amplio con opciones', async () => {
    respondWith({ total: 800, facetas: { marca: [{ valor: 'HP' }], categoria: [] } }, 409);
    const res = await handler(request({ input: { q: 'notebook' } }), env);
    const data = (await res.json()) as any;
    expect(data.estado).toBe('demasiado_amplio');
    expect(data.opciones.marcas).toEqual(['HP']);
  });

  it('descarta productos sin mpn: sin mpn no hay comparacion posible', async () => {
    respondWith({ ...search, productos: [{ ...search.productos[0], mpn: null }] });
    const res = await handler(request({ input: { q: 'cinta' } }), env);
    const data = (await res.json()) as any;
    expect(data.productos).toHaveLength(0);
  });
});

// Una busqueda vacia no es una caida. Antes la function devolvia estado "ok"
// con la lista vacia y el agente inventaba la explicacion: en la conversacion
// del 2026-08-28 dijo "tengo un problema temporal con la busqueda", que era
// falso, y el cliente quedo esperando.
describe('buscar-productos-v2: por que vino vacia', () => {
  it('distingue sin_stock, y no lo presenta como un problema', async () => {
    respondWith({
      total: 393,
      productos: [],
      sin_resultados: {
        motivo: 'sin_stock',
        alternativa: { nombre: 'Lenovo Backpack B210', marca: 'Lenovo', precio: 11.1955, stock: 0 },
      },
    });
    const res = await handler(request({ input: { q: 'notebook', marca: 'Lenovo' } }), env);
    const data = (await res.json()) as any;
    expect(data.estado).toBe('sin_stock');
    expect(data.total).toBe(393);
    expect(data.mostrados).toBe(0);
    expect(data.mensaje).toMatch(/stock/i);
  });

  it('entrega la alternativa en pesos, no en dolares', async () => {
    respondWith({
      total: 393,
      productos: [],
      sin_resultados: {
        motivo: 'sin_stock',
        alternativa: { nombre: 'Lenovo Backpack B210', marca: 'Lenovo', precio: 100, stock: 0 },
      },
    });
    const res = await handler(request({ input: { q: 'notebook', marca: 'Lenovo' } }), env);
    const data = (await res.json()) as any;
    expect(data.alternativa.precio).toBe(107350);
    expect(data.alternativa.moneda).toBe('CLP');
  });

  it('sin coincidencias es un estado distinto de sin stock', async () => {
    respondWith({ total: 0, productos: [] });
    const res = await handler(request({ input: { q: 'algo que no existe' } }), env);
    const data = (await res.json()) as any;
    expect(data.estado).toBe('sin_coincidencias');
    expect(data.productos).toEqual([]);
  });

  it('un tipo de cambio invalido falla cerrado en vez de dejar todo en $0', async () => {
    respondWith({ total: 1, productos: [] });
    const res = await handler(request({ input: { q: 'cinta' } }), { ...env, TIPO_CAMBIO_CLP_USD: '' });
    const data = (await res.json()) as any;
    expect(res.status).toBe(500);
    expect(data.estado).toBe('error');
  });
});

describe('buscar-productos-v2: busqueda parcial', () => {
  it('propaga busqueda_incompleta sin afirmar que no hay stock', async () => {
    respondWith({
      total: 394,
      parcial: true,
      productos: [],
      sin_resultados: {
        motivo: 'busqueda_incompleta',
        alternativa: { nombre: 'Lenovo V15', marca: 'Lenovo', precio: 100, stock: 0 },
      },
    });
    const res = await handler(request({ input: { q: 'notebook', marca: 'Lenovo' } }), env);
    const data = (await res.json()) as any;
    expect(data.estado).toBe('busqueda_incompleta');
    expect(data.mensaje).not.toMatch(/ninguno con stock/i);
    expect(data.mensaje).toMatch(/acote|acotar/i);
  });
});
