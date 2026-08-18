import type { ProductoNormalizado } from '../producto.js';
import type { PriceInfo, PriceQuery, PriceResult, Proveedor } from '../types.js';
import { ProviderError } from '../types.js';

const BASE_URL_POR_DEFECTO = 'http://200.6.78.34/stock/v1/';

/**
 * El catalogo completo viene en una sola respuesta (~500 KB, ~1.500 productos),
 * asi que no hay un tope real de SKUs por lote: el handler nunca necesita
 * partir la consulta en dos descargas del mismo archivo.
 */
const MAX_SKUS_POR_LOTE = 5000;

/**
 * Tecnoglobal corta el acceso por cantidad de consultas en una ventana de 10
 * minutos ("Acceso denegado. Excede la cantidad max. de consultas en el tiempo
 * [10 min.]", que ademas responde con HTTP 401). No hay endpoint de lote por
 * SKU: cada cotizacion tendria que bajar el catalogo entero, y una sola
 * busqueda nos dejaria sin cuota.
 *
 * Por eso los precios se sirven de una foto en memoria. Su vida util por
 * defecto queda por debajo de la ventana del proveedor, de modo que el peor
 * caso sea una descarga por ventana.
 */
const TTL_PRECIOS_MS_POR_DEFECTO = 9 * 60 * 1000;

export function estaConfigurado(): boolean {
  return Boolean(process.env.TECNOGLOBAL_USER && process.env.TECNOGLOBAL_PASSWORD);
}

/**
 * Basic con la contrasena ya hasheada en MD5: es lo que entrega el area TI de
 * Tecnoglobal y lo que su servicio espera literalmente, no un hash que
 * calculemos nosotros sobre la contrasena en claro.
 */
function autorizacion(): string {
  const usuario = process.env.TECNOGLOBAL_USER;
  const clave = process.env.TECNOGLOBAL_PASSWORD;
  if (!usuario || !clave) {
    throw new ProviderError('upstream', 'Tecnoglobal credentials are not configured');
  }
  return `Basic ${Buffer.from(`${usuario}:${clave}`).toString('base64')}`;
}

export async function fetchStock(path: string): Promise<Response> {
  const rawBaseUrl = process.env.TECNOGLOBAL_BASE_URL || BASE_URL_POR_DEFECTO;
  const baseUrl = rawBaseUrl.endsWith('/') ? rawBaseUrl : `${rawBaseUrl}/`;
  const cabecera = autorizacion();

  try {
    return await fetch(new URL(path, baseUrl), {
      headers: { Authorization: cabecera, Accept: 'application/json' },
    });
  } catch {
    throw new ProviderError('upstream', 'Could not reach Tecnoglobal');
  }
}

export interface ProductoTecnoglobal {
  codigoTg: string;
  pnFabricante?: string | null;
  upcEan13?: string | null;
  marca?: string | null;
  descripcion?: string | null;
  categoria?: string | null;
  subCategoria?: string | null;
  ofertaSiNo?: number;
  precio?: number | null;
  tipoMoneda?: string | null;
  dolarTg?: number;
  timeStamp?: string;
  stockDisp?: number | null;
}

interface RespuestaTecnoglobal {
  error?: boolean;
  message?: string;
  products?: ProductoTecnoglobal[];
}

/**
 * Tecnoglobal responde 200 tanto cuando encuentra articulos como cuando no
 * ("Articulos no fueron encontrados", sin la clave `products`), y responde 401
 * tanto por credenciales malas como por exceso de consultas. Ni el status ni
 * la presencia de `products` alcanzan por si solos: hay que mirar `error` y el
 * mensaje.
 */
async function leerProductos(response: Response): Promise<ProductoTecnoglobal[]> {
  const texto = await response.text().catch(() => '');

  let datos: RespuestaTecnoglobal | null = null;
  try {
    datos = JSON.parse(texto) as RespuestaTecnoglobal;
  } catch {
    datos = null;
  }

  if (!response.ok) {
    throw new ProviderError(
      'upstream',
      esCuotaExcedida(datos)
        ? 'Tecnoglobal rechazo la consulta por exceso de llamadas en su ventana de 10 minutos'
        : `Tecnoglobal responded with HTTP ${response.status}`,
      texto.slice(0, 500),
    );
  }
  if (!datos) {
    throw new ProviderError('upstream', 'Tecnoglobal returned an invalid JSON response');
  }
  if (datos.error) {
    throw new ProviderError('upstream', datos.message ?? 'Tecnoglobal reported an error');
  }
  return Array.isArray(datos.products) ? datos.products : [];
}

function esCuotaExcedida(datos: RespuestaTecnoglobal | null): boolean {
  return /excede la cantidad/i.test(datos?.message ?? '');
}

/**
 * El UPC viaja como "0" cuando el producto no tiene codigo asignado; dejarlo
 * pasar convertiria a "0" en la clave que empareja productos sin relacion.
 */
function upcValido(upc: string | null | undefined): string | null {
  const limpio = (upc ?? '').trim();
  return limpio && limpio !== '0' ? limpio : null;
}

export function normalizarProducto(crudo: ProductoTecnoglobal): ProductoNormalizado {
  return {
    sku: crudo.codigoTg,
    mpn: crudo.pnFabricante?.trim() || null,
    nombre: crudo.descripcion ?? null,
    marca: crudo.marca ?? null,
    categoria: crudo.categoria ?? null,
    subcategorias: crudo.subCategoria ? [crudo.subCategoria] : [],
    tipo: null,
  };
}

function aPrecio(crudo: ProductoTecnoglobal): PriceInfo | null {
  if (crudo.precio == null) return null;
  return {
    price: crudo.precio,
    currency: crudo.tipoMoneda ?? 'USD',
    inStock: crudo.stockDisp ?? null,
  };
}

interface Foto {
  productos: ProductoTecnoglobal[];
  obtenidaEn: number;
}

let foto: Foto | null = null;
// Varias peticiones concurrentes no deben disparar varias descargas: la
// primera comparte su promesa con las que llegan mientras baja el catalogo.
let descargaEnCurso: Promise<Foto> | null = null;

function ttlPrecios(): number {
  const crudo = Number(process.env.TECNOGLOBAL_PRECIOS_TTL_MS);
  return Number.isFinite(crudo) && crudo >= 0 ? crudo : TTL_PRECIOS_MS_POR_DEFECTO;
}

async function descargarCatalogo(): Promise<Foto> {
  const productos = await leerProductos(await fetchStock('price'));
  const nueva: Foto = { productos, obtenidaEn: Date.now() };
  foto = nueva;
  return nueva;
}

async function obtenerFoto(): Promise<Foto> {
  if (foto && Date.now() - foto.obtenidaEn < ttlPrecios()) return foto;
  if (!descargaEnCurso) {
    descargaEnCurso = descargarCatalogo().finally(() => {
      descargaEnCurso = null;
    });
  }
  return descargaEnCurso;
}

export function _resetFotoParaTests(): void {
  foto = null;
  descargaEnCurso = null;
}

export async function cargarCatalogoTecnoglobal(): Promise<ProductoNormalizado[]> {
  // El refresco diario del catalogo trae exactamente el mismo cuerpo que usan
  // los precios, asi que deja la foto lista y evita una segunda descarga.
  const { productos } = await descargarCatalogo();
  if (productos.length === 0) {
    throw new Error('Tecnoglobal no devolvio productos en /price');
  }
  return productos.map(normalizarProducto);
}

export async function getPrices(skus: string[]): Promise<Map<string, PriceInfo>> {
  const precios = new Map<string, PriceInfo>();
  if (skus.length === 0) return precios;

  const { productos } = await obtenerFoto();
  const pedidos = new Set(skus);
  for (const crudo of productos) {
    if (!pedidos.has(crudo.codigoTg)) continue;
    const precio = aPrecio(crudo);
    if (precio) precios.set(crudo.codigoTg, precio);
  }
  return precios;
}

export async function getPrice(query: PriceQuery): Promise<PriceResult> {
  // Tambien sale de la foto: el endpoint por SKU existe, pero gasta una
  // consulta de la cuota para traer lo que ya tenemos en memoria.
  const { productos } = await obtenerFoto();

  const encontrado = productos.find((c) => {
    if (query.sku) return c.codigoTg === query.sku;
    if (query.mpn) return (c.pnFabricante ?? '').trim() === query.mpn;
    if (query.upc) return upcValido(c.upcEan13) === query.upc;
    return false;
  });

  if (!encontrado) {
    throw new ProviderError('not_found', 'Product not found at Tecnoglobal');
  }

  const precio = aPrecio(encontrado);
  if (!precio) {
    throw new ProviderError('not_found', 'Tecnoglobal returned no price for this product');
  }

  return {
    provider: 'tecnoglobal',
    sku: encontrado.codigoTg,
    mpn: encontrado.pnFabricante?.trim() || null,
    description: encontrado.descripcion ?? null,
    price: precio.price,
    currency: precio.currency,
    inStock: precio.inStock,
  };
}

export const tecnoglobal: Proveedor = {
  nombre: 'tecnoglobal',
  maxSkusPorLote: MAX_SKUS_POR_LOTE,
  estaConfigurado,
  cargarCatalogo: cargarCatalogoTecnoglobal,
  getPrecios: getPrices,
  getPrecio: getPrice,
};
