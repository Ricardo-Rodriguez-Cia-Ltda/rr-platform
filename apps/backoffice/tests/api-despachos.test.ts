import { afterEach, describe, expect, it, vi } from 'vitest';

const cargarDatosPedido = vi.fn(), cargarDespacho = vi.fn(), registrarEvento = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../src/lib/datos-pedido.js', () => ({
  cargarDatosPedido: (...a: unknown[]) => cargarDatosPedido(...a),
  cargarDespacho: (...a: unknown[]) => cargarDespacho(...a),
  registrarEvento: (...a: unknown[]) => registrarEvento(...a),
}));
const supabaseRpc = vi.fn(), supabasePatch = vi.fn();
vi.mock('../src/lib/supabase.js', () => ({
  supabaseRpc: (...a: unknown[]) => supabaseRpc(...a),
  supabasePatch: (...a: unknown[]) => supabasePatch(...a),
}));
const evaluarPedidoEntregado = vi.fn(async (..._a: unknown[]) => true);
vi.mock('../src/lib/entrega.js', () => ({ evaluarPedidoEntregado: (...a: unknown[]) => evaluarPedidoEntregado(...a) }));

const { POST: crear } = await import('../app/api/despachos/route.js');
const { POST: editar } = await import('../app/api/despachos/editar/route.js');
const { POST: transicion } = await import('../app/api/despachos/transicion/route.js');

afterEach(() => { vi.clearAllMocks(); });
const req = (body: unknown) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });

const FILA = { po_id: 'oc-1', quote_id: 'q', quote_version: '1', estado_negocio: 'pagado', estado_compra: 'recibida', modalidad_compra: 'retiro', lineas: [{ mpn: 'A', nombre: 'Toner A', cantidad: 2 }] };
const DESPACHO = {
  id: 5, quote_id: 'q', quote_version: '1', modalidad: 'courier', courier: 'starken', estado: 'por_preparar',
  numero_seguimiento: null, lineas: [{ po_id: 'oc-1', mpn: 'A', cantidad: 2 }],
};

describe('POST /api/despachos', () => {
  const cuerpo = { quote_id: 'q', quote_version: '1', modalidad: 'courier', courier: 'starken', comuna: 'Ñuñoa', lineas: [{ po_id: 'oc-1', mpn: 'A', cantidad: 1 }] };
  it('valida la asignacion con datos frescos y crea por RPC', async () => {
    cargarDatosPedido.mockResolvedValue({ filas: [FILA], recepciones: [], despachos: [] });
    supabaseRpc.mockResolvedValue({ id: 9 });
    const res = await crear(req(cuerpo));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, id: 9 });
    const [fn, args] = supabaseRpc.mock.calls[0];
    expect(fn).toBe('crear_despacho');
    expect(args.p_lineas).toEqual([{ po_id: 'oc-1', mpn: 'A', cantidad: 1 }]);
    expect(args.p_despacho).toMatchObject({ quote_id: 'q', modalidad: 'courier', courier: 'starken', comuna: 'Ñuñoa' });
  });
  it('409 si se asigna mas de lo pendiente o el pedido no esta pagado', async () => {
    cargarDatosPedido.mockResolvedValue({ filas: [FILA], recepciones: [], despachos: [{ ...DESPACHO, lineas: [{ po_id: 'oc-1', mpn: 'A', cantidad: 2 }] }] });
    expect((await crear(req(cuerpo))).status).toBe(409);
    cargarDatosPedido.mockResolvedValue({ filas: [{ ...FILA, estado_negocio: 'nuevo' }], recepciones: [], despachos: [] });
    expect((await crear(req(cuerpo))).status).toBe(409);
    expect(supabaseRpc).not.toHaveBeenCalled();
  });
  it('400 por modalidad invalida, courier faltante o cantidades no enteras', async () => {
    expect((await crear(req({ ...cuerpo, modalidad: 'dron' }))).status).toBe(400);
    expect((await crear(req({ ...cuerpo, courier: undefined }))).status).toBe(400);
    expect((await crear(req({ ...cuerpo, lineas: [{ po_id: 'oc-1', mpn: 'A', cantidad: 1.5 }] }))).status).toBe(400);
  });
});

describe('POST /api/despachos/transicion', () => {
  it('listo exige la mercaderia recibida', async () => {
    cargarDespacho.mockResolvedValue(DESPACHO);
    cargarDatosPedido.mockResolvedValue({ filas: [FILA], recepciones: [{ po_id: 'oc-1', mpn: 'A', cantidad: 1 }], despachos: [DESPACHO] });
    const res = await transicion(req({ id: 5, hacia: 'listo' }));
    expect(res.status).toBe(409);
    expect((await res.json()).faltan).toEqual(['A: faltan 1']);
    cargarDatosPedido.mockResolvedValue({ filas: [FILA], recepciones: [{ po_id: 'oc-1', mpn: 'A', cantidad: 2 }], despachos: [DESPACHO] });
    supabasePatch.mockResolvedValue([{}]);
    expect((await transicion(req({ id: 5, hacia: 'listo' }))).status).toBe(200);
    expect(supabasePatch.mock.calls[0][0]).toContain('estado=eq.por_preparar');
    expect(registrarEvento).toHaveBeenCalledWith(5, 'por_preparar', 'listo', null);
  });
  it('courier en ruta sin seguimiento -> 409 falta_dato', async () => {
    cargarDespacho.mockResolvedValue({ ...DESPACHO, estado: 'listo' });
    expect((await transicion(req({ id: 5, hacia: 'en_ruta' }))).status).toBe(409);
  });
  it('entregado estampa la fecha y evalua el pedido', async () => {
    cargarDespacho.mockResolvedValue({ ...DESPACHO, estado: 'en_ruta', numero_seguimiento: '1' });
    supabasePatch.mockResolvedValue([{}]);
    expect((await transicion(req({ id: 5, hacia: 'entregado' }))).status).toBe(200);
    expect(typeof supabasePatch.mock.calls[0][1].entregado_at).toBe('string');
    expect(evaluarPedidoEntregado).toHaveBeenCalledWith('q', '1');
  });
  it('404 si no existe, 409 por transicion invalida o carrera', async () => {
    cargarDespacho.mockResolvedValue(undefined);
    expect((await transicion(req({ id: 5, hacia: 'listo' }))).status).toBe(404);
    cargarDespacho.mockResolvedValue({ ...DESPACHO, estado: 'entregado' });
    expect((await transicion(req({ id: 5, hacia: 'anulado' }))).status).toBe(409);
    cargarDespacho.mockResolvedValue({ ...DESPACHO, estado: 'en_ruta', numero_seguimiento: '1' });
    supabasePatch.mockResolvedValue([]);
    expect((await transicion(req({ id: 5, hacia: 'fallido' }))).status).toBe(409);
  });
});

describe('POST /api/despachos/editar', () => {
  it('actualiza solo campos permitidos; costo y cobro se editan incluso entregado', async () => {
    cargarDespacho.mockResolvedValue({ ...DESPACHO, estado: 'entregado' });
    supabasePatch.mockResolvedValue([{}]);
    expect((await editar(req({ id: 5, cobro_pagado: true, cobrado_clp: 4000, estado: 'listo' }))).status).toBe(200);
    const cambio = supabasePatch.mock.calls[0][1];
    expect(cambio).toMatchObject({ cobro_pagado: true, cobrado_clp: 4000 });
    expect(cambio.estado).toBeUndefined();
    expect((await editar(req({ id: 5, direccion: 'Otra 123' }))).status).toBe(409);
  });
  it('400 con montos negativos o fecha invalida', async () => {
    cargarDespacho.mockResolvedValue(DESPACHO);
    expect((await editar(req({ id: 5, costo_clp: -1 }))).status).toBe(400);
    expect((await editar(req({ id: 5, fecha_programada: 'mañana' }))).status).toBe(400);
  });
});
