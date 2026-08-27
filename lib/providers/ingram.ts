import { randomUUID } from 'node:crypto';

import { fetchConTimeout } from '../http.js';
import { normalizarMoneda } from '@rr/domain/currency';
import type { ProductoNormalizado } from '../producto.js';
import type { PriceInfo, PriceQuery, PriceResult, Proveedor } from '../types.js';
import { ProviderError } from '../types.js';

const BASE_URL_POR_DEFECTO = 'https://api.ingrammicro.com';
const TOKEN_URL_POR_DEFECTO = 'https://api.ingrammicro.com/oauth/oauth30/token';
const PAIS_POR_DEFECTO = 'CL';

/** Tope documentado del endpoint de price & availability. */
const MAX_SKUS_POR_LOTE = 50;

/**
 * Maximo que acepta el catalogo por pagina.
 *
 * Ojo: Ingram devuelve aproximadamente la mitad de lo que se le pide (pedir
 * 100 trae ~50), y su `recordsFound` es inestable entre llamadas. Por eso el
 * volcado no confia en ese numero para saber cuando termino: corta con la
 * primera pagina vacia.
 */
const TAMANO_PAGINA = 100;

/**
 * Ingram permite 60 llamadas por minuto y por endpoint, y responde 429 al
 * pasarse. El catalogo de Chile son ~60 paginas, o sea justo el limite: sin
 * pausa entre paginas el volcado se corta a la mitad.
 */
const MS_ENTRE_PAGINAS_POR_DEFECTO = 1100;

/**
 * Tope de paginas del volcado de catalogo. Existe para que un `recordsFound`
 * inesperadamente enorme no deje el arranque descargando para siempre; cuando
 * se alcanza se registra, porque un catalogo truncado en silencio se lee como
 * "ese producto no existe en Ingram".
 */
const MAX_PAGINAS_POR_DEFECTO = 500;

/** Se renueva el token un poco antes de que expire, no justo al vencer. */
const MARGEN_TOKEN_MS = 60 * 1000;

export function estaConfigurado(): boolean {
  return Boolean(
    process.env.INGRAM_CLIENT_ID &&
      process.env.INGRAM_CLIENT_SECRET &&
      process.env.INGRAM_CUSTOMER_NUMBER,
  );
}

interface TokenVigente {
  valor: string;
  expiraEn: number;
}

let token: TokenVigente | null = null;
// Varias peticiones concurrentes con el token vencido no deben pedir uno cada
// una: la primera comparte su promesa con el resto.
let tokenEnCurso: Promise<TokenVigente> | null = null;

/**
 * Descarta el token cacheado.
 *
 * La usan el reintento ante 401 y los tests: no es un helper de pruebas.
 */
export function olvidarToken(): void {
  token = null;
  tokenEnCurso = null;
}

interface RespuestaToken {
  access_token?: string;
  expires_in?: string | number;
}

async function pedirToken(): Promise<TokenVigente> {
  const clientId = process.env.INGRAM_CLIENT_ID;
  const clientSecret = process.env.INGRAM_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new ProviderError('upstream', 'Ingram credentials are not configured');
  }

  const url = process.env.INGRAM_TOKEN_URL || TOKEN_URL_POR_DEFECTO;
  let response: Response;
  try {
    response = await fetchConTimeout(url, {
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

  const texto = await response.text().catch(() => '');
  if (!response.ok) {
    throw new ProviderError(
      'upstream',
      `Ingram rechazo las credenciales (HTTP ${response.status})`,
      texto.slice(0, 500),
    );
  }

  let datos: RespuestaToken;
  try {
    datos = JSON.parse(texto) as RespuestaToken;
  } catch {
    throw new ProviderError('upstream', 'Ingram returned an invalid token response');
  }
  if (!datos.access_token) {
    throw new ProviderError('upstream', 'Ingram no devolvio access_token');
  }

  const duracionMs = Number(datos.expires_in) * 1000;
  return {
    valor: datos.access_token,
    // Sin expires_in usable se asume vencido de inmediato: pedir un token de
    // mas es barato, usar uno vencido devuelve 401 en medio de una cotizacion.
    expiraEn: Number.isFinite(duracionMs) && duracionMs > 0 ? Date.now() + duracionMs : 0,
  };
}

async function obtenerToken(): Promise<string> {
  if (token && Date.now() < token.expiraEn - MARGEN_TOKEN_MS) return token.valor;
  if (!tokenEnCurso) {
    tokenEnCurso = pedirToken()
      .then((nuevo) => {
        token = nuevo;
        return nuevo;
      })
      .finally(() => {
        tokenEnCurso = null;
      });
  }
  return (await tokenEnCurso).valor;
}

function cabeceras(bearer: string): Record<string, string> {
  const cliente = process.env.INGRAM_CUSTOMER_NUMBER;
  if (!cliente) {
    throw new ProviderError('upstream', 'Falta INGRAM_CUSTOMER_NUMBER');
  }
  const headers: Record<string, string> = {
    Authorization: `Bearer ${bearer}`,
    Accept: 'application/json',
    'IM-CustomerNumber': cliente,
    'IM-CountryCode': process.env.INGRAM_COUNTRY_CODE || PAIS_POR_DEFECTO,
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
  opciones: { params?: Record<string, string>; body?: unknown } = {},
): Promise<Response> {
  const rawBaseUrl = process.env.INGRAM_BASE_URL || BASE_URL_POR_DEFECTO;
  const url = new URL(path.replace(/^\//, ''), rawBaseUrl.endsWith('/') ? rawBaseUrl : `${rawBaseUrl}/`);
  for (const [clave, valor] of Object.entries(opciones.params ?? {})) {
    url.searchParams.set(clave, valor);
  }

  async function pedir(): Promise<Response> {
    const headers = cabeceras(await obtenerToken());
    const init: RequestInit = { headers };
    if (opciones.body !== undefined) {
      init.method = 'POST';
      init.body = JSON.stringify(opciones.body);
      headers['content-type'] = 'application/json';
    }

    try {
      return await fetchConTimeout(url, init);
    } catch {
      throw new ProviderError('upstream', 'Could not reach Ingram');
    }
  }

  const respuesta = await pedir();

  // Un 401 con un token que todavia creemos vigente significa que Ingram lo
  // invalido antes de su `expires_in` —pasa, por ejemplo, cuando se emite otro
  // token para el mismo cliente—. Sin este reintento el proceso sigue usando
  // el token muerto hasta que el reloj diga que vencio: visto en produccion,
  // 24 horas con Ingram fuera de toda comparacion y sin mas rastro que un 401
  // repetido en el log.
  //
  // Se reintenta una sola vez: si el token recien pedido tambien da 401, el
  // problema son las credenciales y insistir no lo arregla.
  if (respuesta.status !== 401) return respuesta;

  console.error('[ingram] 401 con el token cacheado; se pide uno nuevo y se reintenta');
  olvidarToken();
  return pedir();
}

async function leerJson<T>(response: Response, contexto: string): Promise<T> {
  const texto = await response.text().catch(() => '');
  if (!response.ok) {
    // 429 y el 4xx generico que Ingram usa al agotarse la cuota se nombran
    // aparte: no es que fallara nada aguas arriba, es que pedimos demasiado
    // rapido, y quien lea el log tiene que saber que la cura es esperar.
    const porCuota = response.status === 429 || /quota limit exceeds/i.test(texto);
    throw new ProviderError(
      'upstream',
      porCuota
        ? `Ingram corto por cuota al pedir ${contexto} (permite 60 llamadas por minuto y por endpoint)`
        : `Ingram responded with HTTP ${response.status} al pedir ${contexto}`,
      texto.slice(0, 500),
    );
  }
  try {
    return JSON.parse(texto) as T;
  } catch {
    throw new ProviderError('upstream', 'Ingram returned an invalid JSON response');
  }
}

export interface ProductoIngram {
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

interface PaginaCatalogo {
  recordsFound?: number;
  pageSize?: number;
  pageNumber?: number;
  catalog?: ProductoIngram[];
}

export function normalizarProducto(crudo: ProductoIngram): ProductoNormalizado {
  return {
    sku: crudo.ingramPartNumber ?? '',
    // vendorPartNumber es el part number del fabricante: la clave de union.
    // ingramPartNumber es el codigo interno de Ingram y no sirve para comparar.
    mpn: crudo.vendorPartNumber?.trim() || null,
    nombre: crudo.description?.trim() || null,
    marca: crudo.vendorName?.trim() || null,
    categoria: crudo.category?.trim() || null,
    subcategorias: crudo.subCategory?.trim() ? [crudo.subCategory.trim()] : [],
    // productType es el tipo comercial ("LCD Monitors"); `type` viene como
    // "IM::Physical", un prefijo interno de Ingram que no aporta al consumidor.
    tipo: crudo.productType?.trim() || null,
  };
}

function msEntrePaginas(): number {
  const crudo = Number(process.env.INGRAM_MS_ENTRE_PAGINAS);
  return Number.isFinite(crudo) && crudo >= 0 ? crudo : MS_ENTRE_PAGINAS_POR_DEFECTO;
}

// Sin unref: la pausa es parte de una descarga en curso, y un timer que no
// sostiene el event loop deja el proceso terminando a mitad del volcado.
function esperar(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function maxPaginas(): number {
  const crudo = Number(process.env.INGRAM_MAX_PAGINAS);
  return Number.isInteger(crudo) && crudo > 0 ? crudo : MAX_PAGINAS_POR_DEFECTO;
}

export async function cargarCatalogoIngram(): Promise<ProductoNormalizado[]> {
  const productos: ProductoNormalizado[] = [];
  const tope = maxPaginas();
  let pagina = 1;
  let encontrados: number | null = null;

  const pausa = msEntrePaginas();

  for (; pagina <= tope; pagina += 1) {
    // La pausa va antes de cada pagina menos la primera: sin ella el volcado
    // dispara ~60 llamadas en pocos segundos y Ingram lo corta por cuota.
    if (pagina > 1 && pausa > 0) await esperar(pausa);

    const respuesta = await leerJson<PaginaCatalogo>(
      await fetchIngram('resellers/v6/catalog', {
        params: { pageNumber: String(pagina), pageSize: String(TAMANO_PAGINA) },
      }),
      'el catalogo',
    );

    if (encontrados === null && typeof respuesta.recordsFound === 'number') {
      encontrados = respuesta.recordsFound;
    }

    const lote = respuesta.catalog ?? [];
    // Una pagina vacia es el fin real del listado. No se usa `recordsFound`
    // para cortar: Ingram devuelve menos items de los pedidos y ese contador
    // varia entre llamadas, asi que confiar en el deja el catalogo incompleto.
    if (lote.length === 0) break;

    for (const crudo of lote) {
      // Sin ingramPartNumber no hay como cotizarlo ni referenciarlo despues.
      if (crudo.ingramPartNumber) productos.push(normalizarProducto(crudo));
    }
  }

  if (pagina > tope) {
    console.error(
      `[ingram] catalogo truncado en ${tope} paginas (${productos.length} productos de ${encontrados ?? '?'}); sube INGRAM_MAX_PAGINAS`,
    );
  }

  if (productos.length === 0) {
    throw new Error('Ingram no devolvio productos en el catalogo');
  }
  return productos;
}

interface ItemPrecioIngram {
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
function aPrecio(item: ItemPrecioIngram): PriceInfo | null {
  const valor = item.pricing?.customerPrice ?? item.pricing?.retailPrice;
  if (valor == null) return null;
  return {
    price: valor,
    currency: normalizarMoneda(item.pricing?.currencyCode),
    inStock: aStock(item.availability),
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
function aStock(disponibilidad: ItemPrecioIngram['availability']): number | null {
  const unidades = disponibilidad?.totalAvailability;
  if (unidades != null) return unidades;
  if (disponibilidad?.available === false) return 0;
  return null;
}

async function consultarPrecios(
  productos: Record<string, string>[],
): Promise<ItemPrecioIngram[]> {
  const respuesta = await leerJson<ItemPrecioIngram[]>(
    await fetchIngram('resellers/v6/catalog/priceandavailability', {
      params: { includeAvailability: 'true', includePricing: 'true' },
      body: { products: productos },
    }),
    'precio y disponibilidad',
  );
  return Array.isArray(respuesta) ? respuesta : [];
}

export async function getPrices(skus: string[]): Promise<Map<string, PriceInfo>> {
  const precios = new Map<string, PriceInfo>();
  if (skus.length === 0) return precios;
  if (skus.length > MAX_SKUS_POR_LOTE) {
    throw new ProviderError(
      'upstream',
      `Ingram accepts at most ${MAX_SKUS_POR_LOTE} SKUs per request`,
    );
  }

  const items = await consultarPrecios(skus.map((sku) => ({ ingramPartNumber: sku })));

  for (const item of items) {
    if (!item.ingramPartNumber) continue;
    const precio = aPrecio(item);
    if (precio) precios.set(item.ingramPartNumber, precio);
  }
  return precios;
}

export async function getPrice(query: PriceQuery): Promise<PriceResult> {
  const producto: Record<string, string> = {};
  if (query.sku) producto.ingramPartNumber = query.sku;
  else if (query.mpn) producto.vendorPartNumber = query.mpn;
  else if (query.upc) producto.upc = query.upc;

  const items = await consultarPrecios([producto]);
  const item = items[0];
  if (!item) {
    throw new ProviderError('not_found', 'Product not found at Ingram');
  }

  const precio = aPrecio(item);
  if (!precio) {
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
    price: precio.price,
    currency: precio.currency,
    inStock: precio.inStock,
  };
}

export const ingram: Proveedor = {
  nombre: 'ingram',
  maxSkusPorLote: MAX_SKUS_POR_LOTE,
  estaConfigurado,
  cargarCatalogo: cargarCatalogoIngram,
  getPrecios: getPrices,
  getPrecio: getPrice,
};
