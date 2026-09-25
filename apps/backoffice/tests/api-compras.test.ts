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
  it('cambiar a directo_cliente con un despacho usando la OC -> 409, sin PATCH', async () => {
    supabaseGet.mockImplementation(async (ruta: string) =>
      ruta.startsWith('/pedidos') ? [{ ...OC, estado_compra: 'comprada', modalidad_compra: 'retiro' }] : [{ despacho_id: 1 }]);
    const res = await registrar(req({ po_id: 'oc-1', modalidad: 'directo_cliente' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('oc_con_despachos');
    expect(supabasePatch).not.toHaveBeenCalled();
  });
  it('cambiar a directo_cliente sin despachos -> 200 y consulta despacho_lineas del po correcto', async () => {
    supabaseGet.mockImplementation(async (ruta: string) =>
      ruta.startsWith('/pedidos') ? [{ ...OC, estado_compra: 'comprada', modalidad_compra: 'retiro' }] : []);
    supabasePatch.mockResolvedValue([{}]);
    const res = await registrar(req({ po_id: 'oc-1', modalidad: 'directo_cliente' }));
    expect(res.status).toBe(200);
    const rutaLineas = supabaseGet.mock.calls.map((c) => c[0]).find((r: string) => r.startsWith('/despacho_lineas'));
    expect(rutaLineas).toContain('po_id=eq.oc-1');
    expect(rutaLineas).toContain('despachos.estado=neq.anulado');
  });
  it('editar solo guia_mayorista (sin cambiar modalidad) no consulta despacho_lineas', async () => {
    supabaseGet.mockImplementation(async (ruta: string) =>
      ruta.startsWith('/pedidos') ? [{ ...OC, estado_compra: 'en_camino', modalidad_compra: 'despacho_mayorista' }] : []);
    supabasePatch.mockResolvedValue([{}]);
    const res = await registrar(req({ po_id: 'oc-1', guia_mayorista: 'G-1' }));
    expect(res.status).toBe(200);
    expect(supabaseGet.mock.calls.some((c) => String(c[0]).startsWith('/despacho_lineas'))).toBe(false);
  });
  it('si la lectura de despacho_lineas falla, 503 y sin PATCH', async () => {
    supabaseGet.mockImplementation(async (ruta: string) =>
      ruta.startsWith('/pedidos') ? [{ ...OC, estado_compra: 'comprada', modalidad_compra: 'retiro' }] : null);
    const res = await registrar(req({ po_id: 'oc-1', modalidad: 'directo_cliente' }));
    expect(res.status).toBe(503);
    expect(supabasePatch).not.toHaveBeenCalled();
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
  it('anular con un despacho activo usando la OC -> 409, sin PATCH', async () => {
    supabaseGet.mockImplementation(async (ruta: string) =>
      ruta.startsWith('/pedidos') ? [{ ...OC, estado_compra: 'comprada', modalidad_compra: 'retiro' }] : [{ despacho_id: 1 }]);
    const res = await transicion(req({ po_id: 'oc-1', hacia: 'anulada' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('oc_con_despachos');
    expect(supabasePatch).not.toHaveBeenCalled();
  });
  it('anular sin despachos usando la OC -> 200', async () => {
    supabaseGet.mockImplementation(async (ruta: string) =>
      ruta.startsWith('/pedidos') ? [{ ...OC, estado_compra: 'comprada', modalidad_compra: 'retiro' }] : []);
    supabasePatch.mockResolvedValue([{}]);
    const res = await transicion(req({ po_id: 'oc-1', hacia: 'anulada' }));
    expect(res.status).toBe(200);
    const rutaLineas = supabaseGet.mock.calls.map((c) => c[0]).find((r: string) => r.startsWith('/despacho_lineas'));
    expect(rutaLineas).toContain('po_id=eq.oc-1');
    expect(rutaLineas).toContain('despachos.estado=neq.anulado');
  });
  it('directo_al_cliente con un despacho activo usando la OC -> 409, sin PATCH', async () => {
    supabaseGet.mockImplementation(async (ruta: string) =>
      ruta.startsWith('/pedidos') ? [{ ...OC, estado_compra: 'comprada', modalidad_compra: 'directo_cliente' }] : [{ despacho_id: 1 }]);
    const res = await transicion(req({ po_id: 'oc-1', hacia: 'directo_al_cliente' }));
    expect(res.status).toBe(409);
    expect((await res.json()).error).toBe('oc_con_despachos');
    expect(supabasePatch).not.toHaveBeenCalled();
  });
  it('si la lectura de despacho_lineas falla al anular, 503 y sin PATCH', async () => {
    supabaseGet.mockImplementation(async (ruta: string) =>
      ruta.startsWith('/pedidos') ? [{ ...OC, estado_compra: 'comprada', modalidad_compra: 'retiro' }] : null);
    const res = await transicion(req({ po_id: 'oc-1', hacia: 'anulada' }));
    expect(res.status).toBe(503);
    expect(supabasePatch).not.toHaveBeenCalled();
  });
  it('transiciones que no anulan ni van a directo_al_cliente no consultan despacho_lineas', async () => {
    supabaseGet.mockImplementation(async (ruta: string) =>
      ruta.startsWith('/pedidos') ? [{ ...OC, estado_compra: 'comprada', modalidad_compra: 'retiro' }] : []);
    supabasePatch.mockResolvedValue([{}]);
    const res = await transicion(req({ po_id: 'oc-1', hacia: 'por_retirar' }));
    expect(res.status).toBe(200);
    expect(supabaseGet.mock.calls.some((c) => String(c[0]).startsWith('/despacho_lineas'))).toBe(false);
  });
});

describe('POST /api/compras/recepcion', () => {
  // Simula postgres real: antes del insert (supabasePost aun no se llamo), el
  // GET a /recepciones devuelve lo que ya habia; despues del insert (la
  // relectura que hace la ruta para evitar la carrera), devuelve eso mas la
  // fila recien creada.
  const conDatos = (estado: string, recibidas: unknown[]) => {
    supabaseGet.mockImplementation(async (ruta: string) => {
      if (ruta.startsWith('/pedidos')) return [{ ...OC, estado_compra: estado, modalidad_compra: 'retiro' }];
      const creadas = supabasePost.mock.calls
        .filter((c) => c[0] === '/recepciones')
        .map((c) => c[1] as { mpn: string; cantidad: number });
      return [...recibidas, ...creadas.map((c) => ({ mpn: c.mpn, cantidad: c.cantidad }))];
    });
  };
  it('registra la recepcion y pasa a recibida_parcial', async () => {
    conDatos('por_retirar', []);
    supabasePost.mockResolvedValue([{ id: 1 }]);
    supabasePatch.mockResolvedValue([{}]);
    const res = await recepcion(req({ po_id: 'oc-1', mpn: 'A', cantidad: 2 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ estado: 'recibida_parcial' });
    expect(supabasePost.mock.calls[0]).toEqual(['/recepciones', { po_id: 'oc-1', mpn: 'A', cantidad: 2, nota: null }]);
    expect(supabasePatch.mock.calls[0][0]).toContain('estado_compra=in.(comprada,por_retirar,en_camino,recibida_parcial)');
    expect(supabasePatch.mock.calls[0][0]).toContain('po_id=eq.oc-1');
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
    supabaseGet.mockImplementation(async (ruta: string) => {
      if (ruta.startsWith('/pedidos')) return [{ ...OC_REPETIDO, estado_compra: 'por_retirar', modalidad_compra: 'retiro' }];
      const creadas = supabasePost.mock.calls
        .filter((c) => c[0] === '/recepciones')
        .map((c) => c[1] as { mpn: string; cantidad: number });
      return creadas.map((c) => ({ mpn: c.mpn, cantidad: c.cantidad }));
    });
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
  it('carrera: la relectura fresca manda por sobre la lectura stale y llega a recibida', async () => {
    // La lectura previa al insert (antes de que otra recepcion concurrente
    // terminara B) solo ve A con 1 de 2. La relectura de despues del insert
    // ya ve la recepcion propia de A mas la de B que llego mientras tanto.
    supabaseGet.mockImplementation(async (ruta: string) => {
      if (ruta.startsWith('/pedidos')) return [{ ...OC, estado_compra: 'por_retirar', modalidad_compra: 'retiro' }];
      const yaSePosteo = supabasePost.mock.calls.some((c) => c[0] === '/recepciones');
      return yaSePosteo
        ? [{ mpn: 'A', cantidad: 1 }, { mpn: 'A', cantidad: 1 }, { mpn: 'B', cantidad: 1 }]
        : [{ mpn: 'A', cantidad: 1 }];
    });
    supabasePost.mockResolvedValue([{ id: 9 }]);
    supabasePatch.mockResolvedValue([{}]);
    const res = await recepcion(req({ po_id: 'oc-1', mpn: 'A', cantidad: 1 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ estado: 'recibida' });
    expect(supabasePatch.mock.calls[0][0]).toContain('estado_compra=in.(comprada,por_retirar,en_camino,recibida_parcial)');
    expect(supabasePatch.mock.calls[0][1]).toEqual({ estado_compra: 'recibida' });
  });
  it('si la relectura fresca falla, usa el valor calculado localmente', async () => {
    conDatos('por_retirar', []);
    supabasePost.mockResolvedValue([{ id: 5 }]);
    supabasePatch.mockResolvedValue([{}]);
    let llamadas = 0;
    const original = supabaseGet.getMockImplementation()!;
    supabaseGet.mockImplementation(async (ruta: string) => {
      if (!ruta.startsWith('/pedidos')) {
        llamadas += 1;
        if (llamadas === 2) return null; // la relectura post-insert falla
      }
      return original(ruta);
    });
    const res = await recepcion(req({ po_id: 'oc-1', mpn: 'A', cantidad: 2 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ estado: 'recibida_parcial' });
  });
});
