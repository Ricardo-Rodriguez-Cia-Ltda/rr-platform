import { CatalogUnavailableError, getCatalog } from './catalog.js';
import {
  unionKey,
  compactMpn,
  canonicalBrand,
  type NormalizedProduct,
} from '@rr/domain/product';
import { PROVIDERS } from './index.js';
import type { PriceInfo, Provider } from '@rr/domain/types';

export interface Offer {
  proveedor: string;
  sku: string;
  precio: number;
  moneda: string;
  stock: number | null;
}

export type Criterion =
  | 'mas_barato_con_stock'
  | 'stock_desconocido'
  | 'mas_barato_sin_stock';

export interface WinningOffer extends Offer {
  criterio: Criterion;
}

export interface MissingProvider {
  proveedor: string;
  error: 'catalogo_no_disponible' | 'proveedor_no_configurado' | 'sin_precio' | 'upstream';
  detail: string;
}

export interface Comparison {
  clave: string;
  mpn: string | null;
  marca: string | null;
  nombre: string | null;
  /** null cuando ningun proveedor entrego una oferta. */
  mejor: WinningOffer | null;
  ofertas: Offer[];
  incompleta: MissingProvider[];
}

/**
 * Catalogo de un proveedor, o null si todavia no cargo.
 *
 * Envuelve el `throw` de `getCatalog` porque aca un catalogo sin cargar
 * no es un error: es un proveedor que no puede participar de la comparacion.
 */
function catalogFor(proveedor: string): NormalizedProduct[] | null {
  try {
    return getCatalog(proveedor);
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
function pickBest(ofertas: Offer[]): WinningOffer | null {
  if (ofertas.length === 0) return null;

  const withStock = ofertas.filter((o) => o.stock !== null && o.stock > 0);
  const unknownStock = ofertas.filter((o) => o.stock === null);

  let candidates: Offer[];
  let criterio: Criterion;
  if (withStock.length > 0) {
    candidates = withStock;
    criterio = 'mas_barato_con_stock';
  } else if (unknownStock.length > 0) {
    candidates = unknownStock;
    criterio = 'stock_desconocido';
  } else {
    candidates = ofertas;
    criterio = 'mas_barato_sin_stock';
  }

  return { ...candidates.reduce((a, b) => (b.precio < a.precio ? b : a)), criterio };
}

function cheapest(proveedor: string, prices: Map<string, PriceInfo>): Offer | null {
  let best: Offer | null = null;
  for (const [sku, precio] of prices) {
    // Un precio no positivo no es un precio, es ausencia de precio: sale
    // cotizado a un cliente real si se deja pasar. Tambien descarta NaN.
    if (!(precio.price > 0)) continue;
    if (!best || precio.price < best.precio) {
      best = {
        proveedor,
        sku,
        precio: precio.price,
        moneda: precio.currency,
        stock: precio.inStock,
      };
    }
  }
  return best;
}

async function quote(
  proveedor: Provider,
  productos: NormalizedProduct[],
): Promise<Offer | MissingProvider> {
  // Varios productos con la misma clave son duplicados del propio catalogo del
  // proveedor, no ofertas distintas: se piden juntos y gana el mas barato.
  const skus = productos.slice(0, proveedor.maxSkusPerBatch).map((p) => p.sku);

  try {
    const offer = cheapest(proveedor.name, await proveedor.getPrices(skus));
    if (offer) return offer;
    return {
      proveedor: proveedor.name,
      error: 'sin_precio',
      detail: 'Tiene el producto en catalogo pero no entrego precio',
    };
  } catch (error) {
    return {
      proveedor: proveedor.name,
      error: 'upstream',
      detail: error instanceof Error ? error.message : 'Error inesperado al cotizar',
    };
  }
}

function isMissing(r: Offer | MissingProvider): r is MissingProvider {
  return 'error' in r;
}

/**
 * Compara el mismo producto entre todos los proveedores del registro.
 *
 * No nombra a ninguno: recorre lo que le pasen, con PROVIDERS por defecto.
 * Agregar un proveedor nuevo no toca este modulo.
 */
export async function compareByKey(
  clave: string,
  registry: Record<string, Provider> = PROVIDERS,
): Promise<Comparison> {
  const incompleta: MissingProvider[] = [];
  const providersWithProduct: { proveedor: Provider; productos: NormalizedProduct[] }[] = [];
  let description: NormalizedProduct | null = null;

  for (const proveedor of Object.values(registry)) {
    if (!proveedor.isConfigured()) {
      incompleta.push({
        proveedor: proveedor.name,
        error: 'proveedor_no_configurado',
        detail: `El proveedor '${proveedor.name}' no tiene credenciales configuradas`,
      });
      continue;
    }

    const catalog = catalogFor(proveedor.name);
    if (!catalog) {
      incompleta.push({
        proveedor: proveedor.name,
        error: 'catalogo_no_disponible',
        detail: `El catalogo de '${proveedor.name}' aun no esta disponible`,
      });
      continue;
    }

    const matches = catalog.filter((p) => unionKey(p) === clave);
    // Que no lo venda es una respuesta definitiva, no un hueco: su catalogo se
    // reviso. Solo se omite.
    if (matches.length === 0) continue;

    description ??= matches[0];
    providersWithProduct.push({ proveedor, productos: matches });
  }

  const results = await Promise.all(
    providersWithProduct.map(({ proveedor, productos }) => quote(proveedor, productos)),
  );

  const ofertas: Offer[] = [];
  for (const r of results) {
    if (isMissing(r)) incompleta.push(r);
    else ofertas.push(r);
  }
  ofertas.sort((a, b) => a.precio - b.precio);

  return {
    clave,
    mpn: description?.mpn ?? null,
    marca: description?.marca ?? null,
    nombre: description?.nombre ?? null,
    mejor: pickBest(ofertas),
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
export function resolveKeys(
  mpn: string,
  marca?: string,
  registry: Record<string, Provider> = PROVIDERS,
): string[] {
  const compact = compactMpn(mpn);
  if (!compact) return [];

  const filter = marca ? canonicalBrand(marca) : null;
  const keys = new Set<string>();

  for (const nombre of Object.keys(registry)) {
    for (const p of catalogFor(nombre) ?? []) {
      if (compactMpn(p.mpn) !== compact) continue;
      if (filter && canonicalBrand(p.marca) !== filter) continue;
      const clave = unionKey(p);
      if (clave) keys.add(clave);
    }
  }
  return [...keys].sort();
}

export type SkuResolution =
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
export function skuKey(proveedor: string, sku: string): SkuResolution {
  const catalog = catalogFor(proveedor);
  if (!catalog) return { estado: 'catalogo_no_disponible' };

  const product = catalog.find((p) => p.sku === sku);
  if (!product) return { estado: 'sku_desconocido' };

  const clave = unionKey(product);
  return clave ? { estado: 'ok', clave } : { estado: 'no_comparable' };
}

export function hasAnyCatalog(
  registry: Record<string, Provider> = PROVIDERS,
): boolean {
  return Object.keys(registry).some((nombre) => catalogFor(nombre) !== null);
}

/**
 * Proveedores cuyo catalogo no cargo, con la misma forma que `incompleta`.
 *
 * resolveKeys salta estos catalogos en silencio: no encontrar el MPN ahi
 * no prueba que nadie lo venda. Separada para que el llamador pueda
 * distinguir "se revisaron todos los catalogos y ninguno lo vende" de "no se
 * pudo preguntarle a todos".
 *
 * Un proveedor sin credenciales nunca carga catalogo (server.ts lo excluye
 * del refresco), asi que hay que chequear isConfigured() primero: si no,
 * este proveedor caeria siempre en catalogo_no_disponible (transitorio)
 * cuando en realidad le faltan las llaves (permanente). Misma distincion que
 * ya hace compareByKey.
 */
export function unavailableCatalogs(
  registry: Record<string, Provider> = PROVIDERS,
): MissingProvider[] {
  const missing: MissingProvider[] = [];
  for (const proveedor of Object.values(registry)) {
    if (!proveedor.isConfigured()) {
      missing.push({
        proveedor: proveedor.name,
        error: 'proveedor_no_configurado',
        detail: `El proveedor '${proveedor.name}' no tiene credenciales configuradas`,
      });
      continue;
    }
    if (catalogFor(proveedor.name) === null) {
      missing.push({
        proveedor: proveedor.name,
        error: 'catalogo_no_disponible',
        detail: `El catalogo de '${proveedor.name}' aun no esta disponible`,
      });
    }
  }
  return missing;
}
