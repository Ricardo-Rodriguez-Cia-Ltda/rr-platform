import { supabaseGet, supabasePatch } from '../../../../src/lib/supabase.js';
import { ESTADOS_COMPRA_EDITABLES, MODALIDADES_COMPRA, type EstadoCompra, type ModalidadCompra } from '../../../../src/lib/compras.js';

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

// Registra la compra hecha en el portal del mayorista (por_comprar ->
// comprada) o corrige sus datos despues. La modalidad solo se cambia
// mientras la compra no avanzo de `comprada`.
export async function POST(req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const poId = texto(b?.po_id);
  if (!poId) return json({ error: 'cuerpo_invalido' }, 400);
  const modalidad = texto(b?.modalidad) as ModalidadCompra | null;
  if (modalidad && !MODALIDADES_COMPRA.includes(modalidad)) return json({ error: 'modalidad_invalida' }, 400);
  const llegada = texto(b?.llegada_estimada);
  if (llegada && !FECHA.test(llegada)) return json({ error: 'fecha_invalida' }, 400);

  const filas = await supabaseGet(`/pedidos?po_id=eq.${encodeURIComponent(poId)}&select=estado_compra,modalidad_compra&limit=1`);
  if (filas === null) return json({ error: 'upstream' }, 503);
  const actual = (filas[0] as { estado_compra?: EstadoCompra } | undefined)?.estado_compra;
  if (actual === undefined) return json({ error: 'compra_no_encontrada' }, 404);

  const datos: Record<string, unknown> = {};
  for (const campo of ['numero_pedido_mayorista', 'guia_mayorista', 'nota_compra'] as const) {
    if (b && campo in b) datos[campo] = texto(b[campo]);
  }
  if (b && 'llegada_estimada' in b) datos.llegada_estimada = llegada;

  if (actual === 'por_comprar') {
    if (!modalidad || !datos.numero_pedido_mayorista) return json({ error: 'faltan_datos', detalle: 'Modalidad y número de pedido del mayorista son obligatorios' }, 400);
    const cambio = { ...datos, estado_compra: 'comprada', modalidad_compra: modalidad, comprada_at: new Date().toISOString() };
    const res = await supabasePatch(`/pedidos?po_id=eq.${encodeURIComponent(poId)}&estado_compra=eq.por_comprar`, cambio);
    if (res === null) return json({ error: 'upstream' }, 503);
    if (res.length === 0) return json({ error: 'transicion_invalida', desde: actual }, 409);
    return json({ ok: true, estado: 'comprada' });
  }

  if (!ESTADOS_COMPRA_EDITABLES.includes(actual)) return json({ error: 'compra_cerrada', estado: actual }, 409);
  if (modalidad && actual === 'comprada') datos.modalidad_compra = modalidad;
  if (Object.keys(datos).length === 0) return json({ ok: true, estado: actual });
  const res = await supabasePatch(`/pedidos?po_id=eq.${encodeURIComponent(poId)}&estado_compra=eq.${actual}`, datos);
  if (res === null) return json({ error: 'upstream' }, 503);
  if (res.length === 0) return json({ error: 'transicion_invalida', desde: actual }, 409);
  return json({ ok: true, estado: actual });
}
