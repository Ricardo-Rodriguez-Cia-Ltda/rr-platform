import { afterEach, describe, expect, it, vi } from 'vitest';
import { cfgPrecios, costoMaxUsd, formatCLP, precioTiendaClp, ventaNetaClp } from '../src/lib/precios.js';

afterEach(() => vi.unstubAllEnvs());
const CFG = { margen: 0.13, tipoCambio: 950, iva: 0.19 };

describe('precios', () => {
  it('venta neta = formula EXACTA del bot: round(costo * 1.13 * 950)', () => {
    expect(ventaNetaClp(1.18, CFG)).toBe(1267); // el caso real del smoke test del bot
    expect(ventaNetaClp(100, CFG)).toBe(107350);
  });
  it('precio tienda = venta neta con IVA, redondeado', () => {
    expect(precioTiendaClp(100, CFG)).toBe(Math.round(107350 * 1.19)); // 127747
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
