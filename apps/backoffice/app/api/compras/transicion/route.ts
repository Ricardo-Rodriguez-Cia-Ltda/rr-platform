import { supabaseGet, supabasePatch } from '../../../../src/lib/supabase.js';
import { ESTADOS_COMPRA, transicionCompraValida, type EstadoCompra, type ModalidadCompra } from '../../../../src/lib/compras.js';
import { evaluarPedidoEntregado } from '../../../../src/lib/entrega.js';
import { ocConDespachos } from '../../../../src/lib/datos-pedido.js';

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

export async function POST(req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as { po_id?: string; hacia?: string } | null;
  const poId = String(b?.po_id ?? '');
  const hacia = String(b?.hacia ?? '') as EstadoCompra;
  if (!poId || !ESTADOS_COMPRA.includes(hacia)) return json({ error: 'cuerpo_invalido' }, 400);
  // comprada exige datos (modalidad, numero): va por /api/compras/registrar.
  // recibida_parcial y recibida las calcula la recepcion.
  if (hacia === 'comprada' || hacia === 'recibida_parcial' || hacia === 'recibida') return json({ error: 'usar_otra_ruta' }, 400);

  const filas = await supabaseGet(`/pedidos?po_id=eq.${encodeURIComponent(poId)}&select=quote_id,quote_version,estado_compra,modalidad_compra&limit=1`);
  if (filas === null) return json({ error: 'upstream' }, 503);
  const f = filas[0] as { quote_id: string; quote_version: string; estado_compra: EstadoCompra; modalidad_compra: ModalidadCompra | null } | undefined;
  if (!f) return json({ error: 'compra_no_encontrada' }, 404);
  if (f.estado_compra === hacia) return json({ ok: true, estado: hacia });
  if (!transicionCompraValida(f.estado_compra, hacia, f.modalidad_compra)) {
    return json({ error: 'transicion_invalida', desde: f.estado_compra }, 409);
  }

  // Anular o mandar directo al cliente saca la OC entera del plan de
  // despachos: si un despacho ya tomo lineas de ahi, quedaria varado.
  if (hacia === 'anulada' || hacia === 'directo_al_cliente') {
    const conDespachos = await ocConDespachos(poId);
    if (conDespachos === null) return json({ error: 'upstream' }, 503);
    if (conDespachos) return json({ error: 'oc_con_despachos' }, 409);
  }

  const res = await supabasePatch(
    `/pedidos?po_id=eq.${encodeURIComponent(poId)}&estado_compra=eq.${f.estado_compra}`,
    { estado_compra: hacia },
  );
  if (res === null) return json({ error: 'upstream' }, 503);
  if (res.length === 0) return json({ error: 'transicion_invalida', desde: f.estado_compra }, 409);
  if (hacia === 'entregada_al_cliente') await evaluarPedidoEntregado(f.quote_id, f.quote_version);
  return json({ ok: true, estado: hacia });
}
