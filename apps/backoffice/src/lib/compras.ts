// Estado de abastecimiento de una orden de compra (fila de pedidos). Ver
// docs/superpowers/specs/2026-09-25-despachos-design.md, Parte 1.

export type EstadoCompra = 'por_comprar' | 'comprada' | 'por_retirar' | 'en_camino' | 'directo_al_cliente'
  | 'recibida_parcial' | 'recibida' | 'entregada_al_cliente' | 'anulada';
export type ModalidadCompra = 'retiro' | 'despacho_mayorista' | 'directo_cliente';

export const ESTADOS_COMPRA: EstadoCompra[] = [
  'por_comprar', 'comprada', 'por_retirar', 'en_camino', 'directo_al_cliente',
  'recibida_parcial', 'recibida', 'entregada_al_cliente', 'anulada',
];
export const MODALIDADES_COMPRA: ModalidadCompra[] = ['retiro', 'despacho_mayorista', 'directo_cliente'];
// Estados donde todavia se pueden corregir los datos de la compra.
export const ESTADOS_COMPRA_EDITABLES: EstadoCompra[] = ['comprada', 'por_retirar', 'en_camino', 'directo_al_cliente', 'recibida_parcial'];

// recibida_parcial y recibida no se eligen a mano: las calcula la recepcion.
const TRANSICIONES: Record<EstadoCompra, EstadoCompra[]> = {
  por_comprar: ['comprada', 'anulada'],
  comprada: ['por_retirar', 'en_camino', 'directo_al_cliente', 'anulada'],
  por_retirar: ['anulada'],
  en_camino: ['anulada'],
  directo_al_cliente: ['entregada_al_cliente', 'anulada'],
  recibida_parcial: [],
  recibida: [],
  entregada_al_cliente: [],
  anulada: [],
};
// El paso siguiente a `comprada` lo decide como se compro.
const MODALIDAD_EXIGIDA: Partial<Record<EstadoCompra, ModalidadCompra>> = {
  por_retirar: 'retiro',
  en_camino: 'despacho_mayorista',
  directo_al_cliente: 'directo_cliente',
};

export function transicionCompraValida(desde: EstadoCompra, hacia: EstadoCompra, modalidad: ModalidadCompra | null): boolean {
  if (!(TRANSICIONES[desde]?.includes(hacia) ?? false)) return false;
  const exigida = MODALIDAD_EXIGIDA[hacia];
  return !exigida || exigida === modalidad;
}

export function admiteRecepcion(estado: EstadoCompra, modalidad: ModalidadCompra | null): boolean {
  if (modalidad === 'directo_cliente') return false;
  return ['comprada', 'por_retirar', 'en_camino', 'recibida_parcial'].includes(estado);
}

export function estadoTrasRecepcion(comprado: Map<string, number>, recibido: Map<string, number>): 'recibida' | 'recibida_parcial' {
  for (const [clave, cantidad] of comprado) {
    if ((recibido.get(clave) ?? 0) < cantidad) return 'recibida_parcial';
  }
  return 'recibida';
}

export function compraAtrasada(c: { estado_compra: EstadoCompra; llegada_estimada: string | null }, hoy: string): boolean {
  if (!c.llegada_estimada) return false;
  if (['recibida', 'entregada_al_cliente', 'anulada'].includes(c.estado_compra)) return false;
  return c.llegada_estimada < hoy;
}

export function hoySantiago(ahora: Date = new Date()): string {
  // en-CA formatea como YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(ahora);
}
