import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarHandler, peticion } from './load.js';

const handler = cargarHandler('apps/kapso-agent/functions/generar-cotizacion-v2.js');
const mejorOk = JSON.parse(readFileSync('apps/kapso-agent/tests/fixtures/mejor-precio-ok.json', 'utf8'));
const ambiguo = JSON.parse(readFileSync('apps/kapso-agent/tests/fixtures/mejor-precio-ambiguo.json', 'utf8'));

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

async function cotizar(
  cart: unknown,
  respuestas: Array<{ payload: unknown; status?: number }>,
  entorno: Record<string, string> = env,
) {
  const spy = cola(respuestas);
  const res = await handler(peticion({ execution_context: { vars: { cart_items: cart } } }), entorno);
  return { datos: (await res.json()) as any, status: res.status, spy };
}

// Recorre recursivamente un valor visitando cada par (clave, valor). Es lo
// unico que detecta una fuga de costo enterrada en un objeto anidado: mirar
// una sola linea contra un solo literal no cubre la cabecera, ni `vars`, ni
// el camino de fallback.
function recorrer(valor: unknown, visita: (clave: string | null, v: unknown) => void, clave: string | null = null): void {
  visita(clave, valor);
  if (Array.isArray(valor)) {
    for (const v of valor) recorrer(v, visita, clave);
    return;
  }
  if (valor && typeof valor === 'object') {
    for (const [k, v] of Object.entries(valor as Record<string, unknown>)) recorrer(v, visita, k);
  }
}

// Todos los costos que la API le entrego a la function: el ganador y cada una
// de las ofertas que perdieron. Ninguno puede sobrevivir a la respuesta.
const COSTOS: number[] = [
  Number(mejorOk.mejor.precio),
  ...(mejorOk.ofertas as Array<{ precio: number }>).map((o) => Number(o.precio)),
];

function sinCostos(respuesta: unknown): void {
  const prohibidos = new Set(COSTOS);
  expect(prohibidos.size).toBeGreaterThan(1);
  recorrer(respuesta, (clave, valor) => {
    if (clave) expect(clave, `la clave ${clave} suena a costo`).not.toMatch(/cost|margen|margin/i);
    if (typeof valor === 'number') {
      expect(prohibidos.has(valor), `el valor ${valor} es un costo de la API`).toBe(false);
    }
    // Una cadena que coacciona a un costo es el mismo dato con otra forma. No
    // se busca como substring: el uuid y las fechas traen digitos y darian
    // falsos positivos.
    if (typeof valor === 'string' && valor.trim() !== '') {
      expect(prohibidos.has(Number(valor)), `el texto "${valor}" es un costo de la API`).toBe(false);
    }
  });
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

  it('ningun costo sobrevive a la respuesta en el camino feliz', async () => {
    const { datos } = await cotizar(carro, [{ payload: mejorOk }]);
    expect(datos.estado).toBe('ok');
    // El cuerpo completo, no solo una linea: el nodo function guarda toda la
    // respuesta en `quote_function_response` y ademas escribe `vars`.
    sinCostos(datos);
  });

  it('ningun costo sobrevive a la respuesta en el camino de fallback', async () => {
    const { datos } = await cotizar(carro, [
      { payload: { error: 'not_found' }, status: 404 },
      { payload: mejorOk },
    ]);
    expect(datos.quote.lineas[0].comparacion).toBe('fallback_intcomex');
    sinCostos(datos);
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

  // Hallazgo 6: el precio ganador se multiplica por el tipo de cambio CLP/USD.
  // Si no viene en dolares, ese calculo es falso y hay que fallar cerrado.
  describe('moneda del ganador', () => {
    it('no cotiza si el ganador no vende en USD', async () => {
      const enPesos = { ...mejorOk, mejor: { ...mejorOk.mejor, moneda: 'CLP' } };
      const { datos, status } = await cotizar(carro, [{ payload: enPesos }, { payload: enPesos }]);
      expect(status).toBe(409);
      expect(datos.estado).toBe('producto_no_disponible');
    });

    it('cotiza igual si la moneda viene en minusculas', async () => {
      const minuscula = { ...mejorOk, mejor: { ...mejorOk.mejor, moneda: 'usd' } };
      const { datos } = await cotizar(carro, [{ payload: minuscula }]);
      expect(datos.estado).toBe('ok');
    });

    it('cotiza si la API no declara moneda', async () => {
      const { moneda: _sinMoneda, ...mejorSinMoneda } = mejorOk.mejor;
      const { datos } = await cotizar(carro, [{ payload: { ...mejorOk, mejor: mejorSinMoneda } }]);
      expect(datos.estado).toBe('ok');
    });
  });

  // Hallazgo 7: la arista fn_cotizar → agente_presentacion es incondicional, asi
  // que una cotizacion que no existe no puede quedar disponible para presentar.
  describe('una salida de error limpia la cotizacion anterior', () => {
    const limpia = (datos: any) => {
      expect(datos.vars).toBeDefined();
      expect(datos.vars.quote_result).toBeNull();
      expect(datos.vars.quote_id).toBeNull();
      expect(datos.vars.quote_total_clp).toBeNull();
      expect(datos.vars.quote_valid_until).toBeNull();
    };

    it('cuando el producto ya no tiene precio', async () => {
      const { datos, status } = await cotizar(carro, [
        { payload: { error: 'not_found' }, status: 404 },
        { payload: { error: 'not_found' }, status: 404 },
      ]);
      expect(status).toBe(409);
      limpia(datos);
    });

    it('cuando el carro no es valido', async () => {
      const { datos, status } = await cotizar([], []);
      expect(status).toBe(400);
      limpia(datos);
    });

    it('cuando una linea no tiene identificador', async () => {
      const { datos, status } = await cotizar([{ nombre: 'Suelto', cantidad: 1 }], []);
      expect(status).toBe(400);
      limpia(datos);
    });

    it('cuando la configuracion no es valida', async () => {
      const { datos, status } = await cotizar(carro, [], { ...env, TIPO_CAMBIO_CLP_USD: '0' });
      expect(status).toBe(500);
      limpia(datos);
    });

    it('cuando falta la clave de la API', async () => {
      const { datos, status } = await cotizar(carro, [], { ...env, API_PRECIOS_KEY: '' });
      expect(status).toBe(500);
      limpia(datos);
    });
  });

  // Hallazgo 10: un MARGEN vacio coacciona a 0 y venderia a costo.
  it('rechaza un margen de cero', async () => {
    const { status } = await cotizar(carro, [], { ...env, MARGEN: '' });
    expect(status).toBe(500);
  });
});
