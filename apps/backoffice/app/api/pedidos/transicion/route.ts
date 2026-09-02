import { supabaseGet, supabasePatch } from '../../../../src/lib/supabase.js';
import { transicionValida, type EstadoNegocio } from '../../../../src/lib/pedidos.js';

const ESTADOS: EstadoNegocio[] = ['nuevo', 'pagado', 'entregado', 'anulado'];
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as
    | { quote_id?: string; quote_version?: string; hacia?: string } | null;
  const quoteId = String(body?.quote_id ?? '');
  const version = String(body?.quote_version ?? '');
  const hacia = String(body?.hacia ?? '') as EstadoNegocio;
  if (!quoteId || !version || !ESTADOS.includes(hacia)) return json({ error: 'cuerpo_invalido' }, 400);

  const filtro = `quote_id=eq.${encodeURIComponent(quoteId)}&quote_version=eq.${encodeURIComponent(version)}`;
  const filas = await supabaseGet(`/pedidos?${filtro}&select=estado_negocio&limit=1`);
  if (filas === null) return json({ error: 'upstream' }, 503);
  const actual = (filas[0] as { estado_negocio?: EstadoNegocio } | undefined)?.estado_negocio;
  if (actual === undefined) return json({ error: 'pedido_no_encontrado' }, 404);

  if (actual === hacia) return json({ ok: true, estado: actual }); // idempotente, sin escritura
  if (!transicionValida(actual, hacia)) return json({ error: 'transicion_invalida', desde: actual }, 409);

  const cambio: Record<string, unknown> = { estado_negocio: hacia };
  if (hacia === 'pagado') cambio.pagado_at = new Date().toISOString();
  if (hacia === 'entregado') cambio.entregado_at = new Date().toISOString();

  // Escritura condicional: solo PATCH si el estado sigue siendo el que leímos
  const filtroCondicional = `${filtro}&estado_negocio=eq.${encodeURIComponent(actual)}`;
  const filasAfectadas = await supabasePatch(`/pedidos?${filtroCondicional}`, cambio);
  if (filasAfectadas === null) return json({ error: 'upstream' }, 503);
  if (filasAfectadas.length === 0) return json({ error: 'transicion_invalida', desde: actual }, 409);
  return json({ ok: true, estado: hacia });
}
