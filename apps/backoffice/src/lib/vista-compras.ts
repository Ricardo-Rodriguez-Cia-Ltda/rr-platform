import { supabaseGet } from './supabase.js';
import type { FilaPedido } from './pedidos.js';
import { claveLinea } from './lineas.js';
import { compraAtrasada, hoySantiago } from './compras.js';

export interface CompraVista {
  fila: FilaPedido; cliente: string; numeroCotizacion: number | null; atrasada: boolean;
  lineas: Array<{ clave: string; nombre: string; cantidad: number; recibida: number }>;
}
export interface VistaCompras { porComprar: CompraVista[]; enCurso: CompraVista[]; recibidas: CompraVista[]; atrasadas: number }

const LIMITE = 200;
const enLista = (valores: string[]) => encodeURIComponent([...new Set(valores)].map((v) => `"${v}"`).join(','));

// Junta las lineas repetidas del mismo mpn dentro de una OC (sumando
// cantidad, con el nombre de la primera aparicion) antes de calcular lo
// recibido, para que no aparezcan dos filas reclamando el mismo recibido.
function lineasDeCompra(f: FilaPedido): Array<{ clave: string; nombre: string; cantidad: number }> {
  const porClave = new Map<string, { clave: string; nombre: string; cantidad: number }>();
  (f.lineas ?? []).forEach((l, i) => {
    const clave = claveLinea(l, i);
    const cantidad = Number(l.cantidad ?? 0);
    const existente = porClave.get(clave);
    if (existente) {
      existente.cantidad += cantidad;
    } else {
      porClave.set(clave, { clave, nombre: l.nombre ?? l.mpn ?? 'Producto', cantidad });
    }
  });
  return [...porClave.values()];
}

// Las compras de pedidos pagados: lo que falta comprar, lo que viene en
// camino y lo recibido que todavia no se despacha.
export async function cargarVistaCompras(hoy: string = hoySantiago()): Promise<VistaCompras | null> {
  const filas = await supabaseGet(`/pedidos?select=*&estado_negocio=eq.pagado&order=created_at.asc&limit=${LIMITE}`);
  if (filas === null) return null;
  const pedidos = filas as FilaPedido[];
  if (pedidos.length === 0) return { porComprar: [], enCurso: [], recibidas: [], atrasadas: 0 };

  const recepciones = await supabaseGet(`/recepciones?select=po_id,mpn,cantidad&po_id=in.(${enLista(pedidos.map((p) => p.po_id))})`);
  if (recepciones === null) return null;
  const cots = await supabaseGet(`/cotizaciones?select=quote_id,version,numero&quote_id=in.(${enLista(pedidos.map((p) => p.quote_id))})`);
  if (cots === null) return null;

  const recibido = new Map<string, number>();
  for (const r of recepciones as Array<{ po_id: string; mpn: string; cantidad: number }>) {
    recibido.set(`${r.po_id}|${r.mpn}`, (recibido.get(`${r.po_id}|${r.mpn}`) ?? 0) + Number(r.cantidad));
  }
  const numero = new Map((cots as Array<{ quote_id: string; version: string; numero: number | null }>).map((c) => [`${c.quote_id}:${c.version}`, c.numero]));

  const vistas: CompraVista[] = pedidos.map((f) => ({
    fila: f,
    cliente: f.razon_social ?? f.telefono ?? 'Sin cliente',
    numeroCotizacion: numero.get(`${f.quote_id}:${f.quote_version}`) ?? null,
    atrasada: compraAtrasada({ estado_compra: f.estado_compra ?? 'por_comprar', llegada_estimada: f.llegada_estimada ?? null }, hoy),
    lineas: lineasDeCompra(f).map((l) => ({
      ...l,
      recibida: recibido.get(`${f.po_id}|${l.clave}`) ?? 0,
    })),
  }));
  const estado = (c: CompraVista) => c.fila.estado_compra ?? 'por_comprar';
  return {
    porComprar: vistas.filter((c) => estado(c) === 'por_comprar'),
    enCurso: vistas.filter((c) => ['comprada', 'por_retirar', 'en_camino', 'directo_al_cliente', 'recibida_parcial'].includes(estado(c))),
    recibidas: vistas.filter((c) => estado(c) === 'recibida'),
    atrasadas: vistas.filter((c) => c.atrasada).length,
  };
}
