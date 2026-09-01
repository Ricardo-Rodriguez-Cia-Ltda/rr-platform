import { describe, expect, it } from 'vitest';
import { buildOrdenView, formatUSD, type PedidoRow } from '../src/orden-view.js';

const ROW: PedidoRow = {
  po_id: 'oc-f9b6c8ad-5b51-408d-8de2-acd10ff35ec4-1-intcomex',
  quote_id: 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4',
  quote_version: '1',
  proveedor: 'intcomex',
  telefono: '56941757584',
  rut: '21099234-0',
  razon_social: 'Acme SpA',
  estado: 'sent',
  created_at: '2026-09-01T18:00:00.000Z',
  lineas: [
    {
      sku_proveedor: 'INT-1',
      mpn: 'X-100',
      nombre: 'Notebook',
      cantidad: 2,
      abastecimiento: 'stock_inmediato',
      costo_unitario_usd: 100.5,
      costo_total_usd: 201,
    },
    {
      sku_proveedor: 'INT-2',
      mpn: 'Y-200',
      nombre: 'Mouse',
      cantidad: 1,
      abastecimiento: 'por_comprar_importar',
      costo_unitario_usd: 10.25,
      costo_total_usd: 10.25,
    },
  ],
};

describe('formatUSD', () => {
  it('usa dos decimales y separadores es-CL', () => {
    expect(formatUSD(1234.5)).toBe('US$ 1.234,50');
    expect(formatUSD(10)).toBe('US$ 10,00');
  });
});

describe('buildOrdenView', () => {
  it('arma la vista completa con costos formateados y total sumado', () => {
    const view = buildOrdenView(ROW, 1600001);
    expect(view.poId).toBe(ROW.po_id);
    expect(view.archivo).toBe(`${ROW.po_id}.pdf`);
    expect(view.proveedor).toBe('INTCOMEX');
    expect(view.referencia).toBe('Ref.: Cotización N° 1600001 (v1)');
    expect(view.cliente).toEqual({ razonSocial: 'Acme SpA', rut: '21099234-0' });
    expect(view.lineas[0].costoUnitario).toBe('US$ 100,50');
    expect(view.lineas[0].costoTotal).toBe('US$ 201,00');
    expect(view.totalFmt).toBe('US$ 211,25');
    expect(view.estadoAviso).toBe('');
  });

  it('la fecha larga sale en hora de Santiago', () => {
    // 2026-09-01T18:00Z = 14:00 en Santiago (UTC-4 hasta el primer sabado de
    // septiembre): sigue siendo 1 de septiembre.
    expect(buildOrdenView(ROW, null).fechaLarga).toBe('Santiago, 1 de septiembre de 2026');
  });

  it('sin numero de cotizacion, la referencia cae al quote_id', () => {
    const view = buildOrdenView(ROW, null);
    expect(view.referencia).toBe(`Ref.: Cotización ${ROW.quote_id} (v1)`);
  });

  it('el abastecimiento pierde los guiones bajos', () => {
    const view = buildOrdenView(ROW, null);
    expect(view.lineas[0].abastecimiento).toBe('stock inmediato');
    expect(view.lineas[1].abastecimiento).toBe('por comprar importar');
  });

  it('una fila vieja sin costos muestra em-dash y NO inventa un total parcial', () => {
    const vieja: PedidoRow = {
      ...ROW,
      lineas: [
        { sku_proveedor: 'INT-1', mpn: 'X', nombre: 'A', cantidad: 1, costo_unitario_usd: 5, costo_total_usd: 5 },
        { sku_proveedor: 'INT-2', mpn: 'Y', nombre: 'B', cantidad: 1 }, // sin costos (fila pre-cambio)
      ],
    };
    const view = buildOrdenView(vieja, null);
    expect(view.lineas[1].costoUnitario).toBe('—');
    expect(view.lineas[1].costoTotal).toBe('—');
    expect(view.totalFmt).toBe('—'); // 5 a secas seria un total falso
  });

  it('estado failed y processing generan aviso; sent no', () => {
    expect(buildOrdenView({ ...ROW, estado: 'failed' }, null).estadoAviso).toContain('FALLÓ');
    expect(buildOrdenView({ ...ROW, estado: 'processing' }, null).estadoAviso).toContain('a medio emitir');
    expect(buildOrdenView(ROW, null).estadoAviso).toBe('');
  });

  it('sin razon social no hay bloque de cliente', () => {
    expect(buildOrdenView({ ...ROW, razon_social: null }, null).cliente).toBeNull();
  });

  it('sanea mojibake WinAnsi en descripcion, sku y razon social', () => {
    const sucia: PedidoRow = {
      ...ROW,
      razon_social: 'Acme SpA',
      lineas: [{ sku_proveedor: 'INT1', mpn: 'X', nombre: 'Producto', cantidad: 1, costo_unitario_usd: 1, costo_total_usd: 1 }],
    };
    const view = buildOrdenView(sucia, null);
    expect(view.cliente?.razonSocial).toBe('Acme? SpA');
    expect(view.lineas[0].sku).toBe('INT?1');
    expect(view.lineas[0].descripcion).toBe('Prod?ucto');
  });
});
