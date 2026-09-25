import { cargarDespacho } from '../../../../src/lib/datos-pedido.js';
import { COURIERS } from '../../../../src/lib/couriers.js';
import { supabasePatch } from '../../../../src/lib/supabase.js';

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

// Siempre editables (el cobro del envio puede pagarse despues de entregar).
const SIEMPRE = ['costo_clp', 'cobrado_clp', 'cobro_pagado', 'nota'] as const;
// Solo mientras el despacho no esta cerrado.
const MIENTRAS_ABIERTO = [
  'courier', 'direccion', 'comuna', 'ciudad', 'contacto_nombre', 'contacto_telefono',
  'fecha_programada', 'responsable', 'numero_seguimiento',
] as const;

export async function POST(req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const id = Number(b?.id);
  if (!Number.isInteger(id) || id <= 0) return json({ error: 'cuerpo_invalido' }, 400);

  const cambio: Record<string, unknown> = {};
  for (const campo of [...SIEMPRE, ...MIENTRAS_ABIERTO]) {
    if (!b || !(campo in b)) continue;
    const v = b[campo];
    if (campo === 'cobro_pagado') { cambio[campo] = v === true; continue; }
    if (campo === 'costo_clp' || campo === 'cobrado_clp') {
      if (v === null || v === '') { cambio[campo] = null; continue; }
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) return json({ error: 'monto_invalido', campo }, 400);
      cambio[campo] = n; continue;
    }
    const t = typeof v === 'string' && v.trim() ? v.trim() : null;
    if (campo === 'fecha_programada' && t && !FECHA.test(t)) return json({ error: 'fecha_invalida' }, 400);
    if (campo === 'courier' && t && !(t in COURIERS)) return json({ error: 'courier_invalido' }, 400);
    cambio[campo] = t;
  }
  if (Object.keys(cambio).length === 0) return json({ error: 'sin_cambios' }, 400);

  const d = await cargarDespacho(id);
  if (d === null) return json({ error: 'upstream' }, 503);
  if (d === undefined) return json({ error: 'despacho_no_encontrado' }, 404);
  const cerrado = d.estado === 'entregado' || d.estado === 'anulado';
  if (cerrado && Object.keys(cambio).some((c) => (MIENTRAS_ABIERTO as readonly string[]).includes(c))) {
    return json({ error: 'despacho_cerrado', estado: d.estado }, 409);
  }

  const res = await supabasePatch(`/despachos?id=eq.${id}`, { ...cambio, updated_at: new Date().toISOString() });
  if (res === null) return json({ error: 'upstream' }, 503);
  return json({ ok: true });
}
