import { randomUUID } from 'node:crypto';

import { fetchWithTimeout } from './http.js';
import { normalizeCurrency } from '@rr/domain/currency';
import type { NormalizedProduct } from '@rr/domain/product';
import type { PriceInfo, PriceQuery, PriceResult, Provider } from '@rr/domain/types';
import { ProviderError } from '@rr/domain/types';

const DEFAULT_BASE_URL = 'https://api.ingrammicro.com';
const DEFAULT_TOKEN_URL = 'https://api.ingrammicro.com/oauth/oauth30/token';
const DEFAULT_COUNTRY = 'CL';

/** Tope documentado del endpoint de price & availability. */
const MAX_SKUS_PER_BATCH = 50;

/**
 * Maximo que acepta el catalogo por pagina.
 *
 * Ojo: Ingram devuelve aproximadamente la mitad de lo que se le pide (pedir
 * 100 trae ~50), y su `recordsFound` es inestable entre llamadas. Por eso el
 * volcado no confia en ese numero para saber cuando termino: corta con la
 * primera pagina vacia.
 */
const PAGE_SIZE = 100;

/**
 * Ingram permite 60 llamadas por minuto y por endpoint, y responde 429 al
 * pasarse. El catalogo de Chile son ~60 paginas, o sea justo el limite: sin
 * pausa entre paginas el volcado se corta a la mitad.
 */
const DEFAULT_MS_BETWEEN_PAGES = 1100;

/**
 * Tope de paginas del volcado de catalogo. Existe para que un `recordsFound`
 * inesperadamente enorme no deje el arranque descargando para siempre; cuando
 * se alcanza se registra, porque un catalogo truncado en silencio se lee como
 * "ese producto no existe en Ingram".
 */
const DEFAULT_MAX_PAGES = 500;

/** Se renueva el token un poco antes de que expire, no justo al vencer. */
const TOKEN_MARGIN_MS = 60 * 1000;

export function isConfigured(): boolean {
  return Boolean(
    process.env.INGRAM_CLIENT_ID &&
      process.env.INGRAM_CLIENT_SECRET &&
      process.env.INGRAM_CUSTOMER_NUMBER,
  );
}

interface CachedToken {
  value: string;
  expiresAt: number;
}

let token: CachedToken | null = null;
// Varias peticiones concurrentes con el token vencido no deben pedir uno cada
// una: la primera comparte su promesa con el resto.
let pendingTokenRequest: Promise<CachedToken> | null = null;

/**
 * Descarta el token cacheado.
 *
 * La usan el reintento ante 401 y los tests: no es un helper de pruebas.
 */
export function forgetToken(): void {
  token = null;
  pendingTokenRequest = null;
}

interface TokenResponse {
  access_token?: string;
  expires_in?: string | number;
}

async function requestToken(): Promise<CachedToken> {
  const clientId = process.env.INGRAM_CLIENT_ID;
  const clientSecret = process.env.INGRAM_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new ProviderError('upstream', 'Ingram credentials are not configured');
  }

  const url = process.env.INGRAM_TOKEN_URL || DEFAULT_TOKEN_URL;
  let response: Response;
  try {
    response = await fetchWithTimeout(url, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        grant_type: 'client_credentials',
        client_id: clientId,
        client_secret: clientSecret,
      }),
    });
  } catch {
    throw new ProviderError('upstream', 'Could not reach Ingram');
  }

  const text = await response.text().catch(() => '');
  if (!response.ok) {
    throw new ProviderError(
      'upstream',
      `Ingram rechazo las credenciales (HTTP ${response.status})`,
      text.slice(0, 500),
    );
  }

  let data: TokenResponse;
  try {
    data = JSON.parse(text) as TokenResponse;
  } catch {
    throw new ProviderError('upstream', 'Ingram returned an invalid token response');
  }
  if (!data.access_token) {
    throw new ProviderError('upstream', 'Ingram no devolvio access_token');
  }

  const durationMs = Number(data.expires_in) * 1000;
  return {
    value: data.access_token,
    // Sin expires_in usable se asume vencido de inmediato: pedir un token de
    // mas es barato, usar uno vencido devuelve 401 en medio de una cotizacion.
    expiresAt: Number.isFinite(durationMs) && durationMs > 0 ? Date.now() + durationMs : 0,
  };
}

async function getToken(): Promise<string> {
  if (token && Date.now() < token.expiresAt - TOKEN_MARGIN_MS) return token.value;
  if (!pendingTokenRequest) {
    pendingTokenRequest = requestToken()
      .then((fresh) => {
        token = fresh;
        return fresh;
      })
      .finally(() => {
        pendingTokenRequest = null;
      });
  }
  return (await pendingTokenRequest).value;
}

function buildHeaders(bearer: string): Record<string, string> {
  const customerNumber = process.env.INGRAM_CUSTOMER_NUMBER;
  if (!customerNumber) {
    throw new ProviderError('upstream', 'Falta INGRAM_CUSTOMER_NUMBER');
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearer}`,
    Accept: 'application/json',
    'IM-CustomerNumber': customerNumber,
    'IM-CountryCode': process.env.INGRAM_COUNTRY_CODE || DEFAULT_COUNTRY,
    // Ingram exige un identificador distinto por transaccion para poder
    // rastrearla de su lado; repetirlo mezcla peticiones en sus logs.
    'IM-CorrelationID': randomUUID().replace(/-/g, ''),
  };
  const senderId = process.env.INGRAM_SENDER_ID;
  if (senderId) headers['IM-SenderID'] = senderId;
  return headers;
}

export async function fetchIngram(
  path: string,
  options: { params?: Record<string, string>; body?: unknown } = {},
): Promise<Response> {
  const rawBaseUrl = process.env.INGRAM_BASE_URL || DEFAULT_BASE_URL;
  const url = new URL(path.replace(/^\//, ''), rawBaseUrl.endsWith('/') ? rawBaseUrl : `${rawBaseUrl}/`);
  for (const [key, value] of Object.entries(options.params ?? {})) {
    url.searchParams.set(key, value);
  }

  async function request(): Promise<Response> {
    const headers = buildHeaders(await getToken());
    const init: RequestInit = { headers };
    if (options.body !== undefined) {
      init.method = 'POST';
      init.body = JSON.stringify(options.body);
      headers['content-type'] = 'application/json';
    }

    try {
      return await fetchWithTimeout(url, init);
    } catch {
      throw new ProviderError('upstream', 'Could not reach Ingram');
    }
  }

  const response = await request();

  // Un 401 con un token que todavia creemos vigente significa que Ingram lo
  // invalido antes de su `expires_in` —pasa, por ejemplo, cuando se emite otro
  // token para el mismo cliente—. Sin este reintento el proceso sigue usando
  // el token muerto hasta que el reloj diga que vencio: visto en produccion,
  // 24 horas con Ingram fuera de toda comparacion y sin mas rastro que un 401
  // repetido en el log.
  //
  // Se reintenta una sola vez: si el token recien pedido tambien da 401, el
  // problema son las credenciales y insistir no lo arregla.
  if (response.status !== 401) return response;

  console.error('[ingram] 401 con el token cacheado; se pide uno nuevo y se reintenta');
  forgetToken();
  return request();
}

async function readJson<T>(response: Response, context: string): Promise<T> {
  const text = await response.text().catch(() => '');
  if (!response.ok) {
    // 429 y el 4xx generico que Ingram usa al agotarse la cuota se nombran
    // aparte: no es que fallara nada aguas arriba, es que pedimos demasiado
    // rapido, y quien lea el log tiene que saber que la cura es esperar.
    const quotaExceeded = response.status === 429 || /quota limit exceeds/i.test(text);
    throw new ProviderError(
      'upstream',
      quotaExceeded
        ? `Ingram corto por cuota al pedir ${context} (permite 60 llamadas por minuto y por endpoint)`
        : `Ingram responded with HTTP ${response.status} al pedir ${context}`,
      text.slice(0, 500),
    );
  }
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new ProviderError('upstream', 'Ingram returned an invalid JSON response');
  }
}

export interface IngramProduct {
  ingramPartNumber?: string;
  vendorPartNumber?: string | null;
  upcCode?: string | null;
  description?: string | null;
  vendorName?: string | null;
  category?: string | null;
  subCategory?: string | null;
  productType?: string | null;
  type?: string | null;
}

interface CatalogPage {
  recordsFound?: number;
  pageSize?: number;
  pageNumber?: number;
  catalog?: IngramProduct[];
}

export function normalizeProduct(raw: IngramProduct): NormalizedProduct {
  return {
    sku: raw.ingramPartNumber ?? '',
    // vendorPartNumber es el part number del fabricante: la clave de union.
    // ingramPartNumber es el codigo interno de Ingram y no sirve para comparar.
    mpn: raw.vendorPartNumber?.trim() || null,
    nombre: raw.description?.trim() || null,
    marca: raw.vendorName?.trim() || null,
    categoria: raw.category?.trim() || null,
    subcategorias: raw.subCategory?.trim() ? [raw.subCategory.trim()] : [],
    // productType es el tipo comercial ("LCD Monitors"); `type` viene como
    // "IM::Physical", un prefijo interno de Ingram que no aporta al consumidor.
    tipo: raw.productType?.trim() || null,
  };
}

function msBetweenPages(): number {
  const raw = Number(process.env.INGRAM_MS_ENTRE_PAGINAS);
  return Number.isFinite(raw) && raw >= 0 ? raw : DEFAULT_MS_BETWEEN_PAGES;
}

// Sin unref: la pausa es parte de una descarga en curso, y un timer que no
// sostiene el event loop deja el proceso terminando a mitad del volcado.
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function maxPages(): number {
  const raw = Number(process.env.INGRAM_MAX_PAGINAS);
  return Number.isInteger(raw) && raw > 0 ? raw : DEFAULT_MAX_PAGES;
}

export async function loadIngramCatalog(): Promise<NormalizedProduct[]> {
  const productos: NormalizedProduct[] = [];
  const limit = maxPages();
  let page = 1;
  let found: number | null = null;

  const pause = msBetweenPages();

  for (; page <= limit; page += 1) {
    // La pausa va antes de cada pagina menos la primera: sin ella el volcado
    // dispara ~60 llamadas en pocos segundos y Ingram lo corta por cuota.
    if (page > 1 && pause > 0) await sleep(pause);

    const response = await readJson<CatalogPage>(
      await fetchIngram('resellers/v6/catalog', {
        params: { pageNumber: String(page), pageSize: String(PAGE_SIZE) },
      }),
      'el catalogo',
    );

    if (found === null && typeof response.recordsFound === 'number') {
      found = response.recordsFound;
    }

    const batch = response.catalog ?? [];
    // Una pagina vacia es el fin real del listado. No se usa `recordsFound`
    // para cortar: Ingram devuelve menos items de los pedidos y ese contador
    // varia entre llamadas, asi que confiar en el deja el catalogo incompleto.
    if (batch.length === 0) break;

    for (const raw of batch) {
      // Sin ingramPartNumber no hay como cotizarlo ni referenciarlo despues.
      if (raw.ingramPartNumber) productos.push(normalizeProduct(raw));
    }
  }

  if (page > limit) {
    console.error(
      `[ingram] catalogo truncado en ${limit} paginas (${productos.length} productos de ${found ?? '?'}); sube INGRAM_MAX_PAGINAS`,
    );
  }

  if (productos.length === 0) {
    throw new Error('Ingram no devolvio productos en el catalogo');
  }
  return productos;
}

interface IngramPriceItem {
  ingramPartNumber?: string;
  vendorPartNumber?: string | null;
  description?: string | null;
  productStatusCode?: string | null;
  productStatusMessage?: string | null;
  availability?: {
    available?: boolean;
    totalAvailability?: number | null;
  } | null;
  pricing?: {
    currencyCode?: string | null;
    retailPrice?: number | null;
    customerPrice?: number | null;
  } | null;
}

/**
 * `customerPrice` es lo que efectivamente paga el cliente una vez aplicados
 * descuentos y precios especiales; `retailPrice` es referencia de lista. Se
 * cotiza sobre el primero, con el segundo como respaldo.
 */
function toPriceInfo(item: IngramPriceItem): PriceInfo | null {
  const value = item.pricing?.customerPrice ?? item.pricing?.retailPrice;
  if (value == null) return null;
  return {
    price: value,
    currency: normalizeCurrency(item.pricing?.currencyCode),
    inStock: toStock(item.availability),
  };
}

/**
 * Ingram informa la disponibilidad dos veces: `totalAvailability` con las
 * unidades y `available` con un si/no. Cuando manda el booleano pero no el
 * numero, quedarse solo con el numero convierte "hay stock" en "no se sabe", y
 * aguas arriba eso se lee como "no hay" y el producto pierde la comparacion.
 *
 * Con `available: false` se devuelve 0 —es un no explicito—; con `true` sin
 * numero no se inventa una cantidad: null significa "hay, cuanto no se dice".
 */
function toStock(availability: IngramPriceItem['availability']): number | null {
  const units = availability?.totalAvailability;
  if (units != null) return units;
  if (availability?.available === false) return 0;
  return null;
}

async function queryPrices(
  items: Record<string, string>[],
): Promise<IngramPriceItem[]> {
  const response = await readJson<IngramPriceItem[]>(
    await fetchIngram('resellers/v6/catalog/priceandavailability', {
      params: { includeAvailability: 'true', includePricing: 'true' },
      body: { products: items },
    }),
    'precio y disponibilidad',
  );
  return Array.isArray(response) ? response : [];
}

export async function getPrices(skus: string[]): Promise<Map<string, PriceInfo>> {
  const prices = new Map<string, PriceInfo>();
  if (skus.length === 0) return prices;
  if (skus.length > MAX_SKUS_PER_BATCH) {
    throw new ProviderError(
      'upstream',
      `Ingram accepts at most ${MAX_SKUS_PER_BATCH} SKUs per request`,
    );
  }

  const items = await queryPrices(skus.map((sku) => ({ ingramPartNumber: sku })));

  for (const item of items) {
    if (!item.ingramPartNumber) continue;
    const price = toPriceInfo(item);
    if (price) prices.set(item.ingramPartNumber, price);
  }
  return prices;
}

export async function getPrice(query: PriceQuery): Promise<PriceResult> {
  const selector: Record<string, string> = {};
  if (query.sku) selector.ingramPartNumber = query.sku;
  else if (query.mpn) selector.vendorPartNumber = query.mpn;
  else if (query.upc) selector.upc = query.upc;

  const items = await queryPrices([selector]);
  const item = items[0];
  if (!item) {
    throw new ProviderError('not_found', 'Product not found at Ingram');
  }

  const priceInfo = toPriceInfo(item);
  if (!priceInfo) {
    // Ingram responde 200 con el item y un motivo cuando no lo puede cotizar
    // (SKU inexistente, no autorizado para el cliente): perder ese mensaje
    // convierte "no estas autorizado" en un 404 mudo.
    throw new ProviderError(
      'not_found',
      item.productStatusMessage?.trim() || 'Ingram returned no price for this product',
    );
  }

  return {
    provider: 'ingram',
    sku: item.ingramPartNumber ?? null,
    mpn: item.vendorPartNumber?.trim() || null,
    description: item.description?.trim() || null,
    price: priceInfo.price,
    currency: priceInfo.currency,
    inStock: priceInfo.inStock,
  };
}

export const ingram: Provider = {
  name: 'ingram',
  maxSkusPerBatch: MAX_SKUS_PER_BATCH,
  isConfigured,
  loadCatalog: loadIngramCatalog,
  getPrices,
  getPrice,
};
