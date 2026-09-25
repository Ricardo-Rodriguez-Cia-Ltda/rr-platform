import type { Despacho } from './lineas.js';

// Registro de couriers. Vive en el backoffice (unico consumidor hoy); se
// mueve a un paquete compartido cuando haya integracion (etapa 3 de la spec).
export type CourierId = 'bluexpress' | 'starken' | 'chilexpress' | 'otro';

export interface Courier {
  id: CourierId;
  nombre: string;
  /** Pagina publica de seguimiento; `conNumero` dice si ya lleva el numero. */
  urlSeguimiento(numero: string): { url: string; conNumero: boolean } | null;
}

// Verificado el 2026-09-25: solo Starken acepta el numero en la URL.
function pagina(url: string) {
  return (numero: string) => (numero.trim() ? { url, conNumero: false } : null);
}

export const COURIERS: Record<CourierId, Courier> = {
  bluexpress: { id: 'bluexpress', nombre: 'Blue Express', urlSeguimiento: pagina('https://www.blue.cl/seguimiento/') },
  starken: {
    id: 'starken', nombre: 'Starken',
    urlSeguimiento: (numero) => {
      const n = numero.trim();
      return n ? { url: `https://www.starken.cl/seguimiento?codigo=${encodeURIComponent(n)}`, conNumero: true } : null;
    },
  },
  chilexpress: { id: 'chilexpress', nombre: 'Chilexpress', urlSeguimiento: pagina('https://www.chilexpress.cl/estado-envio-paquete-courier') },
  otro: { id: 'otro', nombre: 'Otro courier', urlSeguimiento: () => null },
};

export const DIRECCION_RETIRO = 'José M. Infante 2629, Ñuñoa, Santiago';

function fechaDMY(iso: string): string {
  const [a, m, d] = iso.split('-');
  return `${d}-${m}-${a}`;
}

/** Texto para pegar en WhatsApp segun el estado del despacho, o null si no hay nada que avisar. */
export function mensajeCliente(
  d: Pick<Despacho, 'estado' | 'modalidad' | 'courier' | 'numero_seguimiento' | 'fecha_programada'>,
  p: { numeroCotizacion: number | null; contacto: string | null },
): string | null {
  const nombre = p.contacto?.trim().split(/\s+/)[0];
  const hola = nombre ? `Hola ${nombre}, ` : 'Hola, ';
  const pedido = p.numeroCotizacion !== null ? `tu pedido N° ${p.numeroCotizacion}` : 'tu pedido';

  if (d.estado === 'listo' && d.modalidad === 'retiro_oficina') {
    return `${hola}${pedido} está listo para retiro en ${DIRECCION_RETIRO}.`;
  }
  if (d.estado === 'en_ruta' && d.modalidad === 'courier') {
    const courier = COURIERS[d.courier ?? 'otro'];
    const numero = d.numero_seguimiento?.trim() ?? '';
    const base = `${hola}${pedido} va en camino por ${courier.nombre}. N° de seguimiento: ${numero}.`;
    const seg = courier.urlSeguimiento(numero);
    if (seg?.conNumero) return `${base} Síguelo aquí: ${seg.url}`;
    if (seg) return `${base} Puedes seguirlo ingresando ese número en ${seg.url}`;
    return base;
  }
  if (d.estado === 'en_ruta') {
    return `${hola}${pedido} va en camino${d.fecha_programada ? `; te lo entregamos el ${fechaDMY(d.fecha_programada)}` : ''}.`;
  }
  if (d.estado === 'entregado') {
    return `${hola}${pedido} quedó entregado. ¡Gracias por tu compra!`;
  }
  return null;
}
