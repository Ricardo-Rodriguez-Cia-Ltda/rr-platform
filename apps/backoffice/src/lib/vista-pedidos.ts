import { supabaseGet } from './supabase.js';
import { agruparPedidos, contadores, type FilaPedido, type GrupoPedido } from './pedidos.js';
import { formatCLP } from './formato.js';

export interface VistaPedidos {
  contadores: { porEntregar: number; nuevos: number; ocFallidas: number };
  pedidos: Array<GrupoPedido & { totalFmt: string; numeroCotizacion: number | null }>;
}

const LIMITE = 200; // los ~ultimos 200 pedidos; paginacion cuando haga falta de verdad

export async function cargarVistaPedidos(): Promise<VistaPedidos | null> {
  const filas = await supabaseGet(`/pedidos?select=*&order=created_at.desc&limit=${LIMITE}`);
  if (filas === null) return null;
  const grupos = agruparPedidos(filas as FilaPedido[]);

  // Total de venta y numero correlativo viven en la cotizacion de origen.
  const ids = [...new Set(grupos.map((g) => `"${g.quoteId}"`))];
  const cots = ids.length > 0
    ? await supabaseGet(`/cotizaciones?select=quote_id,version,numero,total_clp&quote_id=in.(${encodeURIComponent(ids.join(','))})`)
    : [];
  if (cots === null) return null;
  const porClave = new Map(
    (cots as Array<{ quote_id: string; version: string; numero: number | null; total_clp: number }>).map(
      (c) => [`${c.quote_id}:${c.version}`, c],
    ),
  );

  return {
    contadores: contadores(grupos),
    pedidos: grupos.map((g) => {
      const cot = porClave.get(`${g.quoteId}:${g.version}`);
      return {
        ...g,
        totalFmt: cot ? formatCLP(cot.total_clp) : '—',
        numeroCotizacion: cot?.numero ?? null,
      };
    }),
  };
}
