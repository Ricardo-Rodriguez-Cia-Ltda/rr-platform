// Carro client-side. Las funciones puras se testean; las dos de storage son
// envoltorios finos con try/catch (localStorage puede no existir o lanzar).
export interface ItemCarro {
  sku: string; mpn: string | null; marca: string | null; nombre: string;
  cantidad: number; precioTiendaClp: number;
}

export const MAX_LINEAS = 10;
export const MAX_UNIDADES = 20;
const CLAVE = 'drc-carro';

export function agregar(items: ItemCarro[], nuevo: ItemCarro): ItemCarro[] | { error: string } {
  const existente = items.find((i) => i.sku === nuevo.sku);
  if (existente) {
    if (existente.cantidad + nuevo.cantidad > MAX_UNIDADES) {
      return { error: `Máximo ${MAX_UNIDADES} unidades por producto.` };
    }
    return items.map((i) => (i.sku === nuevo.sku ? { ...i, cantidad: i.cantidad + nuevo.cantidad } : i));
  }
  if (items.length >= MAX_LINEAS) return { error: `Máximo ${MAX_LINEAS} productos distintos por pedido.` };
  return [...items, nuevo];
}

export function cambiarCantidad(items: ItemCarro[], sku: string, cantidad: number): ItemCarro[] {
  if (cantidad <= 0) return items.filter((i) => i.sku !== sku);
  const clamped = Math.min(Math.max(1, Math.round(cantidad)), MAX_UNIDADES);
  return items.map((i) => (i.sku === sku ? { ...i, cantidad: clamped } : i));
}

export function totalIndicativo(items: ItemCarro[]): number {
  return items.reduce((s, i) => s + i.cantidad * i.precioTiendaClp, 0);
}

export function contarUnidades(items: ItemCarro[]): number {
  return items.reduce((n, i) => n + i.cantidad, 0);
}

export function leerCarro(): ItemCarro[] {
  try {
    const crudo = localStorage.getItem(CLAVE);
    const parsed = crudo ? JSON.parse(crudo) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function guardarCarro(items: ItemCarro[]): void {
  try {
    localStorage.setItem(CLAVE, JSON.stringify(items));
    window.dispatchEvent(new Event('carro-cambio'));
  } catch {
    /* storage bloqueado: el carro vive solo en memoria de la pagina */
  }
}
