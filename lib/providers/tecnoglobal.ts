import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { ProductoNormalizado } from '../producto.js';
import type { PriceInfo, PriceQuery, PriceResult, Proveedor } from '../types.js';
import { ProviderError } from '../types.js';

/**
 * Marca del error que devuelve Tecnoglobal al agotarse la cuota. Reintentar
 * pronto contra un servicio que ya nos rechazo por exceso de llamadas es la
 * forma mas segura de seguir rechazados, asi que el reintento la reconoce y
 * espera mucho mas.
 */
export const MENSAJE_CUOTA = 'exceso de llamadas';

const BASE_URL_POR_DEFECTO = 'http://200.6.78.34/stock/v1/';

/**
 * Como se cotiza contra Tecnoglobal.
 *
 * Sus dos endpoints se comportan de forma muy distinta, medido contra el
 * servicio real:
 *
 * - `/price` (catalogo completo, ~500 KB) se agota en pocas llamadas y queda
 *   respondiendo 401 "Excede la cantidad max. de consultas en el tiempo
 *   [10 min.]" durante bastante mas que esos 10 minutos. Es rapido pero
 *   practicamente irrepetible.
 * - `/price/{sku}` aguanta decenas de llamadas seguidas sin quejarse, pero
 *   tarda ~1,5 s cada una y no mejora al pedirlas en paralelo: el servicio las
 *   atiende de a una.
 *
 * De ahi el reparto:
 *
 * - Pocos SKUs (una ficha, una cotizacion puntual) se piden en vivo por SKU:
 *   es el precio del momento y son las llamadas que de verdad se cotizan.
 * - Muchos SKUs (el ranking de una busqueda) salen de la foto del ultimo
 *   volcado. Pedir 25 en vivo serian ~37 s de espera, inaceptable para una
 *   busqueda, y el precio definitivo igual se confirma con /product.
 */
const UMBRAL_CONSULTA_DIRECTA = 5;

/**
 * Tope de SKUs por lote. Alto a proposito: sobre la foto no hay costo por SKU,
 * y el handler ya limita cuantos candidatos vale la pena cotizar.
 */
const MAX_SKUS_POR_LOTE = 300;

/** Consultas por SKU simultaneas. Acotado para no golpear el servicio. */
const CONCURRENCIA = 8;

/**
 * Cada cuanto se puede refrescar la foto. Una hora deja el precio de las
 * busquedas razonablemente fresco sin acercarse a la cuota del volcado.
 */
const TTL_FOTO_MS_POR_DEFECTO = 60 * 60 * 1000;

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
        ? `Tecnoglobal rechazo la consulta por ${MENSAJE_CUOTA} en su ventana de 10 minutos`
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

/**
 * La foto tambien vive en disco.
 *
 * Al reiniciar, el catalogo se recupera de su propio cache sin gastar una
 * descarga, pero la foto arrancaba vacia: la primera busqueda tenia que bajar
 * el volcado completo y, con la cuota gastada, respondia 502. Un precio viejo
 * sirve mucho mas que un error, y el definitivo igual se confirma por SKU en
 * /product.
 */
function rutaFoto(): string {
  return join(process.env.CATALOG_CACHE_DIR ?? 'cache', 'tecnoglobal-precios.json');
}

function guardarFotoEnDisco(nueva: Foto): void {
  try {
    mkdirSync(process.env.CATALOG_CACHE_DIR ?? 'cache', { recursive: true });
    writeFileSync(rutaFoto(), JSON.stringify(nueva));
  } catch (error) {
    // No poder cachear no es motivo para fallar la consulta que ya se resolvio.
    console.error('[tecnoglobal] no se pudo guardar la foto en disco', error);
  }
}

function leerFotoDeDisco(): Foto | null {
  try {
    const guardada = JSON.parse(readFileSync(rutaFoto(), 'utf8')) as Foto;
    return Array.isArray(guardada.productos) && guardada.productos.length > 0 ? guardada : null;
  } catch {
    return null;
  }
}

function ttlFoto(): number {
  const crudo = Number(process.env.TECNOGLOBAL_PRECIOS_TTL_MS);
  return Number.isFinite(crudo) && crudo >= 0 ? crudo : TTL_FOTO_MS_POR_DEFECTO;
}

async function descargarCatalogo(): Promise<Foto> {
  const productos = await leerProductos(await fetchStock('price'));
  // Una respuesta sin productos no se guarda: dejaria una foto vacia vigente
  // durante toda su vida util, y cotizar contra ella devuelve "sin precio"
  // para todo el catalogo sin que nada parezca haber fallado.
  if (productos.length === 0) {
    throw new ProviderError('upstream', 'Tecnoglobal no devolvio productos en /price');
  }
  const nueva: Foto = { productos, obtenidaEn: Date.now() };
  foto = nueva;
  guardarFotoEnDisco(nueva);
  return nueva;
}

async function obtenerFoto(): Promise<Foto> {
  // Tras un reinicio la foto en memoria esta vacia pero la de disco sirve.
  const vigente = foto ?? (foto = leerFotoDeDisco());
  if (vigente && Date.now() - vigente.obtenidaEn < ttlFoto()) return vigente;
  if (!descargaEnCurso) {
    descargaEnCurso = descargarCatalogo().finally(() => {
      descargaEnCurso = null;
    });
  }

  try {
    return await descargaEnCurso;
  } catch (error) {
    // La cuota del volcado es tan estrecha que un refresco rechazado es
    // esperable. Una foto vieja sirve mucho mas que ninguna: es el ranking de
    // una busqueda, y el precio definitivo se confirma por SKU en /product.
    if (vigente) {
      console.error('[tecnoglobal] no se pudo refrescar la foto, se usa la vencida', error);
      return vigente;
    }
    throw error;
  }
}

export function _resetFotoParaTests(): void {
  foto = null;
  descargaEnCurso = null;
}

export async function cargarCatalogoTecnoglobal(): Promise<ProductoNormalizado[]> {
  // El refresco diario del catalogo trae exactamente el mismo cuerpo que usan
  // los precios, asi que deja la foto lista y evita una segunda descarga.
  const { productos } = await descargarCatalogo();
  return productos.map(normalizarProducto);
}

async function consultarPorSku(sku: string): Promise<ProductoTecnoglobal | null> {
  const productos = await leerProductos(await fetchStock(`price/${encodeURIComponent(sku)}`));
  return productos.find((p) => p.codigoTg === sku) ?? null;
}

async function preciosEnVivo(skus: string[]): Promise<Map<string, PriceInfo>> {
  const precios = new Map<string, PriceInfo>();
  const pendientes = [...skus];

  async function trabajador(): Promise<void> {
    for (let sku = pendientes.shift(); sku !== undefined; sku = pendientes.shift()) {
      const crudo = await consultarPorSku(sku);
      if (!crudo) continue;
      const precio = aPrecio(crudo);
      if (precio) precios.set(sku, precio);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCIA, skus.length) }, () => trabajador()),
  );
  return precios;
}

async function preciosDeLaFoto(skus: string[]): Promise<Map<string, PriceInfo>> {
  const precios = new Map<string, PriceInfo>();
  const { productos } = await obtenerFoto();
  const pedidos = new Set(skus);

  for (const crudo of productos) {
    if (!pedidos.has(crudo.codigoTg)) continue;
    const precio = aPrecio(crudo);
    if (precio) precios.set(crudo.codigoTg, precio);
  }
  return precios;
}

export async function getPrices(skus: string[]): Promise<Map<string, PriceInfo>> {
  if (skus.length === 0) return new Map();
  if (skus.length > MAX_SKUS_POR_LOTE) {
    throw new ProviderError(
      'upstream',
      `Tecnoglobal se consulta de a ${MAX_SKUS_POR_LOTE} SKUs por lote`,
    );
  }

  return skus.length <= UMBRAL_CONSULTA_DIRECTA
    ? preciosEnVivo(skus)
    : preciosDeLaFoto(skus);
}

export async function getPrice(query: PriceQuery): Promise<PriceResult> {
  // Por SKU hay endpoint directo y da el precio del momento. Por MPN o UPC no
  // hay busqueda, asi que se resuelve contra la foto del ultimo volcado y se
  // vuelve a preguntar por el SKU encontrado, para no cotizar con un precio
  // que puede tener horas.
  let encontrado: ProductoTecnoglobal | null;
  if (query.sku) {
    encontrado = await consultarPorSku(query.sku);
  } else {
    const { productos } = await obtenerFoto();
    const enFoto = productos.find((c) => {
      if (query.mpn) return (c.pnFabricante ?? '').trim() === query.mpn;
      if (query.upc) return upcValido(c.upcEan13) === query.upc;
      return false;
    });
    encontrado = enFoto ? await consultarPorSku(enFoto.codigoTg) : null;
  }

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
