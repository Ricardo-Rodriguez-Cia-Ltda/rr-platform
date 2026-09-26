// Carro client-side. Las funciones puras se testean; las dos de storage son
// envoltorios finos con try/catch (localStorage puede no existir o lanzar).
export interface ItemCarro {
  sku: string; mpn: string | null; marca: string | null; nombre: string;
  cantidad: number;
  /** Mayorista ganador que entrego el sku, cuando /search lo informo. */
  proveedor?: string;
  /** Neto unitario en CLP: es la unidad con la que el bot arma el total. */
  precioNetoClp: number;
  /** Neto unitario + IVA, solo para MOSTRAR el precio de una unidad. */
  precioTiendaClp: number;
}

export const MAX_LINEAS = 10;
export const MAX_UNIDADES = 20;
const CLAVE = 'drc-carro';

/**
 * Identifica una linea del carro por PRODUCTO, no por sku: el sku es del
 * mayorista ganador y puede cambiar de una busqueda a otra sin que el
 * producto sea otro (ver docs/superpowers/specs de union-key). Con mpn y
 * marca se arma la misma clave que usa la union entre mayoristas (mpn
 * compactado + primera palabra de la marca); sin eso, el sku es lo unico
 * estable.
 */
function claveProducto(item: Pick<ItemCarro, 'sku' | 'mpn' | 'marca'>): string {
  const mpn = String(item?.mpn ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const marca = String(item?.marca ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  if (mpn && marca) return `${mpn}|${marca}`;
  return `sku:${item?.sku}`;
}

export function agregar(items: ItemCarro[], nuevo: ItemCarro): ItemCarro[] | { error: string } {
  // Validar cantidad ANTES de las dos ramas
  const cantidad = nuevo.cantidad;
  if (!Number.isFinite(cantidad) || !Number.isInteger(cantidad) || cantidad < 1) {
    return { error: 'Cantidad inválida.' };
  }
  if (cantidad > MAX_UNIDADES) {
    return { error: `Máximo ${MAX_UNIDADES} unidades por producto.` };
  }

  const clave = claveProducto(nuevo);
  const existente = items.find((i) => claveProducto(i) === clave);
  if (existente) {
    if (existente.cantidad + cantidad > MAX_UNIDADES) {
      return { error: `Máximo ${MAX_UNIDADES} unidades por producto.` };
    }
    // El sku, proveedor y precios se reemplazan por los del item nuevo: es el
    // precio vigente, y puede venir de otro mayorista que el de la ultima vez.
    return items.map((i) => (claveProducto(i) === clave
      ? { ...i, cantidad: i.cantidad + cantidad, sku: nuevo.sku, proveedor: nuevo.proveedor, precioNetoClp: nuevo.precioNetoClp, precioTiendaClp: nuevo.precioTiendaClp }
      : i));
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
  // `Number(...) || 0`: un carro guardado en localStorage antes de que
  // ItemCarro tuviera `precioNetoClp` daria NaN y la pagina mostraria "$NaN".
  const neto = items.reduce((s, i) => s + i.cantidad * (Number(i.precioNetoClp) || 0), 0);
  return neto + Math.round(neto * iva);
}

export function contarUnidades(items: ItemCarro[]): number {
  return items.reduce((n, i) => n + i.cantidad, 0);
}

/**
 * Colapsa lineas que comparten la clave de producto: pasa cuando un carro se
 * guardo antes de este cambio (una linea por sku, aunque fuera el mismo
 * producto) o si dos agregados consecutivos no pasaron por `agregar` (nunca
 * deberia, pero leerCarro no confia en lo que hay en localStorage). Las
 * cantidades se suman con tope MAX_UNIDADES; sku, proveedor y precios quedan
 * los de la ULTIMA linea de cada clave.
 */
function fusionarPorClave(items: ItemCarro[]): ItemCarro[] {
  const orden: string[] = [];
  const porClave = new Map<string, ItemCarro>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const clave = claveProducto(item);
    const previo = porClave.get(clave);
    const cantidadPrevia = previo ? Number(previo.cantidad) || 0 : 0;
    const cantidadNueva = Number(item.cantidad) || 0;
    if (!previo) orden.push(clave);
    porClave.set(clave, { ...item, cantidad: Math.min(MAX_UNIDADES, cantidadPrevia + cantidadNueva) });
  }
  return orden.map((clave) => porClave.get(clave)!);
}

export function leerCarro(): ItemCarro[] {
  try {
    const crudo = localStorage.getItem(CLAVE);
    const parsed = crudo ? JSON.parse(crudo) : [];
    return Array.isArray(parsed) ? fusionarPorClave(parsed) : [];
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
