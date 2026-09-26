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
 * Alias de marca: MISMA tabla que BRAND_ALIASES en packages/domain/src/product.ts.
 *
 * La tienda no depende de @rr/domain (no esta en su package.json ni en su
 * tsconfig, que ademas excluye del build de paquetes del monorepo), asi que
 * esta tabla se copia a mano en vez de importar `canonicalBrand`. Un test en
 * carro.test.ts pinea que ambas dan el mismo resultado para las marcas de
 * esta lista; si la tabla del dominio cambia, hay que actualizar esta.
 */
const ALIAS_MARCA: [prefijo: string, canonica: string][] = [
  ['hewlett packard enterprise', 'hpe'],
  ['american power', 'apc'],
  ['hyperx', 'hp'],
  ['poly', 'hp'],
  ['hp poly', 'hp'],
  ['aruba', 'hpe'],
  ['meraki', 'cisco'],
];

/**
 * Separa en palabras igual que `tokenize` de packages/domain/src/text.ts:
 * saca acentos, pasa a minuscula y corta en cualquier corrida de caracteres
 * que no sean letra o numero (no solo espacios). Sin esto "HP-POLY" queda
 * como un solo token y nunca calza con el alias "hp poly".
 */
function normalizarPalabras(texto: string): string {
  return texto
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
    .join(' ');
}

/** Espejo de `canonicalBrand` (packages/domain/src/product.ts): ver ALIAS_MARCA. */
function marcaCanonica(marca: string | null): string {
  const normalizada = normalizarPalabras(String(marca ?? ''));
  if (!normalizada) return '';
  for (const [prefijo, canonica] of ALIAS_MARCA) {
    if (normalizada === prefijo || normalizada.startsWith(`${prefijo} `)) return canonica;
  }
  return normalizada.split(' ')[0];
}

/**
 * Identifica una linea del carro por PRODUCTO, no por sku: el sku es del
 * mayorista ganador y puede cambiar de una busqueda a otra sin que el
 * producto sea otro (ver docs/superpowers/specs de union-key). Con mpn y
 * marca se arma la misma clave que usa la union entre mayoristas (mpn
 * compactado + marca canonica, con la misma tabla de alias); sin eso, el sku
 * es lo unico estable.
 *
 * Exportada: la usan tambien Checkout.tsx (React key y quien identifica la
 * linea a cambiar) y los tests.
 */
export function claveProducto(item: Pick<ItemCarro, 'sku' | 'mpn' | 'marca'>): string {
  const mpn = String(item?.mpn ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
  const marca = marcaCanonica(item?.marca ?? null);
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

/**
 * `clave` es `claveProducto(item)`, no el sku: dos lineas de proveedores
 * distintos pueden compartir sku (ver comentario de `claveProducto`), y
 * identificar por sku cambiaria o borraria las dos a la vez.
 */
export function cambiarCantidad(items: ItemCarro[], clave: string, cantidad: number): ItemCarro[] {
  // Si no es finito, devolver items sin cambios
  if (!Number.isFinite(cantidad)) return items;
  if (cantidad <= 0) return items.filter((i) => claveProducto(i) !== clave);
  const clamped = Math.min(Math.max(1, Math.round(cantidad)), MAX_UNIDADES);
  return items.map((i) => (claveProducto(i) === clave ? { ...i, cantidad: clamped } : i));
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
 *
 * Lineas con sku vacio o con cantidad invalida (no finita o <= 0) se
 * descartan en vez de colarse como una linea de 0 unidades: `agregar` y
 * `cambiarCantidad` nunca guardan algo asi, asi que solo puede venir de
 * localStorage tocado a mano, y una cantidad 0 igual llega a
 * `validarPedido` como "cantidad invalida" en vez de desaparecer del carro.
 */
function fusionarPorClave(items: ItemCarro[]): ItemCarro[] {
  const orden: string[] = [];
  const porClave = new Map<string, ItemCarro>();
  for (const item of items) {
    if (!item || typeof item !== 'object') continue;
    const sku = typeof item.sku === 'string' ? item.sku.trim() : '';
    const cantidadNueva = Number(item.cantidad);
    if (!sku || !Number.isFinite(cantidadNueva) || cantidadNueva <= 0) continue;
    const clave = claveProducto(item);
    const previo = porClave.get(clave);
    const cantidadPrevia = previo ? Number(previo.cantidad) || 0 : 0;
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
