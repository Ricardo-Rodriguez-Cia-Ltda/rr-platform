import { supabaseGet } from './supabase.js';
import { OFICINA_BASE, RELAY_BASE } from './constantes.js';

export interface Salud {
  supabase: boolean; oficina: boolean; rele: boolean;
  cotizaciones24h: number | null; ocFallidas: number | null;
}

const TIMEOUT_MS = 4000;

// "Vivo" = responde SU contrato, no cualquier cosa: la oficina responde
// 404 {"error":"not_found"} en rutas desconocidas (y 401 si la auth corre
// antes); el rele responde 404 {"error":"cotizacion_no_encontrada"} para un
// UUID inexistente. Un 502/530 del tunel o un HTML de plataforma NO cuentan.
async function ping(url: string, esVivo: (status: number, body: string) => boolean): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
    return esVivo(r.status, await r.text());
  } catch {
    return false;
  }
}

export async function chequearSalud(ahoraMs: number): Promise<Salud> {
  const hace24h = new Date(ahoraMs - 24 * 3600_000).toISOString();
  const [cots, fallidas, oficina, rele] = await Promise.all([
    supabaseGet(`/cotizaciones?select=quote_id&created_at=gte.${encodeURIComponent(hace24h)}&limit=1000`),
    supabaseGet(`/pedidos?select=po_id&estado=eq.failed&limit=1000`),
    ping(`${OFICINA_BASE}/ping-salud-backoffice`, (status) => status === 404 || status === 401),
    ping(`${RELAY_BASE}/api/cotizacion/00000000-0000-4000-8000-000000000000`,
      (status, body) => status === 404 && body.includes('cotizacion_no_encontrada')),
  ]);
  return {
    supabase: cots !== null && fallidas !== null,
    oficina, rele,
    cotizaciones24h: cots === null ? null : cots.length,
    ocFallidas: fallidas === null ? null : fallidas.length,
  };
}
