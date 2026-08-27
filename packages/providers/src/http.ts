/**
 * Tope de espera por llamada a un proveedor, en milisegundos.
 *
 * Sin esto, un proveedor que **cuelga** —no que falla— deja la peticion
 * esperando para siempre: la comparacion de precios espera a los tres en
 * paralelo, asi que tarda lo que tarde el peor, y el agente que cotiza por
 * WhatsApp se queda sin respuesta. Un proveedor caido ya estaba cubierto; uno
 * colgado no.
 *
 * El valor sale de la latencia observada: la llamada mas lenta que hacemos es
 * el volcado de catalogo de Tecnoglobal (~3 s) y las cotizaciones por SKU
 * rondan 1,5-2 s. Veinte segundos deja margen de sobra para un dia malo del
 * proveedor y sigue muy por debajo de lo que alguien espera un mensaje.
 */
const TIMEOUT_MS_POR_DEFECTO = 20_000;

export function timeoutProveedor(): number {
  const crudo = Number(process.env.PROVEEDOR_TIMEOUT_MS);
  return Number.isFinite(crudo) && crudo > 0 ? crudo : TIMEOUT_MS_POR_DEFECTO;
}

/**
 * `fetch` con un tope de espera.
 *
 * Se arma la señal por llamada y no una compartida, para que el tope corra
 * desde que empieza *esta* peticion. Al vencer, `fetch` rechaza y cada
 * proveedor lo traduce a su propio error de transporte.
 */
export function fetchConTimeout(
  entrada: URL | string,
  init: RequestInit = {},
): Promise<Response> {
  return fetch(entrada, { ...init, signal: AbortSignal.timeout(timeoutProveedor()) });
}
