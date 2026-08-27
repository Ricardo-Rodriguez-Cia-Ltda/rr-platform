import { CatalogUnavailableError, obtenerCatalogo } from './catalog.js';
import {
  claveUnion,
  compactarMpn,
  marcaCanonica,
  type ProductoNormalizado,
} from './product.js';
import { PROVEEDORES } from '../../../lib/providers/index.js';
import type { PriceInfo, Proveedor } from './types.js';

export interface Oferta {
  proveedor: string;
  sku: string;
  precio: number;
  moneda: string;
  stock: number | null;
}

export type Criterio =
  | 'mas_barato_con_stock'
  | 'stock_desconocido'
  | 'mas_barato_sin_stock';

export interface OfertaGanadora extends Oferta {
  criterio: Criterio;
}

export interface ProveedorAusente {
  proveedor: string;
  error: 'catalogo_no_disponible' | 'proveedor_no_configurado' | 'sin_precio' | 'upstream';
  detail: string;
}

export interface Comparacion {
  clave: string;
  mpn: string | null;
  marca: string | null;
  nombre: string | null;
  /** null cuando ningun proveedor entrego una oferta. */
  mejor: OfertaGanadora | null;
  ofertas: Oferta[];
  incompleta: ProveedorAusente[];
}

/**
 * Catalogo de un proveedor, o null si todavia no cargo.
 *
 * Envuelve el `throw` de `obtenerCatalogo` porque aca un catalogo sin cargar
 * no es un error: es un proveedor que no puede participar de la comparacion.
 */
function catalogoDe(proveedor: string): ProductoNormalizado[] | null {
  try {
    return obtenerCatalogo(proveedor);
  } catch (error) {
    if (error instanceof CatalogUnavailableError) return null;
    throw error;
  }
}

/**
 * Gana el mas barato CON stock: cotizar el mas barato sin stock es cotizar algo
 * que no se puede entregar.
 *
 * El stock nulo es su propio caso, no un cero. Significa que el proveedor no
 * informo disponibilidad, y tratarlo como ausencia hacia dos daños a la vez:
 * una oferta mas barata perdia contra una mas cara, y al cliente se le decia
 * que no se puede entregar cuando lo unico que faltaba era el dato. Por eso el
 * orden de preferencia es stock confirmado, despues desconocido, y ultimo el
 * cero confirmado, que es el unico "no" de verdad.
 */
function elegirMejor(ofertas: Oferta[]): OfertaGanadora | null {
  if (ofertas.length === 0) return null;

  const conStock = ofertas.filter((o) => o.stock !== null && o.stock > 0);
  const desconocido = ofertas.filter((o) => o.stock === null);

  let candidatas: Oferta[];
  let criterio: Criterio;
  if (conStock.length > 0) {
    candidatas = conStock;
    criterio = 'mas_barato_con_stock';
  } else if (desconocido.length > 0) {
    candidatas = desconocido;
    criterio = 'stock_desconocido';
  } else {
    candidatas = ofertas;
    criterio = 'mas_barato_sin_stock';
  }

  return { ...candidatas.reduce((a, b) => (b.precio < a.precio ? b : a)), criterio };
}

function masBarata(proveedor: string, precios: Map<string, PriceInfo>): Oferta | null {
  let mejor: Oferta | null = null;
  for (const [sku, precio] of precios) {
    // Un precio no positivo no es un precio, es ausencia de precio: sale
    // cotizado a un cliente real si se deja pasar. Tambien descarta NaN.
    if (!(precio.price > 0)) continue;
    if (!mejor || precio.price < mejor.precio) {
      mejor = {
        proveedor,
        sku,
        precio: precio.price,
        moneda: precio.currency,
        stock: precio.inStock,
      };
    }
  }
  return mejor;
}

async function cotizar(
  proveedor: Proveedor,
  productos: ProductoNormalizado[],
): Promise<Oferta | ProveedorAusente> {
  // Varios productos con la misma clave son duplicados del propio catalogo del
  // proveedor, no ofertas distintas: se piden juntos y gana el mas barato.
  const skus = productos.slice(0, proveedor.maxSkusPorLote).map((p) => p.sku);

  try {
    const oferta = masBarata(proveedor.nombre, await proveedor.getPrecios(skus));
    if (oferta) return oferta;
    return {
      proveedor: proveedor.nombre,
      error: 'sin_precio',
      detail: 'Tiene el producto en catalogo pero no entrego precio',
    };
  } catch (error) {
    return {
      proveedor: proveedor.nombre,
      error: 'upstream',
      detail: error instanceof Error ? error.message : 'Error inesperado al cotizar',
    };
  }
}

function esAusente(r: Oferta | ProveedorAusente): r is ProveedorAusente {
  return 'error' in r;
}

/**
 * Compara el mismo producto entre todos los proveedores del registro.
 *
 * No nombra a ninguno: recorre lo que le pasen, con PROVEEDORES por defecto.
 * Agregar un proveedor nuevo no toca este modulo.
 */
export async function compararPorClave(
  clave: string,
  registro: Record<string, Proveedor> = PROVEEDORES,
): Promise<Comparacion> {
  const incompleta: ProveedorAusente[] = [];
  const conElProducto: { proveedor: Proveedor; productos: ProductoNormalizado[] }[] = [];
  let descripcion: ProductoNormalizado | null = null;

  for (const proveedor of Object.values(registro)) {
    if (!proveedor.estaConfigurado()) {
      incompleta.push({
        proveedor: proveedor.nombre,
        error: 'proveedor_no_configurado',
        detail: `El proveedor '${proveedor.nombre}' no tiene credenciales configuradas`,
      });
      continue;
    }

    const catalogo = catalogoDe(proveedor.nombre);
    if (!catalogo) {
      incompleta.push({
        proveedor: proveedor.nombre,
        error: 'catalogo_no_disponible',
        detail: `El catalogo de '${proveedor.nombre}' aun no esta disponible`,
      });
      continue;
    }

    const suyos = catalogo.filter((p) => claveUnion(p) === clave);
    // Que no lo venda es una respuesta definitiva, no un hueco: su catalogo se
    // reviso. Solo se omite.
    if (suyos.length === 0) continue;

    descripcion ??= suyos[0];
    conElProducto.push({ proveedor, productos: suyos });
  }

  const resultados = await Promise.all(
    conElProducto.map(({ proveedor, productos }) => cotizar(proveedor, productos)),
  );

  const ofertas: Oferta[] = [];
  for (const r of resultados) {
    if (esAusente(r)) incompleta.push(r);
    else ofertas.push(r);
  }
  ofertas.sort((a, b) => a.precio - b.precio);

  return {
    clave,
    mpn: descripcion?.mpn ?? null,
    marca: descripcion?.marca ?? null,
    nombre: descripcion?.nombre ?? null,
    mejor: elegirMejor(ofertas),
    ofertas,
    incompleta,
  };
}

/**
 * Claves de union que un MPN produce en los catalogos cargados.
 *
 * Devuelve mas de una cuando el mismo part number existe bajo marcas distintas
 * —raro, una sola vez en los 10.411 productos de Intcomex, pero real—. El
 * llamador tiene que pedir desambiguacion en vez de elegir por el consumidor.
 */
export function resolverClaves(
  mpn: string,
  marca?: string,
  registro: Record<string, Proveedor> = PROVEEDORES,
): string[] {
  const compacto = compactarMpn(mpn);
  if (!compacto) return [];

  const filtro = marca ? marcaCanonica(marca) : null;
  const claves = new Set<string>();

  for (const nombre of Object.keys(registro)) {
    for (const p of catalogoDe(nombre) ?? []) {
      if (compactarMpn(p.mpn) !== compacto) continue;
      if (filtro && marcaCanonica(p.marca) !== filtro) continue;
      const clave = claveUnion(p);
      if (clave) claves.add(clave);
    }
  }
  return [...claves].sort();
}

export type ResolucionSku =
  | { estado: 'ok'; clave: string }
  | { estado: 'catalogo_no_disponible' }
  | { estado: 'sku_desconocido' }
  | { estado: 'no_comparable' };

/**
 * Clave de union del producto que un proveedor identifica con ese SKU.
 *
 * Devuelve un estado y no un string nulo porque los tres fracasos son tres
 * respuestas HTTP distintas.
 */
export function claveDeSku(proveedor: string, sku: string): ResolucionSku {
  const catalogo = catalogoDe(proveedor);
  if (!catalogo) return { estado: 'catalogo_no_disponible' };

  const producto = catalogo.find((p) => p.sku === sku);
  if (!producto) return { estado: 'sku_desconocido' };

  const clave = claveUnion(producto);
  return clave ? { estado: 'ok', clave } : { estado: 'no_comparable' };
}

export function hayAlgunCatalogo(
  registro: Record<string, Proveedor> = PROVEEDORES,
): boolean {
  return Object.keys(registro).some((nombre) => catalogoDe(nombre) !== null);
}

/**
 * Proveedores cuyo catalogo no cargo, con la misma forma que `incompleta`.
 *
 * resolverClaves salta estos catalogos en silencio: no encontrar el MPN ahi
 * no prueba que nadie lo venda. Separada para que el llamador pueda
 * distinguir "se revisaron todos los catalogos y ninguno lo vende" de "no se
 * pudo preguntarle a todos".
 *
 * Un proveedor sin credenciales nunca carga catalogo (server.ts lo excluye
 * del refresco), asi que hay que chequear estaConfigurado() primero: si no,
 * este proveedor caeria siempre en catalogo_no_disponible (transitorio)
 * cuando en realidad le faltan las llaves (permanente). Misma distincion que
 * ya hace compararPorClave.
 */
export function catalogosNoDisponibles(
  registro: Record<string, Proveedor> = PROVEEDORES,
): ProveedorAusente[] {
  const ausentes: ProveedorAusente[] = [];
  for (const proveedor of Object.values(registro)) {
    if (!proveedor.estaConfigurado()) {
      ausentes.push({
        proveedor: proveedor.nombre,
        error: 'proveedor_no_configurado',
        detail: `El proveedor '${proveedor.nombre}' no tiene credenciales configuradas`,
      });
      continue;
    }
    if (catalogoDe(proveedor.nombre) === null) {
      ausentes.push({
        proveedor: proveedor.nombre,
        error: 'catalogo_no_disponible',
        detail: `El catalogo de '${proveedor.nombre}' aun no esta disponible`,
      });
    }
  }
  return ausentes;
}
