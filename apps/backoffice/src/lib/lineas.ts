import type { CourierId } from './couriers.js';
import type { EstadoDespacho, ModalidadDespacho } from './despachos.js';
import type { FilaPedido } from './pedidos.js';

// Cantidades por linea de un pedido del cliente, cruzando lo comprado, lo
// recibido y lo asignado a despachos. Una linea se identifica por po_id +
// clave (el mpn). Ver la spec, Parte 2 ("Cantidades por linea").

export interface LineaCompra {
  poId: string; clave: string; nombre: string; cantidad: number;
  /** La despacha el mayorista directo al cliente: no pasa por nuestros despachos. */
  directo: boolean;
  entregadaDirecto: boolean;
}
export interface Recepcion { po_id: string; mpn: string; cantidad: number }
export interface DespachoLinea { po_id: string; mpn: string; cantidad: number }
export interface Despacho {
  id: number; quote_id: string; quote_version: string;
  modalidad: ModalidadDespacho; courier: CourierId | null; estado: EstadoDespacho;
  direccion: string | null; comuna: string | null; ciudad: string | null;
  contacto_nombre: string | null; contacto_telefono: string | null;
  fecha_programada: string | null; responsable: string | null; numero_seguimiento: string | null;
  costo_clp: number | null; cobrado_clp: number | null; cobro_pagado: boolean; nota: string | null;
  created_at: string; entregado_at: string | null;
  lineas: DespachoLinea[];
}
export interface ResumenLinea extends LineaCompra {
  recibida: number; asignada: number; enMano: number; entregada: number; pendiente: number;
}

const EN_MANO: EstadoDespacho[] = ['listo', 'en_ruta', 'entregado'];

export function claveLinea(l: { mpn?: string | null }, indice: number): string {
  return l.mpn ? l.mpn : `linea-${indice}`;
}

const k = (poId: string, clave: string) => `${poId}|${clave}`;

export function lineasDePedido(filas: FilaPedido[]): LineaCompra[] {
  const out: LineaCompra[] = [];
  for (const f of filas) {
    // Una orden de compra anulada no tiene nada que entregar.
    if (f.estado_compra === 'anulada') continue;
    const directo = f.modalidad_compra === 'directo_cliente';
    // Si el mismo mpn aparece dos veces en la misma OC, se combinan en una
    // sola linea (sumando cantidad, con el nombre de la primera aparicion).
    const porClave = new Map<string, LineaCompra>();
    (f.lineas ?? []).forEach((l, i) => {
      const clave = claveLinea(l, i);
      const cantidad = Number(l.cantidad ?? 0);
      const existente = porClave.get(clave);
      if (existente) {
        existente.cantidad += cantidad;
      } else {
        porClave.set(clave, {
          poId: f.po_id,
          clave,
          nombre: l.nombre ?? l.mpn ?? 'Producto',
          cantidad,
          directo,
          entregadaDirecto: f.estado_compra === 'entregada_al_cliente',
        });
      }
    });
    out.push(...porClave.values());
  }
  return out;
}

export function resumirLineas(lineas: LineaCompra[], recepciones: Recepcion[], despachos: Despacho[]): ResumenLinea[] {
  const recibida = new Map<string, number>();
  for (const r of recepciones) recibida.set(k(r.po_id, r.mpn), (recibida.get(k(r.po_id, r.mpn)) ?? 0) + r.cantidad);
  const asignada = new Map<string, number>(), enMano = new Map<string, number>(), entregada = new Map<string, number>();
  const sumar = (m: Map<string, number>, clave: string, n: number) => m.set(clave, (m.get(clave) ?? 0) + n);
  for (const d of despachos) {
    if (d.estado === 'anulado') continue;
    for (const l of d.lineas) {
      const clave = k(l.po_id, l.mpn);
      sumar(asignada, clave, l.cantidad);
      if (EN_MANO.includes(d.estado)) sumar(enMano, clave, l.cantidad);
      if (d.estado === 'entregado') sumar(entregada, clave, l.cantidad);
    }
  }
  return lineas.map((l) => {
    const clave = k(l.poId, l.clave);
    const a = asignada.get(clave) ?? 0;
    return {
      ...l,
      recibida: recibida.get(clave) ?? 0,
      asignada: a,
      enMano: enMano.get(clave) ?? 0,
      entregada: entregada.get(clave) ?? 0,
      pendiente: l.directo ? 0 : Math.max(0, l.cantidad - a),
    };
  });
}

export function validarAsignacion(resumen: ResumenLinea[], pedidas: DespachoLinea[]): string | null {
  if (pedidas.length === 0) return 'El despacho no tiene productos';
  // Se valida cada cantidad antes de sumar, para no dejar pasar una negativa
  // compensada por otra positiva del mismo mpn.
  for (const p of pedidas) {
    if (!Number.isInteger(p.cantidad) || p.cantidad <= 0) return `Cantidad inválida para ${p.mpn}`;
  }
  const pedido = new Map<string, number>();
  for (const p of pedidas) pedido.set(k(p.po_id, p.mpn), (pedido.get(k(p.po_id, p.mpn)) ?? 0) + p.cantidad);
  for (const [clave, cantidad] of pedido) {
    const r = resumen.find((l) => k(l.poId, l.clave) === clave);
    if (!r) return `Producto ${clave.split('|')[1]} no está en el pedido`;
    if (r.directo) return `${r.nombre} lo despacha el mayorista directo al cliente`;
    if (cantidad > r.pendiente) return `${r.nombre}: quedan ${r.pendiente} por asignar`;
  }
  return null;
}

export function faltantesParaListo(despacho: Despacho, recepciones: Recepcion[], despachos: Despacho[]): string[] {
  const faltan: string[] = [];
  for (const l of despacho.lineas) {
    const clave = k(l.po_id, l.mpn);
    const recibida = recepciones.filter((r) => k(r.po_id, r.mpn) === clave).reduce((n, r) => n + r.cantidad, 0);
    const deOtros = despachos
      .filter((d) => d.id !== despacho.id && EN_MANO.includes(d.estado))
      .flatMap((d) => d.lineas)
      .filter((x) => k(x.po_id, x.mpn) === clave)
      .reduce((n, x) => n + x.cantidad, 0);
    const disponible = recibida - deOtros;
    if (disponible < l.cantidad) faltan.push(`${l.mpn}: faltan ${l.cantidad - disponible}`);
  }
  return faltan;
}

export function pedidoCompletamenteEntregado(resumen: ResumenLinea[]): boolean {
  if (resumen.length === 0) return false;
  return resumen.every((r) => (r.directo ? r.entregadaDirecto : r.entregada >= r.cantidad));
}
