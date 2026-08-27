import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { loadHandler, request } from './load.js';

const handler = loadHandler('apps/kapso-agent/functions/generar-cotizacion-v2.js');
const bestPriceOk = JSON.parse(readFileSync('apps/kapso-agent/tests/fixtures/mejor-precio-ok.json', 'utf8'));
const ambiguous = JSON.parse(readFileSync('apps/kapso-agent/tests/fixtures/mejor-precio-ambiguo.json', 'utf8'));

const env = {
  API_PRECIOS_KEY: 'clave',
  MARGEN: '0.13',
  TIPO_CAMBIO_CLP_USD: '950',
  IVA_RATE: '0.19',
  COTIZACION_VALID_HOURS: '3',
};

const cart = [{ mpn: 'ERC-38B', marca: 'Epson', sku: 'AR155EPS14', nombre: 'Cinta Epson', cantidad: 2 }];

function queue(responses: Array<{ payload: unknown; status?: number }>) {
  const spy = vi.fn(async () => {
    const next = responses.shift();
    if (!next) throw new Error('llamada de mas a fetch');
    return new Response(JSON.stringify(next.payload), { status: next.status ?? 200 });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function quote(
  cart: unknown,
  responses: Array<{ payload: unknown; status?: number }>,
  environment: Record<string, string> = env,
) {
  const spy = queue(responses);
  const res = await handler(request({ execution_context: { vars: { cart_items: cart } } }), environment);
  return { data: (await res.json()) as any, status: res.status, spy };
}

// Recorre recursivamente un valor visitando cada par (clave, valor). Es lo
// unico que detecta una fuga de costo enterrada en un objeto anidado: mirar
// una sola linea contra un solo literal no cubre la cabecera, ni `vars`, ni
// el camino de fallback.
function walk(value: unknown, visit: (key: string | null, v: unknown) => void, key: string | null = null): void {
  visit(key, value);
  if (Array.isArray(value)) {
    for (const v of value) walk(v, visit, key);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) walk(v, visit, k);
  }
}

// Todos los costos que la API le entrego a la function: el ganador y cada una
// de las ofertas que perdieron. Ninguno puede sobrevivir a la respuesta.
const COSTS: number[] = [
  Number(bestPriceOk.mejor.precio),
  ...(bestPriceOk.ofertas as Array<{ precio: number }>).map((o) => Number(o.precio)),
];

function noCosts(response: unknown): void {
  const forbidden = new Set(COSTS);
  expect(forbidden.size).toBeGreaterThan(1);
  walk(response, (key, value) => {
    if (key) expect(key, `la clave ${key} suena a costo`).not.toMatch(/cost|margen|margin/i);
    if (typeof value === 'number') {
      expect(forbidden.has(value), `el valor ${value} es un costo de la API`).toBe(false);
    }
    // Una cadena que coacciona a un costo es el mismo dato con otra forma. No
    // se busca como substring: el uuid y las fechas traen digitos y darian
    // falsos positivos.
    if (typeof value === 'string' && value.trim() !== '') {
      expect(forbidden.has(Number(value)), `el texto "${value}" es un costo de la API`).toBe(false);
    }
  });
}

afterEach(() => vi.unstubAllGlobals());

describe('generar-cotizacion-v2', () => {
  it('cotiza con el ganador y no con la primera oferta', async () => {
    const { data } = await quote(cart, [{ payload: bestPriceOk }]);
    const line = data.quote.lineas[0];
    expect(data.estado).toBe('ok');
    expect(line.proveedor).toBe('ingram');
    expect(line.sku_proveedor).toBe('ING-778');
  });

  it('aplica 13% y convierte a CLP', async () => {
    const { data } = await quote(cart, [{ payload: bestPriceOk }]);
    const line = data.quote.lineas[0];
    expect(line.precio_unitario_usd).toBe(12.43);
    expect(line.precio_unitario_clp).toBe(11809);
    expect(line.subtotal_neto_clp).toBe(23618);
    expect(data.quote.iva_clp).toBe(Math.round(23618 * 0.19));
    expect(data.quote.total_clp).toBe(23618 + Math.round(23618 * 0.19));
  });

  it('ningun costo sobrevive a la respuesta en el camino feliz', async () => {
    const { data } = await quote(cart, [{ payload: bestPriceOk }]);
    expect(data.estado).toBe('ok');
    // El cuerpo completo, no solo una linea: el nodo function guarda toda la
    // respuesta en `quote_function_response` y ademas escribe `vars`.
    noCosts(data);
  });

  it('ningun costo sobrevive a la respuesta en el camino de fallback', async () => {
    const { data } = await quote(cart, [
      { payload: { error: 'not_found' }, status: 404 },
      { payload: bestPriceOk },
    ]);
    expect(data.quote.lineas[0].comparacion).toBe('fallback_intcomex');
    noCosts(data);
  });

  it('calcula el ahorro contra la oferta mas cara', async () => {
    const { data } = await quote(cart, [{ payload: bestPriceOk }]);
    // (13.0 - 11.0) x 1.13 x 950 = 2147 por unidad, x 2 unidades
    expect(data.quote.lineas[0].ahorro_vs_peor_clp).toBe(2147 * 2);
    expect(data.quote.ahorro_total_clp).toBe(2147 * 2);
  });

  it('reintenta con marca ante un 409 ambiguo', async () => {
    const { data, spy } = await quote([{ mpn: 'ERC-38B', sku: 'AR155EPS14', nombre: 'Cinta', cantidad: 1 }], [
      { payload: ambiguous, status: 409 },
      { payload: bestPriceOk },
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(new URL((spy.mock.calls[1] as any)?.[0] as string).searchParams.get('marca')).toBe('Epson');
    expect(data.estado).toBe('ok');
  });

  it('cae al fallback por proveedor+sku ante un 404', async () => {
    const { data, spy } = await quote(cart, [
      { payload: { error: 'not_found' }, status: 404 },
      { payload: bestPriceOk },
    ]);
    const url = new URL((spy.mock.calls[1] as any)?.[0] as string);
    expect(url.searchParams.get('proveedor')).toBe('intcomex');
    expect(url.searchParams.get('sku')).toBe('AR155EPS14');
    expect(data.quote.lineas[0].comparacion).toBe('fallback_intcomex');
  });

  it('no cotiza si el fallback tambien falla', async () => {
    const { data, status } = await quote(cart, [
      { payload: { error: 'not_found' }, status: 404 },
      { payload: { error: 'not_found' }, status: 404 },
    ]);
    expect(status).toBe(409);
    expect(data.estado).toBe('producto_no_disponible');
  });

  it('propaga los proveedores que no participaron', async () => {
    const partial = { ...bestPriceOk, incompleta: [{ proveedor: 'tecnoglobal', error: 'upstream', detail: 'cuota' }] };
    const { data } = await quote(cart, [{ payload: partial }]);
    expect(data.quote.proveedores_incompletos).toEqual(['tecnoglobal']);
    expect(data.quote.lineas[0].comparacion).toBe('parcial');
  });

  it('rechaza un carro vacio', async () => {
    const { status } = await quote([], []);
    expect(status).toBe(400);
  });

  // Hallazgo 6: el precio ganador se multiplica por el tipo de cambio CLP/USD.
  // Si no viene en dolares, ese calculo es falso y hay que fallar cerrado.
  describe('moneda del ganador', () => {
    it('no cotiza si el ganador no vende en USD', async () => {
      const inPesos = { ...bestPriceOk, mejor: { ...bestPriceOk.mejor, moneda: 'CLP' } };
      const { data, status } = await quote(cart, [{ payload: inPesos }, { payload: inPesos }]);
      expect(status).toBe(409);
      expect(data.estado).toBe('producto_no_disponible');
    });

    it('cotiza igual si la moneda viene en minusculas', async () => {
      const lowercase = { ...bestPriceOk, mejor: { ...bestPriceOk.mejor, moneda: 'usd' } };
      const { data } = await quote(cart, [{ payload: lowercase }]);
      expect(data.estado).toBe('ok');
    });

    it('cotiza si la API no declara moneda', async () => {
      const { moneda: _currency, ...bestWithoutCurrency } = bestPriceOk.mejor;
      const { data } = await quote(cart, [{ payload: { ...bestPriceOk, mejor: bestWithoutCurrency } }]);
      expect(data.estado).toBe('ok');
    });
  });

  // Hallazgo 7: la arista fn_cotizar → agente_presentacion es incondicional, asi
  // que una cotizacion que no existe no puede quedar disponible para presentar.
  describe('una salida de error limpia la cotizacion anterior', () => {
    const expectCleared = (data: any) => {
      expect(data.vars).toBeDefined();
      expect(data.vars.quote_result).toBeNull();
      expect(data.vars.quote_id).toBeNull();
      expect(data.vars.quote_total_clp).toBeNull();
      expect(data.vars.quote_valid_until).toBeNull();
    };

    it('cuando el producto ya no tiene precio', async () => {
      const { data, status } = await quote(cart, [
        { payload: { error: 'not_found' }, status: 404 },
        { payload: { error: 'not_found' }, status: 404 },
      ]);
      expect(status).toBe(409);
      expectCleared(data);
    });

    it('cuando el carro no es valido', async () => {
      const { data, status } = await quote([], []);
      expect(status).toBe(400);
      expectCleared(data);
    });

    it('cuando una linea no tiene identificador', async () => {
      const { data, status } = await quote([{ nombre: 'Suelto', cantidad: 1 }], []);
      expect(status).toBe(400);
      expectCleared(data);
    });

    it('cuando la configuracion no es valida', async () => {
      const { data, status } = await quote(cart, [], { ...env, TIPO_CAMBIO_CLP_USD: '0' });
      expect(status).toBe(500);
      expectCleared(data);
    });

    it('cuando falta la clave de la API', async () => {
      const { data, status } = await quote(cart, [], { ...env, API_PRECIOS_KEY: '' });
      expect(status).toBe(500);
      expectCleared(data);
    });
  });

  // Hallazgo 10: un MARGEN vacio coacciona a 0 y venderia a costo.
  it('rechaza un margen de cero', async () => {
    const { status } = await quote(cart, [], { ...env, MARGEN: '' });
    expect(status).toBe(500);
  });
});
