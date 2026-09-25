import { supabaseGet, supabasePatch, supabasePost } from '../../../../src/lib/supabase.js';
import { admiteRecepcion, estadoTrasRecepcion, type EstadoCompra, type ModalidadCompra } from '../../../../src/lib/compras.js';
import { claveLinea } from '../../../../src/lib/lineas.js';

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

// Registra lo que llego de una linea y recalcula el estado de la compra.
export async function POST(req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as { po_id?: string; mpn?: string; cantidad?: number; nota?: string } | null;
  const poId = String(b?.po_id ?? '');
  const mpn = String(b?.mpn ?? '');
  const cantidad = Number(b?.cantidad);
  if (!poId || !mpn || !Number.isInteger(cantidad) || cantidad <= 0) return json({ error: 'cuerpo_invalido' }, 400);

  const filas = await supabaseGet(`/pedidos?po_id=eq.${encodeURIComponent(poId)}&select=lineas,estado_compra,modalidad_compra&limit=1`);
  if (filas === null) return json({ error: 'upstream' }, 503);
  const f = filas[0] as { lineas: Array<{ mpn?: string | null; cantidad?: number }>; estado_compra: EstadoCompra; modalidad_compra: ModalidadCompra | null } | undefined;
  if (!f) return json({ error: 'compra_no_encontrada' }, 404);
  if (!admiteRecepcion(f.estado_compra, f.modalidad_compra)) return json({ error: 'no_admite_recepcion', estado: f.estado_compra }, 409);

  // El mismo mpn puede aparecer en mas de una linea de la misma OC: se suma.
  const comprado = new Map<string, number>();
  (f.lineas ?? []).forEach((l, i) => {
    const clave = claveLinea(l, i);
    comprado.set(clave, (comprado.get(clave) ?? 0) + Number(l.cantidad ?? 0));
  });
  if (!comprado.has(mpn)) return json({ error: 'linea_desconocida' }, 400);

  const previas = await supabaseGet(`/recepciones?po_id=eq.${encodeURIComponent(poId)}&select=mpn,cantidad`);
  if (previas === null) return json({ error: 'upstream' }, 503);
  const recibido = new Map<string, number>();
  for (const r of previas as Array<{ mpn: string; cantidad: number }>) recibido.set(r.mpn, (recibido.get(r.mpn) ?? 0) + Number(r.cantidad));
  const pendiente = (comprado.get(mpn) ?? 0) - (recibido.get(mpn) ?? 0);
  if (cantidad > pendiente) return json({ error: 'excede_comprado', pendiente }, 409);

  const nota = typeof b?.nota === 'string' && b.nota.trim() ? b.nota.trim() : null;
  const creada = await supabasePost('/recepciones', { po_id: poId, mpn, cantidad, nota });
  if (creada === null) return json({ error: 'upstream' }, 503);

  recibido.set(mpn, (recibido.get(mpn) ?? 0) + cantidad);
  const nuevo = estadoTrasRecepcion(comprado, recibido);
  if (nuevo !== f.estado_compra) {
    // Condicional: si otra recepcion ya lo movio, su escritura manda; la
    // recepcion quedo registrada igual.
    await supabasePatch(`/pedidos?po_id=eq.${encodeURIComponent(poId)}&estado_compra=eq.${f.estado_compra}`, { estado_compra: nuevo });
  }
  return json({ ok: true, estado: nuevo });
}
