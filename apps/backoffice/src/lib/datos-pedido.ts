import { supabaseGet, supabasePost } from './supabase.js';
import type { FilaPedido } from './pedidos.js';
import type { Despacho, DespachoLinea, Recepcion } from './lineas.js';

export interface DatosPedido { filas: FilaPedido[]; recepciones: Recepcion[]; despachos: Despacho[] }

const txt = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

export function normalizarDespacho(raw: Record<string, unknown>): Despacho {
  return {
    id: Number(raw.id),
    quote_id: String(raw.quote_id ?? ''),
    quote_version: String(raw.quote_version ?? ''),
    modalidad: raw.modalidad as Despacho['modalidad'],
    courier: (txt(raw.courier) as Despacho['courier']) ?? null,
    estado: raw.estado as Despacho['estado'],
    direccion: txt(raw.direccion), comuna: txt(raw.comuna), ciudad: txt(raw.ciudad),
    contacto_nombre: txt(raw.contacto_nombre), contacto_telefono: txt(raw.contacto_telefono),
    fecha_programada: txt(raw.fecha_programada), responsable: txt(raw.responsable),
    numero_seguimiento: txt(raw.numero_seguimiento),
    costo_clp: num(raw.costo_clp), cobrado_clp: num(raw.cobrado_clp),
    cobro_pagado: raw.cobro_pagado === true,
    nota: txt(raw.nota),
    created_at: String(raw.created_at ?? ''),
    entregado_at: txt(raw.entregado_at),
    lineas: ((raw.despacho_lineas ?? raw.lineas ?? []) as DespachoLinea[]).map((l) => ({
      po_id: String(l.po_id), mpn: String(l.mpn), cantidad: Number(l.cantidad),
    })),
  };
}

const enLista = (valores: string[]) => encodeURIComponent(valores.map((v) => `"${v}"`).join(','));

export async function cargarDatosPedido(quoteId: string, version: string): Promise<DatosPedido | null> {
  const filtro = `quote_id=eq.${encodeURIComponent(quoteId)}&quote_version=eq.${encodeURIComponent(version)}`;
  const filas = await supabaseGet(`/pedidos?select=*&${filtro}`);
  if (filas === null) return null;
  const poIds = (filas as FilaPedido[]).map((f) => f.po_id);
  const recepciones = poIds.length > 0
    ? await supabaseGet(`/recepciones?select=po_id,mpn,cantidad&po_id=in.(${enLista(poIds)})`)
    : [];
  if (recepciones === null) return null;
  const despachos = await supabaseGet(`/despachos?select=*,despacho_lineas(po_id,mpn,cantidad)&${filtro}&order=id.asc`);
  if (despachos === null) return null;
  return {
    filas: filas as FilaPedido[],
    recepciones: (recepciones as Recepcion[]).map((r) => ({ po_id: r.po_id, mpn: r.mpn, cantidad: Number(r.cantidad) })),
    despachos: (despachos as Record<string, unknown>[]).map(normalizarDespacho),
  };
}

export async function cargarDespacho(id: number): Promise<Despacho | null | undefined> {
  const filas = await supabaseGet(`/despachos?select=*,despacho_lineas(po_id,mpn,cantidad)&id=eq.${id}&limit=1`);
  if (filas === null) return null;
  if (filas.length === 0) return undefined;
  return normalizarDespacho(filas[0] as Record<string, unknown>);
}

// El historial es de mejor esfuerzo: si no se pudo escribir, el cambio de
// estado ya ocurrio y no se deshace; queda en el log.
export async function registrarEvento(despachoId: number, desde: string | null, hacia: string, nota: string | null): Promise<void> {
  const ok = await supabasePost('/despacho_eventos', { despacho_id: despachoId, desde, hacia, nota });
  if (ok === null) console.error('[despachos] no se pudo registrar el evento', { despachoId, desde, hacia });
}
