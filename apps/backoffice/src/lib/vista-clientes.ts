import { supabaseGet } from './supabase.js';
import { agruparPedidos, type FilaPedido } from './pedidos.js';
import { formatCLP } from './formato.js';

export interface FichaCliente {
  datos: { telefono: string; rut: string; razonSocial: string; giro: string; direccion: string; comuna: string; ciudad: string; email: string };
  cotizaciones: Array<{ numero: number | null; fecha: string; totalFmt: string }>;
  pedidos: Array<{ fecha: string; estadoNegocio: string }>;
}

export async function cargarClientes(): Promise<Array<{ telefono: string; razonSocial: string; rut: string }> | null> {
  const filas = await supabaseGet('/clientes?select=telefono,razon_social,rut&order=updated_at.desc&limit=500');
  if (filas === null) return null;
  return (filas as Array<{ telefono: string; razon_social: string; rut: string }>).map((c) => ({
    telefono: c.telefono, razonSocial: c.razon_social, rut: c.rut,
  }));
}

export async function cargarFichaCliente(telefono: string): Promise<FichaCliente | null | 'no_existe'> {
  const tel = encodeURIComponent(telefono);
  const clientes = await supabaseGet(`/clientes?telefono=eq.${tel}&limit=1`);
  if (clientes === null) return null;
  const c = clientes[0] as {
    telefono: string; rut: string; razon_social: string; giro: string;
    direccion: string; comuna: string; ciudad: string; email: string;
  } | undefined;
  if (!c) return 'no_existe';

  const [cots, pedidos] = await Promise.all([
    supabaseGet(`/cotizaciones?telefono=eq.${tel}&select=numero,created_at,total_clp&order=created_at.desc&limit=50`),
    supabaseGet(`/pedidos?telefono=eq.${tel}&select=*&order=created_at.desc&limit=100`),
  ]);
  if (cots === null || pedidos === null) return null;

  return {
    datos: {
      telefono: c.telefono, rut: c.rut, razonSocial: c.razon_social, giro: c.giro,
      direccion: c.direccion, comuna: c.comuna, ciudad: c.ciudad, email: c.email,
    },
    cotizaciones: (cots as Array<{ numero: number | null; created_at: string; total_clp: number }>).map((q) => ({
      numero: q.numero, fecha: q.created_at, totalFmt: formatCLP(q.total_clp),
    })),
    pedidos: agruparPedidos(pedidos as FilaPedido[]).map((g) => ({ fecha: g.fecha, estadoNegocio: g.estadoNegocio })),
  };
}
