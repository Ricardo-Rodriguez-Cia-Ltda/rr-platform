import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarHandler, peticion } from './load.js';

const handler = cargarHandler('apps/kapso-agent/functions/buscar-productos-v2.js');
const busqueda = JSON.parse(readFileSync('apps/kapso-agent/tests/fixtures/search-intcomex.json', 'utf8'));
const env = { API_PRECIOS_KEY: 'clave', MARGEN: '0.13' };

function responderCon(payload: unknown, status = 200) {
  const spy = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe('buscar-productos-v2', () => {
  it('propaga mpn y marca de cada producto', async () => {
    responderCon(busqueda);
    const res = await handler(peticion({ input: { q: 'cinta epson' } }), env);
    const datos = (await res.json()) as any;
    expect(datos.estado).toBe('ok');
    expect(datos.productos[0].mpn).toBe('ERC-38B');
    expect(datos.productos[0].marca).toBe('Epson');
  });

  it('aplica 13% de margen sobre el costo', async () => {
    responderCon(busqueda);
    const res = await handler(peticion({ input: { q: 'cinta epson' } }), env);
    const datos = (await res.json()) as any;
    expect(datos.productos[0].precio).toBe(12.43);
  });

  it('convierte precio_max de venta a costo antes de consultar', async () => {
    const spy = responderCon(busqueda);
    await handler(peticion({ input: { q: 'cinta', precio_max: 113 } }), env);
    const url = new URL((spy.mock.calls[0] as any)?.[0] as string);
    expect(Number(url.searchParams.get('precio_max'))).toBeCloseTo(100, 2);
  });

  it('traduce el 409 en demasiado_amplio con opciones', async () => {
    responderCon({ total: 800, facetas: { marca: [{ valor: 'HP' }], categoria: [] } }, 409);
    const res = await handler(peticion({ input: { q: 'notebook' } }), env);
    const datos = (await res.json()) as any;
    expect(datos.estado).toBe('demasiado_amplio');
    expect(datos.opciones.marcas).toEqual(['HP']);
  });

  it('descarta productos sin mpn: sin mpn no hay comparacion posible', async () => {
    responderCon({ ...busqueda, productos: [{ ...busqueda.productos[0], mpn: null }] });
    const res = await handler(peticion({ input: { q: 'cinta' } }), env);
    const datos = (await res.json()) as any;
    expect(datos.productos).toHaveLength(0);
  });
});
