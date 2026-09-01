import { describe, expect, it } from 'vitest';
import { buildCotizacionView, formatCLP, type CotizacionRow } from '../src/cotizacion-view.js';

// 2026-09-01T22:45:00.000Z son las 18:45 en Santiago: el primer sabado de
// septiembre 2026 (dia 5) es cuando Chile continental vuelve a UTC-3, asi que
// el 1 de septiembre todavia esta en horario de invierno (UTC-4). El brief
// traia 21:45Z asumiendo UTC-3 todo el ano; se corrige el fixture, no la logica.
const ROW: CotizacionRow = {
  quote_id: 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4',
  numero: 1600001,
  telefono: null,
  neto_clp: 6108975,
  iva_clp: 1160705,
  total_clp: 7269680,
  valida_hasta: '2026-09-01T22:45:00.000Z', // 18:45 en Santiago (UTC-4, horario de invierno)
  created_at: '2026-09-01T18:00:00.000Z',
  lineas: [
    { mpn: 'D6UF9AT#ABM', nombre: 'HP EliteBook G1i - Notebook - 14"', cantidad: 5, precio_unitario_clp: 1221795, subtotal_neto_clp: 6108975 },
  ],
};

describe('formatCLP', () => {
  it('separa miles con punto y antepone $', () => {
    expect(formatCLP(1221795)).toBe('$1.221.795');
    expect(formatCLP(0)).toBe('$0');
    expect(formatCLP(990047)).toBe('$990.047');
  });
});

describe('buildCotizacionView', () => {
  it('arma numero, archivo y montos formateados', () => {
    const v = buildCotizacionView(ROW, null);
    expect(v.numero).toBe('1600001');
    expect(v.archivo).toBe('cotizacion-1600001.pdf');
    expect(v.netoFmt).toBe('$6.108.975');
    expect(v.ivaFmt).toBe('$1.160.705');
    expect(v.totalFmt).toBe('$7.269.680');
  });

  it('sin numero (fila anterior al ALTER) sale S/N, no revienta', () => {
    const v = buildCotizacionView({ ...ROW, numero: null }, null);
    expect(v.numero).toBe('S/N');
    expect(v.archivo).toBe('cotizacion-SN.pdf');
  });

  it('la fecha y la vigencia van en hora de Santiago', () => {
    const v = buildCotizacionView(ROW, null);
    expect(v.fechaLarga).toBe('Santiago, 1 de septiembre de 2026');
    expect(v.vigenciaTexto).toContain('01-09-2026');
    expect(v.vigenciaTexto).toContain('18:45');
  });

  it('el codigo de cada linea es el MPN, con fallback al SKU del proveedor', () => {
    const v = buildCotizacionView(ROW, null);
    expect(v.lineas[0].codigo).toBe('D6UF9AT#ABM');
    const sinMpn = buildCotizacionView({ ...ROW, lineas: [{ ...ROW.lineas[0], mpn: null, sku_proveedor: 'NT030HPQ58' }] }, null);
    expect(sinMpn.lineas[0].codigo).toBe('NT030HPQ58');
  });

  it('con cliente guardado va la razon social; sin el, null', () => {
    expect(buildCotizacionView(ROW, { razon_social: 'Felipe Carvallo SpA', rut: '20986748-6' }).cliente)
      .toEqual({ razonSocial: 'Felipe Carvallo SpA', rut: '20986748-6' });
    expect(buildCotizacionView(ROW, null).cliente).toBeNull();
  });

  it('sin valida_hasta, la vigencia es cadena vacia', () => {
    expect(buildCotizacionView({ ...ROW, valida_hasta: null }, null).vigenciaTexto).toBe('');
  });
});
