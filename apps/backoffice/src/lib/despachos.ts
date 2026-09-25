// Estados de un despacho al cliente. Ver la spec, Parte 2.

export type EstadoDespacho = 'por_preparar' | 'listo' | 'en_ruta' | 'entregado' | 'fallido' | 'anulado';
export type ModalidadDespacho = 'retiro_oficina' | 'propio' | 'courier';

export const ESTADOS_DESPACHO: EstadoDespacho[] = ['por_preparar', 'listo', 'en_ruta', 'entregado', 'fallido', 'anulado'];
export const MODALIDADES_DESPACHO: ModalidadDespacho[] = ['retiro_oficina', 'propio', 'courier'];
export const ESTADOS_DESPACHO_ACTIVOS: EstadoDespacho[] = ['por_preparar', 'listo', 'en_ruta', 'fallido'];

const TRANSICIONES: Record<EstadoDespacho, EstadoDespacho[]> = {
  por_preparar: ['listo', 'anulado'],
  listo: ['en_ruta', 'entregado', 'anulado'],
  en_ruta: ['entregado', 'fallido'],
  fallido: ['listo', 'anulado'],
  entregado: [],
  anulado: [],
};

export function transicionDespachoValida(desde: EstadoDespacho, hacia: EstadoDespacho, modalidad: ModalidadDespacho): boolean {
  if (!(TRANSICIONES[desde]?.includes(hacia) ?? false)) return false;
  // El retiro en oficina no sale a ruta: de listo pasa a entregado cuando lo
  // retiran. Lo que sale a ruta no se da por entregado sin pasar por ella.
  if (modalidad === 'retiro_oficina' && hacia === 'en_ruta') return false;
  if (modalidad !== 'retiro_oficina' && desde === 'listo' && hacia === 'entregado') return false;
  return true;
}

export function requisitoTransicion(
  d: { modalidad: ModalidadDespacho; numero_seguimiento: string | null },
  hacia: EstadoDespacho,
): string | null {
  if (hacia === 'en_ruta' && d.modalidad === 'courier' && !d.numero_seguimiento?.trim()) {
    return 'Falta el número de seguimiento del courier';
  }
  return null;
}
