import { supabaseGet } from './supabase.js';
import { formatCLP } from './formato.js';
import { RELAY_BASE } from './constantes.js';

export interface FilaCotizacion {
  numero: number | null; quoteId: string; fecha: string; clienteLabel: string;
  totalFmt: string; vigente: boolean; tienePedido: boolean; pdfUrl: string;
}
export interface VistaCotizaciones { filas: FilaCotizacion[] }

const LIMITE = 200;

export async function cargarVistaCotizaciones(ahoraMs: number): Promise<VistaCotizaciones | null> {
  const cots = await supabaseGet(
    `/cotizaciones?select=quote_id,version,numero,telefono,total_clp,valida_hasta,created_at&order=created_at.desc&limit=${LIMITE}`,
  );
  if (cots === null) return null;
  const tipadas = cots as Array<{
    quote_id: string; version: string; numero: number | null; telefono: string | null;
    total_clp: number; valida_hasta: string | null; created_at: string;
  }>;

  const [pedidos, clientes] = await Promise.all([
    supabaseGet(`/pedidos?select=quote_id,quote_version&limit=1000`),
    supabaseGet(`/clientes?select=telefono,razon_social&limit=1000`),
  ]);
  if (pedidos === null || clientes === null) return null;
  const conPedido = new Set(
    (pedidos as Array<{ quote_id: string; quote_version: string }>).map((p) => `${p.quote_id}:${p.quote_version}`),
  );
  const razonPorTelefono = new Map(
    (clientes as Array<{ telefono: string; razon_social: string }>).map((c) => [c.telefono, c.razon_social]),
  );

  return {
    filas: tipadas.map((c) => ({
      numero: c.numero,
      quoteId: c.quote_id,
      fecha: c.created_at,
      clienteLabel: (c.telefono ? razonPorTelefono.get(c.telefono) : null) ?? c.telefono ?? 'Sin teléfono',
      totalFmt: formatCLP(c.total_clp),
      vigente: c.valida_hasta !== null && Date.parse(c.valida_hasta) > ahoraMs,
      tienePedido: conPedido.has(`${c.quote_id}:${c.version}`),
      pdfUrl: `${RELAY_BASE}/api/cotizacion/${c.quote_id}`,
    })),
  };
}
