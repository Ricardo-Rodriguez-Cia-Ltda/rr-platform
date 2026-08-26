import { createHash } from 'node:crypto';

import { fetchConTimeout } from '../http.js';
import { normalizarMoneda } from '../moneda.js';
import type { PriceInfo, PriceQuery, PriceResult, Proveedor } from '../types.js';
import { ProviderError } from '../types.js';
import type { ProductoNormalizado } from '../producto.js';

export function formatUtcTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function buildSignature(
  apiKey: string,
  accessKey: string,
  utcTimeStamp: string,
): string {
  return createHash('sha256')
    .update(`${apiKey},${accessKey},${utcTimeStamp}`)
    .digest('hex');
}

export function buildAuthToken(apiKey: string, accessKey: string, now: Date): string {
  const utcTimeStamp = formatUtcTimestamp(now);
  const signature = buildSignature(apiKey, accessKey, utcTimeStamp);
  return `apiKey=${apiKey}&utcTimeStamp=${utcTimeStamp}&signature=${signature}`;
}

export async function fetchIws(
  path: string,
  params: Record<string, string> = {},
): Promise<Response> {
  const apiKey = process.env.INTCOMEX_API_KEY;
  const accessKey = process.env.INTCOMEX_ACCESS_KEY;
  const rawBaseUrl = process.env.INTCOMEX_BASE_URL;
  if (!apiKey || !accessKey || !rawBaseUrl) {
    throw new ProviderError('upstream', 'Intcomex credentials are not configured');
  }
  const baseUrl = rawBaseUrl.endsWith('/') ? rawBaseUrl : `${rawBaseUrl}/`;

  const url = new URL(path, baseUrl);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);

  try {
    return await fetchConTimeout(url, {
      headers: {
        Authorization: `Bearer ${buildAuthToken(apiKey, accessKey, new Date())}`,
      },
    });
  } catch {
    throw new ProviderError('upstream', 'Could not reach Intcomex');
  }
}

interface IwsProduct {
  Sku?: string;
  Mpn?: string;
  Description?: string;
  Price?: { UnitPrice?: number; CurrencyId?: string } | null;
  InStock?: number;
}

export async function getPrice(query: PriceQuery): Promise<PriceResult> {
  const params: Record<string, string> = {
    includePriceData: 'true',
    includeInventoryData: 'true',
  };
  if (query.sku) params.sku = query.sku;
  if (query.mpn) params.mpn = query.mpn;
  if (query.upc) params.upc = query.upc;

  const response = await fetchIws('getproduct', params);

  if (response.status === 404) {
    throw new ProviderError('not_found', 'Product not found at Intcomex');
  }
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ProviderError(
      'upstream',
      `Intcomex responded with HTTP ${response.status}`,
      body.slice(0, 500),
    );
  }

  let product: IwsProduct;
  try {
    product = (await response.json()) as IwsProduct;
  } catch {
    throw new ProviderError('upstream', 'Intcomex returned an invalid JSON response');
  }

  if (product.Price?.UnitPrice == null) {
    throw new ProviderError('not_found', 'Intcomex returned no price for this product');
  }

  return {
    provider: 'intcomex',
    sku: product.Sku ?? null,
    mpn: product.Mpn ?? null,
    description: product.Description ?? null,
    price: product.Price.UnitPrice,
    currency: normalizarMoneda(product.Price.CurrencyId),
    inStock: product.InStock ?? null,
  };
}

export const MAX_SKUS_POR_LLAMADA = 100;

export async function getPrices(skus: string[]): Promise<Map<string, PriceInfo>> {
  const prices = new Map<string, PriceInfo>();
  if (skus.length === 0) return prices;
  if (skus.length > MAX_SKUS_POR_LLAMADA) {
    throw new ProviderError(
      'upstream',
      `Intcomex accepts at most ${MAX_SKUS_POR_LLAMADA} SKUs per request`,
    );
  }

  const response = await fetchIws('getproducts', {
    skusList: skus.join(','),
    includePriceData: 'true',
    includeInventoryData: 'true',
  });

  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new ProviderError(
      'upstream',
      `Intcomex responded with HTTP ${response.status}`,
      body.slice(0, 500),
    );
  }

  let items: IwsProduct[];
  try {
    items = (await response.json()) as IwsProduct[];
  } catch {
    throw new ProviderError('upstream', 'Intcomex returned an invalid JSON response');
  }

  for (const item of items ?? []) {
    if (!item.Sku || item.Price?.UnitPrice == null) continue;
    prices.set(item.Sku, {
      price: item.Price.UnitPrice,
      currency: normalizarMoneda(item.Price.CurrencyId),
      inStock: item.InStock ?? null,
    });
  }

  return prices;
}

export interface ProductoIntcomex {
  Sku: string;
  Mpn?: string | null;
  Description?: string | null;
  Type?: string | null;
  Brand?: { Description?: string | null } | null;
  Category?: {
    Description?: string | null;
    Subcategories?: { Description?: string | null }[];
  } | null;
}

export function normalizarProducto(crudo: ProductoIntcomex): ProductoNormalizado {
  return {
    sku: crudo.Sku,
    mpn: crudo.Mpn ?? null,
    nombre: crudo.Description ?? null,
    marca: crudo.Brand?.Description ?? null,
    categoria: crudo.Category?.Description ?? null,
    subcategorias: (crudo.Category?.Subcategories ?? [])
      .map((s) => s.Description)
      .filter((d): d is string => Boolean(d)),
    tipo: crudo.Type ?? null,
  };
}

export async function cargarCatalogoIntcomex(): Promise<ProductoNormalizado[]> {
  const response = await fetchIws('getcatalog');
  if (!response.ok) {
    throw new Error(`Intcomex respondió HTTP ${response.status} al pedir el catálogo`);
  }
  const datos = await response.json();
  if (!Array.isArray(datos) || datos.length === 0) {
    throw new Error('getcatalog no devolvio un arreglo de productos');
  }
  return (datos as ProductoIntcomex[]).map(normalizarProducto);
}

export const intcomex: Proveedor = {
  nombre: 'intcomex',
  maxSkusPorLote: MAX_SKUS_POR_LLAMADA,
  estaConfigurado: () =>
    Boolean(
      process.env.INTCOMEX_API_KEY &&
        process.env.INTCOMEX_ACCESS_KEY &&
        process.env.INTCOMEX_BASE_URL,
    ),
  cargarCatalogo: cargarCatalogoIntcomex,
  getPrecios: getPrices,
  getPrecio: getPrice,
};
