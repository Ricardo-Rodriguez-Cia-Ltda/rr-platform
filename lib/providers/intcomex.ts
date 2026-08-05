import { createHash } from 'node:crypto';

import type { PriceQuery, PriceResult, Provider } from '../types.js';
import { ProviderError } from '../types.js';

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

interface IwsProduct {
  Sku?: string;
  Mpn?: string;
  Description?: string;
  Price?: { UnitPrice?: number; CurrencyId?: string } | null;
  InStock?: number;
}

function getConfig(): { apiKey: string; accessKey: string; baseUrl: string } {
  const apiKey = process.env.INTCOMEX_API_KEY;
  const accessKey = process.env.INTCOMEX_ACCESS_KEY;
  const baseUrl = process.env.INTCOMEX_BASE_URL;
  if (!apiKey || !accessKey || !baseUrl) {
    throw new ProviderError('upstream', 'Intcomex credentials are not configured');
  }
  return { apiKey, accessKey, baseUrl: baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/` };
}

export const intcomex: Provider = {
  name: 'intcomex',

  async getPrice(query: PriceQuery): Promise<PriceResult> {
    const { apiKey, accessKey, baseUrl } = getConfig();

    const url = new URL('getproduct', baseUrl);
    if (query.sku) url.searchParams.set('sku', query.sku);
    if (query.mpn) url.searchParams.set('mpn', query.mpn);
    if (query.upc) url.searchParams.set('upc', query.upc);
    url.searchParams.set('includePriceData', 'true');
    url.searchParams.set('includeInventoryData', 'true');

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${buildAuthToken(apiKey, accessKey, new Date())}`,
        },
      });
    } catch {
      throw new ProviderError('upstream', 'Could not reach Intcomex');
    }

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
      currency: product.Price.CurrencyId ?? 'USD',
      inStock: product.InStock ?? null,
    };
  },
};
