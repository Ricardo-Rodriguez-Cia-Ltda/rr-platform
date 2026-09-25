// Traduce las respuestas de error de las rutas /api/compras/* y
// /api/despachos/* a un mensaje en espanol para mostrar en el backoffice.
// Se usa como respaldo cuando la respuesta no trae `detalle` ni `faltan`
// (esos dos, cuando vienen, ya son mas especificos que el codigo).

export interface RespuestaApi {
  error?: unknown;
  detalle?: unknown;
  faltan?: unknown;
  pendiente?: unknown;
}

const MENSAJES: Record<string, string> = {
  courier_sin_modalidad: 'Este despacho no es por courier: no lleva courier.',
  despacho_cerrado: 'El despacho ya está cerrado; solo se pueden cambiar costo, cobro y nota.',
  transicion_invalida: 'Otro usuario ya cambió este estado. Se recargó la vista.',
  pedido_no_pagado: 'El pedido todavía no está pagado.',
  excede_comprado: 'No se puede recibir más de lo comprado.',
  no_admite_recepcion: 'Esta compra no admite recepciones en su estado actual.',
  faltan_datos: 'Faltan la modalidad y el número de pedido del mayorista.',
  upstream: 'No se pudo conectar con la base. Intenta de nuevo.',
};

export const MENSAJE_GENERICO = 'No se pudo guardar. Intenta de nuevo.';

export function mensajeError(data: RespuestaApi): string {
  if (Array.isArray(data.faltan) && data.faltan.length > 0) {
    return `Falta recibir: ${data.faltan.join(', ')}`;
  }
  if (typeof data.detalle === 'string' && data.detalle.trim()) return data.detalle;
  const codigo = typeof data.error === 'string' ? data.error : '';
  if (codigo === 'excede_comprado' && typeof data.pendiente === 'number') {
    return `${MENSAJES.excede_comprado} Quedan ${data.pendiente} por recibir.`;
  }
  return MENSAJES[codigo] ?? MENSAJE_GENERICO;
}
