import { afterEach, describe, expect, it, vi } from 'vitest';
import { cfgPrecios, conIvaClp, costoMaxUsd, formatCLP, precioTiendaClp, ventaNetaClp } from '../src/lib/precios.js';

afterEach(() => vi.unstubAllEnvs());
const CFG = { margen: 0.13, tipoCambio: 950, iva: 0.19 };

describe('precios', () => {
  it('venta neta = formula EXACTA del bot: el USD se redondea a 2 decimales ANTES de pasar a CLP', () => {
    // generar-cotizacion-v2.js:104-105 y 150-152: venta(costo) redondea a
    // centavos de dolar y recien ahi multiplica por el tipo de cambio.
    // 1.18 * 1.13 = 1.3334 -> 1.33 USD -> round(1.33 * 950) = 1264.
    // Sin el redondeo intermedio darian 1267: la tienda cobraria 3 pesos mas
    // que el bot y CADA pedido rebotaria con un 409 de recotizacion.
    expect(ventaNetaClp(1.18, CFG)).toBe(1264);
    expect(ventaNetaClp(100, CFG)).toBe(107350);
  });
  it('el IVA se suma como en el bot: neto + round(neto * iva), no round(neto * 1.19)', () => {
    expect(conIvaClp(107350, CFG)).toBe(107350 + Math.round(107350 * 0.19)); // 127747
    expect(precioTiendaClp(100, CFG)).toBe(127747);
    // Caso donde las dos formulas divergen: neto*iva termina en .5 exacto.
    expect(conIvaClp(50, CFG)).toBe(50 + 10); // round(9.5) = 10
  });
  it('costoMaxUsd invierte el precio tienda (ida y vuelta no sube el tope)', () => {
    const costo = costoMaxUsd(127747, CFG);
    expect(precioTiendaClp(costo, CFG)).toBeLessThanOrEqual(127747 + 1);
  });
  it('formatCLP con puntos de miles', () => {
    expect(formatCLP(127747)).toBe('$127.747');
  });
  it('cfgPrecios lee env y valida: margen 0 o vacio => null (venderiamos a costo)', () => {
    vi.stubEnv('MARGEN', '0.13'); vi.stubEnv('TIPO_CAMBIO_CLP_USD', '950'); vi.stubEnv('IVA_RATE', '0.19');
    expect(cfgPrecios()).toEqual(CFG);
    vi.stubEnv('MARGEN', '0');
    expect(cfgPrecios()).toBeNull();
    vi.stubEnv('MARGEN', '');
    expect(cfgPrecios()).toBeNull();
  });
});
