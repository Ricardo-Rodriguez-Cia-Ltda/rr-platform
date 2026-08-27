import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { fetchWithTimeout } from './http.js';
import { normalizeCurrency } from '@rr/domain/currency';
import type { NormalizedProduct } from '@rr/domain/product';
import type { PriceInfo, PriceQuery, PriceResult, Provider } from '@rr/domain/types';
import { ProviderError } from '@rr/domain/types';

/**
 * Marca del error que devuelve Tecnoglobal al agotarse la cuota. Reintentar
 * pronto contra un servicio que ya nos rechazo por exceso de llamadas es la
 * forma mas segura de seguir rechazados, asi que el reintento la reconoce y
 * espera mucho mas.
 */
export const QUOTA_MESSAGE = 'exceso de llamadas';

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

export function isConfigured(): boolean {
  return Boolean(process.env.TECNOGLOBAL_USER && process.env.TECNOGLOBAL_PASSWORD);
}

/**
 * Basic con la contrasena ya hasheada en MD5: es lo que entrega el area TI de
 * Tecnoglobal y lo que su servicio espera literalmente, no un hash que
 * calculemos nosotros sobre la contrasena en claro.
 */
function autorizacion(): string {
  const user = process.env.TECNOGLOBAL_USER;
  const password = process.env.TECNOGLOBAL_PASSWORD;
  if (!user || !password) {
    throw new ProviderError('upstream', 'Tecnoglobal credentials are not configured');
  }
  return `Basic ${Buffer.from(`${user}:${password}`).toString('base64')}`;
}

export async function fetchStock(path: string): Promise<Response> {
  const rawBaseUrl = process.env.TECNOGLOBAL_BASE_URL || BASE_URL_POR_DEFECTO;
  const baseUrl = rawBaseUrl.endsWith('/') ? rawBaseUrl : `${rawBaseUrl}/`;
  const authHeader = autorizacion();

  try {
    return await fetchWithTimeout(new URL(path, baseUrl), {
      headers: { Authorization: authHeader, Accept: 'application/json' },
    });
  } catch {
    throw new ProviderError('upstream', 'Could not reach Tecnoglobal');
  }
}

export interface TecnoglobalProduct {
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
  products?: TecnoglobalProduct[];
}

/**
 * Tecnoglobal responde 200 tanto cuando encuentra articulos como cuando no
 * ("Articulos no fueron encontrados", sin la clave `products`), y responde 401
 * tanto por credenciales malas como por exceso de consultas. Ni el status ni
 * la presencia de `products` alcanzan por si solos: hay que mirar `error` y el
 * mensaje.
 */
async function leerProductos(response: Response): Promise<TecnoglobalProduct[]> {
  const text = await response.text().catch(() => '');

  let data: RespuestaTecnoglobal | null = null;
  try {
    data = JSON.parse(text) as RespuestaTecnoglobal;
  } catch {
    data = null;
  }

  if (!response.ok) {
    throw new ProviderError(
      'upstream',
      esCuotaExcedida(data)
        ? `Tecnoglobal rechazo la consulta por ${QUOTA_MESSAGE} en su ventana de 10 minutos`
        : `Tecnoglobal responded with HTTP ${response.status}`,
      text.slice(0, 500),
    );
  }
  if (!data) {
    throw new ProviderError('upstream', 'Tecnoglobal returned an invalid JSON response');
  }
  if (data.error) {
    throw new ProviderError('upstream', data.message ?? 'Tecnoglobal reported an error');
  }
  return Array.isArray(data.products) ? data.products : [];
}

function esCuotaExcedida(data: RespuestaTecnoglobal | null): boolean {
  return /excede la cantidad/i.test(data?.message ?? '');
}

/**
 * El UPC viaja como "0" cuando el producto no tiene codigo asignado; dejarlo
 * pasar convertiria a "0" en la clave que empareja productos sin relacion.
 */
function upcValido(upc: string | null | undefined): string | null {
  const clean = (upc ?? '').trim();
  return clean && clean !== '0' ? clean : null;
}

export function normalizeProduct(raw: TecnoglobalProduct): NormalizedProduct {
  return {
    sku: raw.codigoTg,
    mpn: raw.pnFabricante?.trim() || null,
    nombre: raw.descripcion ?? null,
    marca: raw.marca ?? null,
    categoria: raw.categoria ?? null,
    subcategorias: raw.subCategoria ? [raw.subCategoria] : [],
    tipo: null,
  };
}

function aPrecio(raw: TecnoglobalProduct): PriceInfo | null {
  if (raw.precio == null) return null;
  return {
    price: raw.precio,
    currency: normalizeCurrency(raw.tipoMoneda),
    inStock: raw.stockDisp ?? null,
  };
}

interface Snapshot {
  productos: TecnoglobalProduct[];
  obtenidaEn: number;
}

let cachedSnapshot: Snapshot | null = null;
// Varias peticiones concurrentes no deben disparar varias descargas: la
// primera comparte su promesa con las que llegan mientras baja el catalogo.
let downloadInProgress: Promise<Snapshot> | null = null;

/**
 * La foto tambien vive en disco.
 *
 * Al reiniciar, el catalogo se recupera de su propio cache sin gastar una
 * descarga, pero la foto arrancaba vacia: la primera busqueda tenia que bajar
 * el volcado completo y, con la cuota gastada, respondia 502. Un precio viejo
 * sirve mucho mas que un error, y el definitivo igual se confirma por SKU en
 * /product.
 */
function snapshotPath(): string {
  return join(process.env.CATALOG_CACHE_DIR ?? 'cache', 'tecnoglobal-precios.json');
}

function saveSnapshotToDisk(snapshot: Snapshot): void {
  try {
    mkdirSync(process.env.CATALOG_CACHE_DIR ?? 'cache', { recursive: true });
    writeFileSync(snapshotPath(), JSON.stringify(snapshot));
  } catch (error) {
    // No poder cachear no es motivo para fallar la consulta que ya se resolvio.
    console.error('[tecnoglobal] no se pudo guardar la foto en disco', error);
  }
}

function loadSnapshotFromDisk(): Snapshot | null {
  try {
    const stored = JSON.parse(readFileSync(snapshotPath(), 'utf8')) as Snapshot;
    return Array.isArray(stored.productos) && stored.productos.length > 0 ? stored : null;
  } catch {
    return null;
  }
}

function snapshotTtl(): number {
  const raw = Number(process.env.TECNOGLOBAL_PRECIOS_TTL_MS);
  return Number.isFinite(raw) && raw >= 0 ? raw : TTL_FOTO_MS_POR_DEFECTO;
}

async function downloadCatalog(): Promise<Snapshot> {
  const productos = await leerProductos(await fetchStock('price'));
  // Una respuesta sin productos no se guarda: dejaria una foto vacia vigente
  // durante toda su vida util, y cotizar contra ella devuelve "sin precio"
  // para todo el catalogo sin que nada parezca haber fallado.
  if (productos.length === 0) {
    throw new ProviderError('upstream', 'Tecnoglobal no devolvio productos en /price');
  }
  const snapshot: Snapshot = { productos, obtenidaEn: Date.now() };
  cachedSnapshot = snapshot;
  saveSnapshotToDisk(snapshot);
  return snapshot;
}

async function getSnapshot(): Promise<Snapshot> {
  // Tras un reinicio la foto en memoria esta vacia pero la de disco sirve.
  const current = cachedSnapshot ?? (cachedSnapshot = loadSnapshotFromDisk());
  if (current && Date.now() - current.obtenidaEn < snapshotTtl()) return current;
  if (!downloadInProgress) {
    downloadInProgress = downloadCatalog().finally(() => {
      downloadInProgress = null;
    });
  }

  try {
    return await downloadInProgress;
  } catch (error) {
    // La cuota del volcado es tan estrecha que un refresco rechazado es
    // esperable. Una foto vieja sirve mucho mas que ninguna: es el ranking de
    // una busqueda, y el precio definitivo se confirma por SKU en /product.
    if (current) {
      console.error('[tecnoglobal] no se pudo refrescar la foto, se usa la vencida', error);
      return current;
    }
    throw error;
  }
}

export function _resetSnapshotForTests(): void {
  cachedSnapshot = null;
  downloadInProgress = null;
}

export async function cargarCatalogoTecnoglobal(): Promise<NormalizedProduct[]> {
  // El refresco diario del catalogo trae exactamente el mismo cuerpo que usan
  // los precios, asi que deja la foto lista y evita una segunda descarga.
  const { productos } = await downloadCatalog();
  return productos.map(normalizeProduct);
}

async function consultarPorSku(sku: string): Promise<TecnoglobalProduct | null> {
  const productos = await leerProductos(await fetchStock(`price/${encodeURIComponent(sku)}`));
  return productos.find((p) => p.codigoTg === sku) ?? null;
}

async function preciosEnVivo(skus: string[]): Promise<Map<string, PriceInfo>> {
  const prices = new Map<string, PriceInfo>();
  const pending = [...skus];

  async function worker(): Promise<void> {
    for (let sku = pending.shift(); sku !== undefined; sku = pending.shift()) {
      const raw = await consultarPorSku(sku);
      if (!raw) continue;
      const price = aPrecio(raw);
      if (price) prices.set(sku, price);
    }
  }

  await Promise.all(
    Array.from({ length: Math.min(CONCURRENCIA, skus.length) }, () => worker()),
  );
  return prices;
}

async function pricesFromSnapshot(skus: string[]): Promise<Map<string, PriceInfo>> {
  const prices = new Map<string, PriceInfo>();
  const { productos } = await getSnapshot();
  const requested = new Set(skus);

  for (const raw of productos) {
    if (!requested.has(raw.codigoTg)) continue;
    const price = aPrecio(raw);
    if (price) prices.set(raw.codigoTg, price);
  }
  return prices;
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
    : pricesFromSnapshot(skus);
}

export async function getPrice(query: PriceQuery): Promise<PriceResult> {
  // Por SKU hay endpoint directo y da el precio del momento. Por MPN o UPC no
  // hay busqueda, asi que se resuelve contra la foto del ultimo volcado y se
  // vuelve a preguntar por el SKU encontrado, para no cotizar con un precio
  // que puede tener horas.
  let found: TecnoglobalProduct | null;
  if (query.sku) {
    found = await consultarPorSku(query.sku);
  } else {
    const { productos } = await getSnapshot();
    const inSnapshot = productos.find((c) => {
      if (query.mpn) return (c.pnFabricante ?? '').trim() === query.mpn;
      if (query.upc) return upcValido(c.upcEan13) === query.upc;
      return false;
    });
    found = inSnapshot ? await consultarPorSku(inSnapshot.codigoTg) : null;
  }

  if (!found) {
    throw new ProviderError('not_found', 'Product not found at Tecnoglobal');
  }

  const priceInfo = aPrecio(found);
  if (!priceInfo) {
    throw new ProviderError('not_found', 'Tecnoglobal returned no price for this product');
  }

  return {
    provider: 'tecnoglobal',
    sku: found.codigoTg,
    mpn: found.pnFabricante?.trim() || null,
    description: found.descripcion ?? null,
    price: priceInfo.price,
    currency: priceInfo.currency,
    inStock: priceInfo.inStock,
  };
}

export const tecnoglobal: Provider = {
  name: 'tecnoglobal',
  maxSkusPerBatch: MAX_SKUS_POR_LOTE,
  isConfigured,
  loadCatalog: cargarCatalogoTecnoglobal,
  getPrices,
  getPrice,
};
