import { cargarDatosPedido } from '../../../src/lib/datos-pedido.js';
import { MODALIDADES_DESPACHO, type ModalidadDespacho } from '../../../src/lib/despachos.js';
import { COURIERS, type CourierId } from '../../../src/lib/couriers.js';
import { lineasDePedido, resumirLineas, validarAsignacion, type DespachoLinea } from '../../../src/lib/lineas.js';
import { supabaseRpc } from '../../../src/lib/supabase.js';

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const monto = (v: unknown): '' | number => (v === undefined || v === null || v === '' ? '' : Number(v));

export async function POST(req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const quoteId = texto(b?.quote_id), version = texto(b?.quote_version);
  const modalidad = texto(b?.modalidad) as ModalidadDespacho;
  const courier = texto(b?.courier) as CourierId | '';
  const lineas = Array.isArray(b?.lineas) ? (b!.lineas as DespachoLinea[]) : [];
  if (!quoteId || !version || !MODALIDADES_DESPACHO.includes(modalidad)) return json({ error: 'cuerpo_invalido' }, 400);
  if (modalidad === 'courier' && !(courier && courier in COURIERS)) return json({ error: 'falta_courier' }, 400);
  if (lineas.some((l) => !texto(l?.po_id) || !texto(l?.mpn) || !Number.isInteger(l?.cantidad) || l.cantidad <= 0)) {
    return json({ error: 'lineas_invalidas' }, 400);
  }
  const fecha = texto(b?.fecha_programada);
  if (fecha && !FECHA.test(fecha)) return json({ error: 'fecha_invalida' }, 400);
  const costo = monto(b?.costo_clp), cobrado = monto(b?.cobrado_clp);
  for (const m of [costo, cobrado]) if (m !== '' && (!Number.isInteger(m) || m < 0)) return json({ error: 'monto_invalido' }, 400);

  const datos = await cargarDatosPedido(quoteId, version);
  if (!datos) return json({ error: 'upstream' }, 503);
  if (datos.filas.length === 0) return json({ error: 'pedido_no_encontrado' }, 404);
  if (datos.filas[0].estado_negocio !== 'pagado') return json({ error: 'pedido_no_pagado' }, 409);
  const resumen = resumirLineas(lineasDePedido(datos.filas), datos.recepciones, datos.despachos);
  const detalle = validarAsignacion(resumen, lineas);
  if (detalle) return json({ error: 'asignacion_invalida', detalle }, 409);

  const creado = await supabaseRpc('crear_despacho', {
    p_despacho: {
      quote_id: quoteId, quote_version: version, modalidad,
      courier: modalidad === 'courier' ? courier : '',
      direccion: texto(b?.direccion), comuna: texto(b?.comuna), ciudad: texto(b?.ciudad),
      contacto_nombre: texto(b?.contacto_nombre), contacto_telefono: texto(b?.contacto_telefono),
      fecha_programada: fecha, responsable: texto(b?.responsable),
      costo_clp: costo === '' ? '' : String(costo), cobrado_clp: cobrado === '' ? '' : String(cobrado),
      nota: texto(b?.nota),
    },
    p_lineas: lineas.map((l) => ({ po_id: l.po_id, mpn: l.mpn, cantidad: l.cantidad })),
  });
  if (creado === null) return json({ error: 'upstream' }, 503);
  return json({ ok: true, id: Number((creado as { id: number }).id) }, 201);
}
