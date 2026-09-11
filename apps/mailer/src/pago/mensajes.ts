export function formatearClp(n: number): string {
  return `$${Math.round(n).toLocaleString('es-CL')}`;
}

/**
 * Los seis textos al cliente. Viven juntos y aparte de los handlers porque la
 * regla que los gobierna es una sola: ninguno afirma algo que el paso que lo
 * dispara no haya verificado. `aprobadoSinEmitir` en particular NO dice que el
 * pedido quedo cursado -- justamente no lo sabemos.
 */
export const MENSAJES = {
  linkCreado: (montoFmt: string) =>
    `Listo 🙌 El total es ${montoFmt}. Paga con el botón de acá abajo y apenas se acredite te confirmo el pedido.`,
  sinLink:
    'Tuvimos un problema generando el link de pago. No lo intentes de nuevo: te contactamos por acá para resolverlo.',
  sinVigencia:
    'Los precios de tu cotización hay que refrescarlos antes de cobrar. Dame un momento y te confirmo el total.',
  rechazado:
    'El pago fue rechazado 😕 Puedes reintentar con el mismo link, o escribirme si prefieres otra forma de pago.',
  emitido:
    'Pago recibido ✅ Tu pedido quedó cursado. Te avisamos por acá cuando esté listo para entrega.',
  aprobadoSinEmitir:
    'Recibimos tu pago ✅ Estamos terminando de confirmar el pedido y te escribimos por acá en un rato.',
};
