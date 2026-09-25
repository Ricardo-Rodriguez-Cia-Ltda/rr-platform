import { cargarDatosPedido, cargarDespacho, registrarEvento } from '../../../../src/lib/datos-pedido.js';
import { ESTADOS_DESPACHO, requisitoTransicion, transicionDespachoValida, type EstadoDespacho } from '../../../../src/lib/despachos.js';
import { evaluarPedidoEntregado } from '../../../../src/lib/entrega.js';
import { faltantesParaListo } from '../../../../src/lib/lineas.js';
import { supabasePatch } from '../../../../src/lib/supabase.js';

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

export async function POST(req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as { id?: number; hacia?: string; nota?: string } | null;
  const id = Number(b?.id);
  const hacia = String(b?.hacia ?? '') as EstadoDespacho;
  if (!Number.isInteger(id) || id <= 0 || !ESTADOS_DESPACHO.includes(hacia)) return json({ error: 'cuerpo_invalido' }, 400);
  const nota = typeof b?.nota === 'string' && b.nota.trim() ? b.nota.trim() : null;

  const d = await cargarDespacho(id);
  if (d === null) return json({ error: 'upstream' }, 503);
  if (d === undefined) return json({ error: 'despacho_no_encontrado' }, 404);
  if (d.estado === hacia) return json({ ok: true, estado: hacia });
  if (!transicionDespachoValida(d.estado, hacia, d.modalidad)) return json({ error: 'transicion_invalida', desde: d.estado }, 409);
  const falta = requisitoTransicion(d, hacia);
  if (falta) return json({ error: 'falta_dato', detalle: falta }, 409);

  if (hacia === 'listo') {
    const datos = await cargarDatosPedido(d.quote_id, d.quote_version);
    if (!datos) return json({ error: 'upstream' }, 503);
    const faltan = faltantesParaListo(d, datos.recepciones, datos.despachos);
    if (faltan.length > 0) return json({ error: 'falta_mercaderia', faltan }, 409);
  }

  const ahora = new Date().toISOString();
  const cambio: Record<string, unknown> = { estado: hacia, updated_at: ahora };
  if (hacia === 'en_ruta') cambio.despachado_at = ahora;
  if (hacia === 'entregado') cambio.entregado_at = ahora;
  const res = await supabasePatch(`/despachos?id=eq.${id}&estado=eq.${d.estado}`, cambio);
  if (res === null) return json({ error: 'upstream' }, 503);
  if (res.length === 0) return json({ error: 'transicion_invalida', desde: d.estado }, 409);

  await registrarEvento(id, d.estado, hacia, nota);
  if (hacia === 'entregado') await evaluarPedidoEntregado(d.quote_id, d.quote_version);
  return json({ ok: true, estado: hacia });
}
