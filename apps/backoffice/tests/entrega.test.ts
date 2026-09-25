import { afterEach, describe, expect, it, vi } from 'vitest';

const cargarDatosPedido = vi.fn();
vi.mock('../src/lib/datos-pedido.js', () => ({ cargarDatosPedido: (...a: unknown[]) => cargarDatosPedido(...a) }));
const supabasePatch = vi.fn();
vi.mock('../src/lib/supabase.js', () => ({ supabasePatch: (...a: unknown[]) => supabasePatch(...a) }));

const { evaluarPedidoEntregado } = await import('../src/lib/entrega.js');

afterEach(() => { cargarDatosPedido.mockReset(); supabasePatch.mockReset(); });

const FILA = { po_id: 'oc-1', quote_id: 'q', quote_version: '1', estado_negocio: 'pagado', estado_compra: 'recibida', modalidad_compra: 'retiro', lineas: [{ mpn: 'A', cantidad: 2 }] };
const despacho = (estado: string, cantidad: number) => ({ id: 1, estado, lineas: [{ po_id: 'oc-1', mpn: 'A', cantidad }] });

describe('evaluarPedidoEntregado', () => {
  it('con todo entregado pasa el pedido pagado a entregado con escritura condicional', async () => {
    cargarDatosPedido.mockResolvedValue({ filas: [FILA], recepciones: [], despachos: [despacho('entregado', 2)] });
    supabasePatch.mockResolvedValue([{}]);
    expect(await evaluarPedidoEntregado('q', '1')).toBe(true);
    const [ruta, cambio] = supabasePatch.mock.calls[0];
    expect(ruta).toContain('estado_negocio=eq.pagado');
    expect(cambio.estado_negocio).toBe('entregado');
    expect(typeof cambio.entregado_at).toBe('string');
  });
  it('con algo pendiente no escribe', async () => {
    cargarDatosPedido.mockResolvedValue({ filas: [FILA], recepciones: [], despachos: [despacho('entregado', 1)] });
    expect(await evaluarPedidoEntregado('q', '1')).toBe(false);
    expect(supabasePatch).not.toHaveBeenCalled();
  });
  it('si el pedido no esta pagado o no se pudo leer, no escribe', async () => {
    cargarDatosPedido.mockResolvedValue({ filas: [{ ...FILA, estado_negocio: 'entregado' }], recepciones: [], despachos: [despacho('entregado', 2)] });
    expect(await evaluarPedidoEntregado('q', '1')).toBe(false);
    cargarDatosPedido.mockResolvedValue(null);
    expect(await evaluarPedidoEntregado('q', '1')).toBe(false);
    expect(supabasePatch).not.toHaveBeenCalled();
  });
});
