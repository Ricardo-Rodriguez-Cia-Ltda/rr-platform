import { describe, expect, it } from 'vitest';
import { agruparPedidos, contadores, transicionValida, type FilaPedido } from '../src/lib/pedidos.js';

const fila = (extra: Partial<FilaPedido>): FilaPedido => ({
  po_id: 'oc-q-1-1-ingram', quote_id: 'q-1', quote_version: '1', proveedor: 'ingram',
  telefono: '569', rut: null, razon_social: 'Acme', estado: 'sent', estado_negocio: 'nuevo',
  created_at: '2026-09-01T18:00:00Z', neto_grupo_clp: 1000,
  lineas: [{ nombre: 'A', cantidad: 1, precio_unitario_clp: 1000, subtotal_neto_clp: 1000 }],
  ...extra,
});

describe('transicionValida', () => {
  it.each([
    ['nuevo', 'pagado', true], ['pagado', 'entregado', true],
    ['nuevo', 'anulado', true], ['pagado', 'anulado', true],
    ['nuevo', 'entregado', false], ['entregado', 'anulado', false],
    ['entregado', 'pagado', false], ['anulado', 'pagado', false],
  ] as const)('%s -> %s = %s', (desde, hacia, esperado) => {
    expect(transicionValida(desde, hacia)).toBe(esperado);
  });
});

describe('agruparPedidos', () => {
  it('agrupa por quote_id+version y junta las OCs', () => {
    const grupos = agruparPedidos([
      fila({}), fila({ po_id: 'oc-q-1-1-intcomex', proveedor: 'intcomex', estado: 'failed' }),
      fila({ po_id: 'oc-q-2-1-ingram', quote_id: 'q-2', created_at: '2026-09-02T10:00:00Z' }),
    ]);
    expect(grupos).toHaveLength(2);
    expect(grupos[0].quoteId).toBe('q-2'); // mas reciente primero
    expect(grupos[1].ocs.map((o) => o.proveedor).sort()).toEqual(['ingram', 'intcomex']);
  });
  it('sin estado_negocio (fila pre-ALTER en una consulta vieja) asume nuevo', () => {
    const grupos = agruparPedidos([fila({ estado_negocio: undefined })]);
    expect(grupos[0].estadoNegocio).toBe('nuevo');
  });
});

describe('contadores', () => {
  it('cuenta pagados-por-entregar, nuevos y OC fallidas', () => {
    const grupos = agruparPedidos([
      fila({}),
      fila({ quote_id: 'q-2', po_id: 'p2', estado_negocio: 'pagado' }),
      fila({ quote_id: 'q-3', po_id: 'p3', estado_negocio: 'entregado' }),
      fila({ quote_id: 'q-4', po_id: 'p4', estado: 'failed' }),
    ]);
    expect(contadores(grupos)).toEqual({ porEntregar: 1, nuevos: 2, ocFallidas: 1 });
  });
});
