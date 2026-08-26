import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarHandler, peticion } from './cargar.js';

const handler = cargarHandler('docs/kapso/functions-v2/generar-cotizacion-v2.js');
const mejorOk = JSON.parse(readFileSync('tests/fixtures/mejor-precio-ok.json', 'utf8'));
const ambiguo = JSON.parse(readFileSync('tests/fixtures/mejor-precio-ambiguo.json', 'utf8'));

const env = {
  API_PRECIOS_KEY: 'clave',
  MARGEN: '0.13',
  TIPO_CAMBIO_CLP_USD: '950',
  IVA_RATE: '0.19',
  COTIZACION_VALID_HOURS: '3',
};

const carro = [{ mpn: 'ERC-38B', marca: 'Epson', sku: 'AR155EPS14', nombre: 'Cinta Epson', cantidad: 2 }];

function cola(respuestas: Array<{ payload: unknown; status?: number }>) {
  const spy = vi.fn(async () => {
    const siguiente = respuestas.shift();
    if (!siguiente) throw new Error('llamada de mas a fetch');
    return new Response(JSON.stringify(siguiente.payload), { status: siguiente.status ?? 200 });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function cotizar(cart: unknown, respuestas: Array<{ payload: unknown; status?: number }>) {
  const spy = cola(respuestas);
  const res = await handler(peticion({ execution_context: { vars: { cart_items: cart } } }), env);
  return { datos: (await res.json()) as any, status: res.status, spy };
}

afterEach(() => vi.unstubAllGlobals());

describe('generar-cotizacion-v2', () => {
  it('cotiza con el ganador y no con la primera oferta', async () => {
    const { datos } = await cotizar(carro, [{ payload: mejorOk }]);
    const linea = datos.quote.lineas[0];
    expect(datos.estado).toBe('ok');
    expect(linea.proveedor).toBe('ingram');
    expect(linea.sku_proveedor).toBe('ING-778');
  });

  it('aplica 13% y convierte a CLP', async () => {
    const { datos } = await cotizar(carro, [{ payload: mejorOk }]);
    const linea = datos.quote.lineas[0];
    expect(linea.precio_unitario_usd).toBe(12.43);
    expect(linea.precio_unitario_clp).toBe(11809);
    expect(linea.subtotal_neto_clp).toBe(23618);
    expect(datos.quote.iva_clp).toBe(Math.round(23618 * 0.19));
    expect(datos.quote.total_clp).toBe(23618 + Math.round(23618 * 0.19));
  });

  it('ninguna linea filtra el costo', async () => {
    const { datos } = await cotizar(carro, [{ payload: mejorOk }]);
    const claves = Object.keys(datos.quote.lineas[0]).join(' ');
    expect(claves).not.toMatch(/costo/i);
    // El costo (11.0) no puede aparecer como valor. Buscarlo como substring seria
    // un falso positivo: "11" tambien esta dentro de 11809.
    expect(Object.values(datos.quote.lineas[0])).not.toContain(11);
    expect(Object.values(datos.quote.lineas[0])).not.toContain(11.0);
  });

  it('calcula el ahorro contra la oferta mas cara', async () => {
    const { datos } = await cotizar(carro, [{ payload: mejorOk }]);
    // (13.0 - 11.0) x 1.13 x 950 = 2147 por unidad, x 2 unidades
    expect(datos.quote.lineas[0].ahorro_vs_peor_clp).toBe(2147 * 2);
    expect(datos.quote.ahorro_total_clp).toBe(2147 * 2);
  });

  it('reintenta con marca ante un 409 ambiguo', async () => {
    const { datos, spy } = await cotizar([{ mpn: 'ERC-38B', sku: 'AR155EPS14', nombre: 'Cinta', cantidad: 1 }], [
      { payload: ambiguo, status: 409 },
      { payload: mejorOk },
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(new URL((spy.mock.calls[1] as any)?.[0] as string).searchParams.get('marca')).toBe('Epson');
    expect(datos.estado).toBe('ok');
  });

  it('cae al fallback por proveedor+sku ante un 404', async () => {
    const { datos, spy } = await cotizar(carro, [
      { payload: { error: 'not_found' }, status: 404 },
      { payload: mejorOk },
    ]);
    const url = new URL((spy.mock.calls[1] as any)?.[0] as string);
    expect(url.searchParams.get('proveedor')).toBe('intcomex');
    expect(url.searchParams.get('sku')).toBe('AR155EPS14');
    expect(datos.quote.lineas[0].comparacion).toBe('fallback_intcomex');
  });

  it('no cotiza si el fallback tambien falla', async () => {
    const { datos, status } = await cotizar(carro, [
      { payload: { error: 'not_found' }, status: 404 },
      { payload: { error: 'not_found' }, status: 404 },
    ]);
    expect(status).toBe(409);
    expect(datos.estado).toBe('producto_no_disponible');
  });

  it('propaga los proveedores que no participaron', async () => {
    const parcial = { ...mejorOk, incompleta: [{ proveedor: 'tecnoglobal', error: 'upstream', detail: 'cuota' }] };
    const { datos } = await cotizar(carro, [{ payload: parcial }]);
    expect(datos.quote.proveedores_incompletos).toEqual(['tecnoglobal']);
    expect(datos.quote.lineas[0].comparacion).toBe('parcial');
  });

  it('rechaza un carro vacio', async () => {
    const { status } = await cotizar([], []);
    expect(status).toBe(400);
  });
});
