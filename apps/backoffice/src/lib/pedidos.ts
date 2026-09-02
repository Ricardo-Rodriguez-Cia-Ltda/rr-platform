export type EstadoNegocio = 'nuevo' | 'pagado' | 'entregado' | 'anulado';

// Maquina de estados del negocio. `anulado` solo desde estados no terminales;
// `entregado` es terminal. La idempotencia (misma->misma) la resuelve el
// route handler, no esta tabla.
const TRANSICIONES: Record<EstadoNegocio, EstadoNegocio[]> = {
  nuevo: ['pagado', 'anulado'],
  pagado: ['entregado', 'anulado'],
  entregado: [],
  anulado: [],
};
export function transicionValida(desde: EstadoNegocio, hacia: EstadoNegocio): boolean {
  return TRANSICIONES[desde]?.includes(hacia) ?? false;
}

export interface FilaPedido {
  po_id: string; quote_id: string; quote_version: string; proveedor: string;
  telefono: string | null; rut: string | null; razon_social: string | null;
  estado: string; estado_negocio?: EstadoNegocio;
  pagado_at?: string | null; entregado_at?: string | null;
  created_at: string; neto_grupo_clp: number | null;
  lineas: Array<{ nombre?: string | null; mpn?: string | null; cantidad?: number; precio_unitario_clp?: number; subtotal_neto_clp?: number }>;
}

export interface GrupoPedido {
  quoteId: string; version: string; telefono: string | null; razonSocial: string | null;
  fecha: string; estadoNegocio: EstadoNegocio;
  ocs: Array<{ poId: string; proveedor: string; correo: string }>;
  lineas: FilaPedido['lineas'];
}

// La unidad operativa: el pedido del cliente = todas las filas (una por
// mayorista) que comparten quote_id+version. Las transiciones escriben el
// grupo entero, asi que el estado_negocio de la primera fila representa al
// grupo; `?? 'nuevo'` cubre consultas sin la columna (pre-ALTER).
export function agruparPedidos(filas: FilaPedido[]): GrupoPedido[] {
  const grupos = new Map<string, GrupoPedido>();
  for (const f of filas) {
    const clave = `${f.quote_id}:${f.quote_version}`;
    const grupo = grupos.get(clave) ?? {
      quoteId: f.quote_id, version: f.quote_version, telefono: f.telefono,
      razonSocial: f.razon_social, fecha: f.created_at,
      estadoNegocio: f.estado_negocio ?? 'nuevo', ocs: [], lineas: [],
    };
    grupo.ocs.push({ poId: f.po_id, proveedor: f.proveedor, correo: f.estado });
    grupo.lineas = grupo.lineas.concat(f.lineas ?? []);
    if (f.created_at < grupo.fecha) grupo.fecha = f.created_at;
    grupos.set(clave, grupo);
  }
  return [...grupos.values()].sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
}

export function contadores(grupos: GrupoPedido[]): { porEntregar: number; nuevos: number; ocFallidas: number } {
  return {
    porEntregar: grupos.filter((g) => g.estadoNegocio === 'pagado').length,
    nuevos: grupos.filter((g) => g.estadoNegocio === 'nuevo').length,
    ocFallidas: grupos.reduce((n, g) => n + g.ocs.filter((o) => o.correo === 'failed').length, 0),
  };
}
