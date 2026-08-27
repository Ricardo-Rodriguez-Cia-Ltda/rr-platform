import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadHandler, request } from './load.js';

const handler = loadHandler('apps/kapso-agent/functions/buscar-productos-v2.js');
const search = JSON.parse(readFileSync('apps/kapso-agent/tests/fixtures/search-intcomex.json', 'utf8'));
const env = { API_PRECIOS_KEY: 'clave', MARGEN: '0.13' };

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

  it('aplica 13% de margen sobre el costo', async () => {
    respondWith(search);
    const res = await handler(request({ input: { q: 'cinta epson' } }), env);
    const data = (await res.json()) as any;
    expect(data.productos[0].precio).toBe(12.43);
  });

  it('convierte precio_max de venta a costo antes de consultar', async () => {
    const spy = respondWith(search);
    await handler(request({ input: { q: 'cinta', precio_max: 113 } }), env);
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
