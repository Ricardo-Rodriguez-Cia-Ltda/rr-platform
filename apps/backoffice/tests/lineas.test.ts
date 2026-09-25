import { describe, expect, it } from 'vitest';
import type { FilaPedido } from '../src/lib/pedidos.js';
import {
  claveLinea, faltantesParaListo, lineasDePedido, pedidoCompletamenteEntregado, resumirLineas, validarAsignacion,
  type Despacho,
} from '../src/lib/lineas.js';

function fila(poId: string, lineas: Array<{ mpn?: string | null; nombre?: string; cantidad: number }>, extra: Partial<FilaPedido> = {}): FilaPedido {
  return {
    po_id: poId, quote_id: 'q', quote_version: '1', proveedor: poId, telefono: null, rut: null, razon_social: null,
    estado: 'sent', estado_negocio: 'pagado', created_at: '2026-09-25T00:00:00Z', neto_grupo_clp: null,
    lineas, estado_compra: 'comprada', modalidad_compra: 'retiro', ...extra,
  };
}
function despacho(id: number, estado: Despacho['estado'], lineas: Despacho['lineas']): Despacho {
  return {
    id, quote_id: 'q', quote_version: '1', modalidad: 'courier', courier: 'starken', estado,
    direccion: null, comuna: null, ciudad: null, contacto_nombre: null, contacto_telefono: null,
    fecha_programada: null, responsable: null, numero_seguimiento: null, costo_clp: null, cobrado_clp: null,
    cobro_pagado: false, nota: null, created_at: '2026-09-25T00:00:00Z', entregado_at: null, lineas,
  };
}

// Pedido de dos mayoristas: oc-int (A x2) y oc-tg (B x1).
const FILAS = [
  fila('oc-int', [{ mpn: 'A', nombre: 'Toner A', cantidad: 2 }]),
  fila('oc-tg', [{ mpn: 'B', nombre: 'Toner B', cantidad: 1 }]),
];

describe('claveLinea y lineasDePedido', () => {
  it('usa el mpn, o linea-<i> si no hay', () => {
    expect(claveLinea({ mpn: 'X1' }, 0)).toBe('X1');
    expect(claveLinea({ mpn: null }, 3)).toBe('linea-3');
  });
  it('marca las lineas directas al cliente y omite las ordenes anuladas', () => {
    const lineas = lineasDePedido([
      ...FILAS,
      fila('oc-dir', [{ mpn: 'C', cantidad: 1 }], { modalidad_compra: 'directo_cliente', estado_compra: 'entregada_al_cliente' }),
      fila('oc-anul', [{ mpn: 'D', cantidad: 1 }], { estado_compra: 'anulada' }),
    ]);
    expect(lineas.map((l) => `${l.poId}|${l.clave}|${l.directo}|${l.entregadaDirecto}`)).toEqual([
      'oc-int|A|false|false', 'oc-tg|B|false|false', 'oc-dir|C|true|true',
    ]);
  });
});

describe('resumirLineas', () => {
  it('cuenta recibido, asignado, en mano y entregado; los anulados no cuentan', () => {
    const r = resumirLineas(
      lineasDePedido(FILAS),
      [{ po_id: 'oc-int', mpn: 'A', cantidad: 2 }],
      [
        despacho(1, 'entregado', [{ po_id: 'oc-int', mpn: 'A', cantidad: 1 }]),
        despacho(2, 'por_preparar', [{ po_id: 'oc-int', mpn: 'A', cantidad: 1 }]),
        despacho(3, 'anulado', [{ po_id: 'oc-tg', mpn: 'B', cantidad: 1 }]),
      ],
    );
    const a = r.find((l) => l.clave === 'A')!;
    expect([a.recibida, a.asignada, a.enMano, a.entregada, a.pendiente]).toEqual([2, 2, 1, 1, 0]);
    const b = r.find((l) => l.clave === 'B')!;
    expect([b.asignada, b.pendiente]).toEqual([0, 1]);
  });
});

describe('validarAsignacion', () => {
  const resumen = () => resumirLineas(lineasDePedido(FILAS), [], [despacho(1, 'listo', [{ po_id: 'oc-int', mpn: 'A', cantidad: 1 }])]);
  it('acepta hasta lo pendiente (despacho parcial)', () => {
    expect(validarAsignacion(resumen(), [{ po_id: 'oc-int', mpn: 'A', cantidad: 1 }])).toBeNull();
  });
  it('rechaza vacio, mas de lo pendiente (tambien sumando duplicados) o una linea ajena', () => {
    expect(validarAsignacion(resumen(), [])).toMatch(/no tiene productos/);
    expect(validarAsignacion(resumen(), [{ po_id: 'oc-int', mpn: 'A', cantidad: 2 }])).toMatch(/quedan 1/);
    expect(validarAsignacion(resumen(), [
      { po_id: 'oc-int', mpn: 'A', cantidad: 1 }, { po_id: 'oc-int', mpn: 'A', cantidad: 1 },
    ])).toMatch(/quedan 1/);
    expect(validarAsignacion(resumen(), [{ po_id: 'oc-x', mpn: 'Z', cantidad: 1 }])).toMatch(/no está en el pedido/);
  });
  it('rechaza lineas que el mayorista despacha directo al cliente', () => {
    const r = resumirLineas(lineasDePedido([fila('oc-dir', [{ mpn: 'C', nombre: 'Toner C', cantidad: 1 }], { modalidad_compra: 'directo_cliente', estado_compra: 'directo_al_cliente' })]), [], []);
    expect(validarAsignacion(r, [{ po_id: 'oc-dir', mpn: 'C', cantidad: 1 }])).toMatch(/directo al cliente/);
  });
});

describe('faltantesParaListo', () => {
  it('lista lo que falta recibir, descontando lo que otros despachos ya tienen en mano', () => {
    const d2 = despacho(2, 'por_preparar', [{ po_id: 'oc-int', mpn: 'A', cantidad: 1 }]);
    const otros = [despacho(1, 'listo', [{ po_id: 'oc-int', mpn: 'A', cantidad: 1 }]), d2];
    expect(faltantesParaListo(d2, [{ po_id: 'oc-int', mpn: 'A', cantidad: 1 }], otros)).toEqual(['A: faltan 1']);
    expect(faltantesParaListo(d2, [{ po_id: 'oc-int', mpn: 'A', cantidad: 2 }], otros)).toEqual([]);
  });
});

describe('pedidoCompletamenteEntregado', () => {
  it('true solo cuando todo lo nuestro se entrego y lo directo quedo entregado', () => {
    const lineas = lineasDePedido(FILAS);
    const todo = [despacho(1, 'entregado', [{ po_id: 'oc-int', mpn: 'A', cantidad: 2 }, { po_id: 'oc-tg', mpn: 'B', cantidad: 1 }])];
    expect(pedidoCompletamenteEntregado(resumirLineas(lineas, [], todo))).toBe(true);
    const parcial = [despacho(1, 'entregado', [{ po_id: 'oc-int', mpn: 'A', cantidad: 2 }])];
    expect(pedidoCompletamenteEntregado(resumirLineas(lineas, [], parcial))).toBe(false);
    const directo = lineasDePedido([fila('oc-dir', [{ mpn: 'C', cantidad: 1 }], { modalidad_compra: 'directo_cliente', estado_compra: 'directo_al_cliente' })]);
    expect(pedidoCompletamenteEntregado(resumirLineas(directo, [], []))).toBe(false);
    expect(pedidoCompletamenteEntregado([])).toBe(false);
  });
});
