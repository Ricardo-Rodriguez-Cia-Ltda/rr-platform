export function formatearClp(n: number): string {
  return `$${Math.round(n).toLocaleString('es-CL')}`;
}

/**
 * Los textos al cliente. Viven juntos y aparte de los handlers porque la
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
  emitido:
    'Pago recibido ✅ Tu pedido quedó cursado. Te avisamos por acá cuando esté listo para entrega.',
  aprobadoSinEmitir:
    'Recibimos tu pago ✅ Estamos terminando de confirmar el pedido y te escribimos por acá en un rato.',
};

/**
 * Lo que el cliente puede hacer tras un rechazo depende del motivo que da
 * Mercado Pago (`status_detail`): un dato mal ingresado se corrige, un banco
 * que pide autorizacion se destraba con el banco, la falta de cupo pide otra
 * tarjeta. Lo que no se reconoce (riesgo, "otro motivo", codigos nuevos) cae
 * al consejo generico en vez de inventar una causa.
 */
export type MotivoRechazo = 'datos' | 'banco' | 'fondos' | 'otro';

export function motivoRechazo(statusDetail: string | undefined): MotivoRechazo {
  const d = String(statusDetail ?? '');
  if (d.startsWith('cc_rejected_bad_filled_')) return 'datos';
  if (d === 'cc_rejected_call_for_authorize' || d === 'cc_rejected_card_disabled') return 'banco';
  if (d === 'cc_rejected_insufficient_amount') return 'fondos';
  return 'otro';
}

const QUE_HACER: Record<MotivoRechazo, string> = {
  datos: 'Parece que algún dato de la tarjeta quedó mal ingresado; revísalo bien.',
  banco: 'Tu banco pidió autorizar el pago: autorízalo con ellos (app o teléfono).',
  fondos: 'La tarjeta no tiene cupo suficiente. Prueba con otra tarjeta o con tu cuenta de Mercado Pago.',
  otro: 'Prueba con otra tarjeta o con tu cuenta de Mercado Pago.',
};

/**
 * El aviso de rechazo. No ofrece "otra forma de pago": la unica es la
 * tarjeta por Mercado Pago. Con el link vencido o por vencer no invita a
 * reintentar con el -- el cliente se encontraria un link muerto -- y pide
 * escribir: tras el link la conversacion ya esta en manos de una persona.
 */
export function mensajeRechazo(statusDetail: string | undefined, linkVigente: boolean): string {
  const cierre = linkVigente
    ? 'Puedes reintentar con el mismo link.'
    : 'El link de pago ya venció: escríbenos por acá y te enviamos uno con precios vigentes.';
  return `El pago fue rechazado 😕 ${QUE_HACER[motivoRechazo(statusDetail)]} ${cierre}`;
}
