import type { CotizacionRow } from './datos.js';
import { MARGEN_VIGENCIA_MS } from './mercadopago.js';

/**
 * emitir-ordenes-compra lee exactamente cinco campos de la cotizacion:
 * quote_id, version, lineas, valid_until y proveedores_incompletos. Esta
 * funcion los reconstruye desde la fila guardada. Si alguna vez la function
 * empieza a leer un sexto campo, este es el lugar que hay que acompañar.
 */
export function reconstruirQuote(row: CotizacionRow): Record<string, unknown> {
  return {
    quote_id: row.quote_id,
    version: String(row.version ?? '1'),
    lineas: Array.isArray(row.lineas) ? row.lineas : [],
    valid_until: row.valida_hasta,
    // Las filas anteriores a la columna nueva traen null: lista vacia, que es
    // como la function ya se defiende (`Array.isArray(...) ? ... : []`).
    proveedores_incompletos: Array.isArray(row.proveedores_incompletos) ? row.proveedores_incompletos : [],
  };
}

/**
 * El mismo execution_context sintetico que arma apps/tienda/src/lib/pedido.ts.
 * `datos` viene de la fila `pagos`: quote_customer_name y los billing_*.
 *
 * El orden de las claves importa: quote_result y quote_confirmed van después de
 * ...datos para que sean autoritativas. Si datos incluyera esas claves, no debe
 * poder pisarlas, porque estos campos alimentan emitir-ordenes-compra que hace
 * órdenes de compra reales a mayoristas.
 */
export function armarPayloadEmision(
  quote: Record<string, unknown>,
  datos: Record<string, unknown>,
  telefono: string | null,
): unknown {
  return {
    execution_context: {
      vars: { ...datos, quote_result: quote, quote_confirmed: true },
      context: { phone_number: telefono ?? '' },
    },
  };
}

/**
 * ¿Le queda a la cotizacion ventana suficiente para pagar dentro de su
 * vigencia? Por debajo del margen, un link nace condenado: se aprobaria el
 * pago y emitir-ordenes-compra lo rechazaria con 409.
 */
export function vigenciaUtil(validaHasta: string, ahoraMs: number): boolean {
  const vence = Date.parse(String(validaHasta));
  if (!Number.isFinite(vence)) return false;
  return vence - ahoraMs > MARGEN_VIGENCIA_MS;
}
