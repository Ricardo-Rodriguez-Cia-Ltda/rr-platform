import { cargarDatosPedido } from './datos-pedido.js';
import { lineasDePedido, pedidoCompletamenteEntregado, resumirLineas } from './lineas.js';
import { supabasePatch } from './supabase.js';

/**
 * Pasa el pedido a `entregado` cuando todo lo que compro el cliente ya le
 * llego, por nuestros despachos o directo del mayorista. De mejor esfuerzo:
 * si falla, el boton manual sigue disponible.
 */
export async function evaluarPedidoEntregado(quoteId: string, version: string): Promise<boolean> {
  const datos = await cargarDatosPedido(quoteId, version);
  if (!datos) {
    console.error('[entrega] no se pudo leer el pedido para evaluarlo', { quoteId, version });
    return false;
  }
  if (datos.filas[0]?.estado_negocio !== 'pagado') return false;
  const resumen = resumirLineas(lineasDePedido(datos.filas), datos.recepciones, datos.despachos);
  if (!pedidoCompletamenteEntregado(resumen)) return false;
  const filtro = `quote_id=eq.${encodeURIComponent(quoteId)}&quote_version=eq.${encodeURIComponent(version)}&estado_negocio=eq.pagado`;
  const filas = await supabasePatch(`/pedidos?${filtro}`, { estado_negocio: 'entregado', entregado_at: new Date().toISOString() });
  if (filas === null) console.error('[entrega] no se pudo pasar el pedido a entregado', { quoteId, version });
  return filas !== null && filas.length > 0;
}
