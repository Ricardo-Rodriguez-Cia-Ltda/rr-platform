// Lo que devuelve GET <rele>/api/pago/estado/{quote_id}. El rele es la
// autoridad sobre la vigencia: si la fila esta pendiente y el link sigue
// vivo, manda `init_point`; si no, no. La pagina no calcula fechas.
export interface EstadoPago {
  estado: 'pendiente' | 'aprobado' | 'emitido' | 'aprobado_sin_emitir';
  monto_clp: number;
  intentos_rechazados: number;
  expira_at: string;
  init_point?: string;
}

export interface Descripcion {
  sello: string;
  titulo: string;
  texto: string;
  accion: 'pagar' | 'volver' | 'ninguna';
  // Mientras el desenlace puede cambiar solo (esperando el pago o el
  // webhook), la pagina vuelve a preguntar.
  seguirConsultando: boolean;
  // "Guarda el PDF: es el comprobante de tu pedido" solo cuando hay pedido.
  comprobante: boolean;
}

/**
 * La misma regla que gobierna los mensajes del bot: ninguno afirma algo que
 * el estado no haya verificado. `aprobado_sin_emitir` en particular NO dice
 * que el pedido quedo cursado, porque justamente no lo sabemos.
 */
export function describirPago(r: EstadoPago | null): Descripcion {
  if (r === null) {
    return {
      sello: 'Sin pedido', titulo: 'No encontramos ese pedido.',
      texto: 'Puede que el link esté incompleto. Vuelve a la tienda y arma tu pedido de nuevo.',
      accion: 'volver', seguirConsultando: false, comprobante: false,
    };
  }
  switch (r.estado) {
    case 'pendiente':
      if (!r.init_point) {
        return {
          sello: 'Link vencido', titulo: 'El link de pago venció.',
          texto: 'Los precios se actualizan a diario. Vuelve a armar el pedido para pagarlo con los valores vigentes.',
          accion: 'volver', seguirConsultando: false, comprobante: false,
        };
      }
      if (r.intentos_rechazados > 0) {
        return {
          sello: 'Pago rechazado', titulo: 'El pago fue rechazado.',
          texto: 'Puedes reintentar con el mismo link, con otra tarjeta si prefieres. Las órdenes se cursan solo cuando el pago se acredita.',
          accion: 'pagar', seguirConsultando: true, comprobante: false,
        };
      }
      return {
        sello: 'Falta pagar', titulo: 'Tu pedido está listo para pagar.',
        texto: 'Paga con Mercado Pago y apenas se acredite cursamos las órdenes. Esta página se actualiza sola.',
        accion: 'pagar', seguirConsultando: true, comprobante: false,
      };
    case 'aprobado':
      return {
        sello: 'Pago recibido', titulo: 'Recibimos tu pago.',
        texto: 'Estamos cursando el pedido con los proveedores. Esta página se actualiza sola en unos segundos.',
        accion: 'ninguna', seguirConsultando: true, comprobante: false,
      };
    case 'emitido':
      return {
        sello: 'Pedido cursado', titulo: 'Pago recibido ✅ Tu pedido quedó cursado.',
        texto: 'Te escribimos por WhatsApp para coordinar la entrega. Tu cotización formal queda a tu nombre.',
        accion: 'ninguna', seguirConsultando: false, comprobante: true,
      };
    case 'aprobado_sin_emitir':
      return {
        sello: 'Pago recibido', titulo: 'Recibimos tu pago.',
        texto: 'Estamos terminando de confirmar el pedido y te contactamos por WhatsApp en un rato.',
        accion: 'ninguna', seguirConsultando: false, comprobante: true,
      };
  }
}
