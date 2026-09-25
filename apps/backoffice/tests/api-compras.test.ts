import { afterEach, describe, expect, it, vi } from 'vitest';

const supabaseGet = vi.fn(), supabasePatch = vi.fn(), supabasePost = vi.fn();
vi.mock('../src/lib/supabase.js', () => ({
  supabaseGet: (...a: unknown[]) => supabaseGet(...a),
  supabasePatch: (...a: unknown[]) => supabasePatch(...a),
  supabasePost: (...a: unknown[]) => supabasePost(...a),
}));
const evaluarPedidoEntregado = vi.fn(async (..._a: unknown[]) => true);
vi.mock('../src/lib/entrega.js', () => ({ evaluarPedidoEntregado: (...a: unknown[]) => evaluarPedidoEntregado(...a) }));

const { POST: registrar } = await import('../app/api/compras/registrar/route.js');
const { POST: transicion } = await import('../app/api/compras/transicion/route.js');
const { POST: recepcion } = await import('../app/api/compras/recepcion/route.js');

afterEach(() => { vi.clearAllMocks(); });
const req = (body: unknown) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });
const OC = { po_id: 'oc-1', quote_id: 'q', quote_version: '1', estado_compra: 'por_comprar', modalidad_compra: null, lineas: [{ mpn: 'A', cantidad: 2 }, { mpn: 'B', cantidad: 1 }] };

describe('POST /api/compras/registrar', () => {
  it('desde por_comprar exige modalidad y numero, y pasa a comprada con escritura condicional', async () => {
    supabaseGet.mockResolvedValue([OC]);
    supabasePatch.mockResolvedValue([{}]);
    expect((await registrar(req({ po_id: 'oc-1', modalidad: 'retiro' }))).status).toBe(400);
    const res = await registrar(req({ po_id: 'oc-1', modalidad: 'retiro', numero_pedido_mayorista: 'INT-99', llegada_estimada: '2026-09-30' }));
    expect(res.status).toBe(200);
    const [ruta, cambio] = supabasePatch.mock.calls[0];
    expect(ruta).toContain('estado_compra=eq.por_comprar');
    expect(cambio).toMatchObject({ estado_compra: 'comprada', modalidad_compra: 'retiro', numero_pedido_mayorista: 'INT-99', llegada_estimada: '2026-09-30' });
    expect(typeof cambio.comprada_at).toBe('string');
  });
  it('en un estado editable corrige datos sin cambiar el estado; la modalidad solo en comprada', async () => {
    supabaseGet.mockResolvedValue([{ ...OC, estado_compra: 'en_camino', modalidad_compra: 'despacho_mayorista' }]);
    supabasePatch.mockResolvedValue([{}]);
    await registrar(req({ po_id: 'oc-1', guia_mayorista: 'G-1', modalidad: 'retiro' }));
    const cambio = supabasePatch.mock.calls[0][1];
    expect(cambio).toEqual({ guia_mayorista: 'G-1' });
  });
  it('409 si la compra esta cerrada; 404 si no existe; 400 con modalidad invalida', async () => {
    supabaseGet.mockResolvedValue([{ ...OC, estado_compra: 'recibida' }]);
    expect((await registrar(req({ po_id: 'oc-1', nota_compra: 'x' }))).status).toBe(409);
    supabaseGet.mockResolvedValue([]);
    expect((await registrar(req({ po_id: 'oc-1', modalidad: 'retiro', numero_pedido_mayorista: '1' }))).status).toBe(404);
    expect((await registrar(req({ po_id: 'oc-1', modalidad: 'avion' }))).status).toBe(400);
  });
});

describe('POST /api/compras/transicion', () => {
  it('valida contra la modalidad y escribe condicional', async () => {
    supabaseGet.mockResolvedValue([{ ...OC, estado_compra: 'comprada', modalidad_compra: 'retiro' }]);
    supabasePatch.mockResolvedValue([{}]);
    expect((await transicion(req({ po_id: 'oc-1', hacia: 'en_camino' }))).status).toBe(409);
    expect((await transicion(req({ po_id: 'oc-1', hacia: 'por_retirar' }))).status).toBe(200);
    expect(supabasePatch.mock.calls[0][0]).toContain('estado_compra=eq.comprada');
  });
  it('comprada no se alcanza por aqui (va por registrar) y la misma transicion no escribe', async () => {
    supabaseGet.mockResolvedValue([{ ...OC, estado_compra: 'por_retirar', modalidad_compra: 'retiro' }]);
    expect((await transicion(req({ po_id: 'oc-1', hacia: 'comprada' }))).status).toBe(400);
    expect((await transicion(req({ po_id: 'oc-1', hacia: 'por_retirar' }))).status).toBe(200);
    expect(supabasePatch).not.toHaveBeenCalled();
  });
  it('entregada_al_cliente evalua si el pedido quedo entregado', async () => {
    supabaseGet.mockResolvedValue([{ ...OC, estado_compra: 'directo_al_cliente', modalidad_compra: 'directo_cliente' }]);
    supabasePatch.mockResolvedValue([{}]);
    expect((await transicion(req({ po_id: 'oc-1', hacia: 'entregada_al_cliente' }))).status).toBe(200);
    expect(evaluarPedidoEntregado).toHaveBeenCalledWith('q', '1');
  });
  it('carrera: el PATCH condicional no afecta filas -> 409', async () => {
    supabaseGet.mockResolvedValue([{ ...OC, estado_compra: 'comprada', modalidad_compra: 'retiro' }]);
    supabasePatch.mockResolvedValue([]);
    expect((await transicion(req({ po_id: 'oc-1', hacia: 'por_retirar' }))).status).toBe(409);
  });
});

describe('POST /api/compras/recepcion', () => {
  const conDatos = (estado: string, recibidas: unknown[]) => {
    supabaseGet.mockImplementation(async (ruta: string) =>
      ruta.startsWith('/pedidos') ? [{ ...OC, estado_compra: estado, modalidad_compra: 'retiro' }] : recibidas);
  };
  it('registra la recepcion y pasa a recibida_parcial', async () => {
    conDatos('por_retirar', []);
    supabasePost.mockResolvedValue([{ id: 1 }]);
    supabasePatch.mockResolvedValue([{}]);
    const res = await recepcion(req({ po_id: 'oc-1', mpn: 'A', cantidad: 2 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ estado: 'recibida_parcial' });
    expect(supabasePost.mock.calls[0]).toEqual(['/recepciones', { po_id: 'oc-1', mpn: 'A', cantidad: 2, nota: null }]);
    expect(supabasePatch.mock.calls[0][0]).toContain('estado_compra=eq.por_retirar');
  });
  it('completa la compra: recibida', async () => {
    conDatos('recibida_parcial', [{ mpn: 'A', cantidad: 2 }]);
    supabasePost.mockResolvedValue([{ id: 2 }]);
    supabasePatch.mockResolvedValue([{}]);
    expect(await (await recepcion(req({ po_id: 'oc-1', mpn: 'B', cantidad: 1 }))).json()).toMatchObject({ estado: 'recibida' });
  });
  it('rechaza recibir mas de lo comprado, lineas ajenas y estados que no admiten recepcion', async () => {
    conDatos('por_retirar', [{ mpn: 'A', cantidad: 2 }]);
    expect((await recepcion(req({ po_id: 'oc-1', mpn: 'A', cantidad: 1 }))).status).toBe(409);
    expect((await recepcion(req({ po_id: 'oc-1', mpn: 'Z', cantidad: 1 }))).status).toBe(400);
    conDatos('por_comprar', []);
    expect((await recepcion(req({ po_id: 'oc-1', mpn: 'A', cantidad: 1 }))).status).toBe(409);
    expect((await recepcion(req({ po_id: 'oc-1', mpn: 'A', cantidad: 0 }))).status).toBe(400);
    expect(supabasePost).not.toHaveBeenCalled();
  });
  it('mpn repetido en la misma OC se suma al calcular lo comprado', async () => {
    const OC_REPETIDO = { ...OC, lineas: [{ mpn: 'A', cantidad: 1 }, { mpn: 'A', cantidad: 1 }] };
    supabaseGet.mockImplementation(async (ruta: string) =>
      ruta.startsWith('/pedidos') ? [{ ...OC_REPETIDO, estado_compra: 'por_retirar', modalidad_compra: 'retiro' }] : []);
    supabasePost.mockResolvedValue([{ id: 3 }]);
    supabasePatch.mockResolvedValue([{}]);
    const res = await recepcion(req({ po_id: 'oc-1', mpn: 'A', cantidad: 2 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ estado: 'recibida' });
  });
  it('la recepcion queda registrada aunque el PATCH de estado falle: 200 con aviso y estado previo', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    conDatos('por_retirar', []);
    supabasePost.mockResolvedValue([{ id: 4 }]);
    supabasePatch.mockResolvedValue(null);
    const res = await recepcion(req({ po_id: 'oc-1', mpn: 'A', cantidad: 2 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ ok: true, estado: 'por_retirar', aviso: 'estado_no_actualizado' });
    expect(errorSpy).toHaveBeenCalled();
    errorSpy.mockRestore();
  });
});
