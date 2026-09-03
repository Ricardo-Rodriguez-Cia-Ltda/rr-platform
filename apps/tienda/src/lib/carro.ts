// Carro client-side. Las funciones puras se testean; las dos de storage son
// envoltorios finos con try/catch (localStorage puede no existir o lanzar).
export interface ItemCarro {
  sku: string; mpn: string | null; marca: string | null; nombre: string;
  cantidad: number;
  /** Neto unitario en CLP: es la unidad con la que el bot arma el total. */
  precioNetoClp: number;
  /** Neto unitario + IVA, solo para MOSTRAR el precio de una unidad. */
  precioTiendaClp: number;
}

export const MAX_LINEAS = 10;
export const MAX_UNIDADES = 20;
const CLAVE = 'drc-carro';

export function agregar(items: ItemCarro[], nuevo: ItemCarro): ItemCarro[] | { error: string } {
  // Validar cantidad ANTES de las dos ramas
  const cantidad = nuevo.cantidad;
  if (!Number.isFinite(cantidad) || !Number.isInteger(cantidad) || cantidad < 1) {
    return { error: 'Cantidad inválida.' };
  }
  if (cantidad > MAX_UNIDADES) {
    return { error: `Máximo ${MAX_UNIDADES} unidades por producto.` };
  }

  const existente = items.find((i) => i.sku === nuevo.sku);
  if (existente) {
    if (existente.cantidad + cantidad > MAX_UNIDADES) {
      return { error: `Máximo ${MAX_UNIDADES} unidades por producto.` };
    }
    return items.map((i) => (i.sku === nuevo.sku ? { ...i, cantidad: i.cantidad + cantidad } : i));
  }
  if (items.length >= MAX_LINEAS) return { error: `Máximo ${MAX_LINEAS} productos distintos por pedido.` };
  return [...items, nuevo];
}

export function cambiarCantidad(items: ItemCarro[], sku: string, cantidad: number): ItemCarro[] {
  // Si no es finito, devolver items sin cambios
  if (!Number.isFinite(cantidad)) return items;
  if (cantidad <= 0) return items.filter((i) => i.sku !== sku);
  const clamped = Math.min(Math.max(1, Math.round(cantidad)), MAX_UNIDADES);
  return items.map((i) => (i.sku === sku ? { ...i, cantidad: clamped } : i));
}

/**
 * Total CON IVA armado EXACTAMENTE como generar-cotizacion-v2.js:
 * cada linea aporta su neto (neto unitario x cantidad), se suman todos, y el
 * IVA se aplica UNA sola vez sobre ese neto total. Sumar precios unitarios ya
 * con IVA da un numero distinto por unos pesos, y esa diferencia es lo que
 * hace que el POST /api/confirmar responda 409 recotizado en cada pedido.
 */
export function totalIndicativo(items: ItemCarro[], iva: number): number {
  const neto = items.reduce((s, i) => s + i.cantidad * i.precioNetoClp, 0);
  return neto + Math.round(neto * iva);
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
