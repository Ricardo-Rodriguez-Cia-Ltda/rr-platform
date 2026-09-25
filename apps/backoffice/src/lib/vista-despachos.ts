import { supabaseGet } from './supabase.js';
import { agruparPedidos, type FilaPedido } from './pedidos.js';
import { normalizarDespacho } from './datos-pedido.js';
import { lineasDePedido, resumirLineas, type Despacho, type Recepcion, type ResumenLinea } from './lineas.js';
import { ESTADOS_DESPACHO_ACTIVOS } from './despachos.js';

export interface PedidoLogistica {
  quoteId: string; version: string; cliente: string; telefono: string | null; numeroCotizacion: number | null;
  estadoNegocio: string; resumen: ResumenLinea[]; despachos: Despacho[];
  facturacion: { direccion: string | null; comuna: string | null; ciudad: string | null };
}
type ConPedido = { despacho: Despacho; pedido: PedidoLogistica };
export interface VistaDespachos {
  porAsignar: PedidoLogistica[]; activos: ConPedido[]; cobrosPendientes: ConPedido[]; entregadosRecientes: ConPedido[];
}

const LIMITE = 200;
const RECIENTES = 20;
const enLista = (valores: string[]) => encodeURIComponent([...new Set(valores)].map((v) => `"${v}"`).join(','));

export async function cargarVistaDespachos(): Promise<VistaDespachos | null> {
  const filas = await supabaseGet(`/pedidos?select=*&estado_negocio=in.(pagado,entregado)&order=created_at.desc&limit=${LIMITE}`);
  if (filas === null) return null;
  const todas = filas as FilaPedido[];
  if (todas.length === 0) return { porAsignar: [], activos: [], cobrosPendientes: [], entregadosRecientes: [] };

  const quotes = todas.map((f) => f.quote_id);
  const telefonos = todas.map((f) => f.telefono ?? '').filter(Boolean);
  const [despachos, recepciones, cots, clientes] = await Promise.all([
    supabaseGet(`/despachos?select=*,despacho_lineas(po_id,mpn,cantidad)&quote_id=in.(${enLista(quotes)})&order=id.desc`),
    supabaseGet(`/recepciones?select=po_id,mpn,cantidad&po_id=in.(${enLista(todas.map((f) => f.po_id))})`),
    supabaseGet(`/cotizaciones?select=quote_id,version,numero&quote_id=in.(${enLista(quotes)})`),
    // PostgREST rechaza `in.()` vacio: sin telefonos no se consulta.
    telefonos.length > 0
      ? supabaseGet(`/clientes?select=telefono,direccion,comuna,ciudad&telefono=in.(${enLista(telefonos)})`)
      : Promise.resolve([] as unknown[]),
  ]);
  if (despachos === null || recepciones === null || cots === null || clientes === null) return null;

  const listaDespachos = (despachos as Record<string, unknown>[]).map(normalizarDespacho);
  const listaRecepciones = recepciones as Recepcion[];
  const numero = new Map((cots as Array<{ quote_id: string; version: string; numero: number | null }>).map((c) => [`${c.quote_id}:${c.version}`, c.numero]));
  const cliente = new Map((clientes as Array<{ telefono: string; direccion: string | null; comuna: string | null; ciudad: string | null }>).map((c) => [c.telefono, c]));

  const pedidos: PedidoLogistica[] = agruparPedidos(todas).map((g) => {
    const filasGrupo = todas.filter((f) => f.quote_id === g.quoteId && f.quote_version === g.version);
    const deEste = listaDespachos.filter((d) => d.quote_id === g.quoteId && d.quote_version === g.version);
    const c = g.telefono ? cliente.get(g.telefono) : undefined;
    return {
      quoteId: g.quoteId, version: g.version, cliente: g.razonSocial ?? g.telefono ?? 'Sin cliente',
      telefono: g.telefono, numeroCotizacion: numero.get(`${g.quoteId}:${g.version}`) ?? null,
      estadoNegocio: g.estadoNegocio,
      resumen: resumirLineas(lineasDePedido(filasGrupo), listaRecepciones, deEste),
      despachos: deEste,
      facturacion: { direccion: c?.direccion ?? null, comuna: c?.comuna ?? null, ciudad: c?.ciudad ?? null },
    };
  });
  const conPedido = (d: Despacho): ConPedido => ({
    despacho: d,
    pedido: pedidos.find((p) => p.quoteId === d.quote_id && p.version === d.quote_version)!,
  });
  const visibles = listaDespachos.filter((d) => pedidos.some((p) => p.quoteId === d.quote_id && p.version === d.quote_version));

  return {
    porAsignar: pedidos.filter((p) => p.estadoNegocio === 'pagado' && p.resumen.some((r) => r.pendiente > 0)),
    activos: visibles.filter((d) => ESTADOS_DESPACHO_ACTIVOS.includes(d.estado)).map(conPedido),
    cobrosPendientes: visibles.filter((d) => (d.cobrado_clp ?? 0) > 0 && !d.cobro_pagado && d.estado !== 'anulado').map(conPedido),
    entregadosRecientes: visibles.filter((d) => d.estado === 'entregado').slice(0, RECIENTES).map(conPedido),
  };
}
