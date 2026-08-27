import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '../src/auth.js';
import { PROVIDERS } from '@rr/providers';
import { ProviderError } from '@rr/domain/types';

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method && req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed', detail: 'Use GET' });
    return;
  }

  const apiKeyHeader = firstString(req.headers['x-api-key']);
  if (!isAuthorized(apiKeyHeader, process.env.API_SECRET_KEY)) {
    res.status(401).json({ error: 'unauthorized', detail: 'Missing or invalid x-api-key header' });
    return;
  }

  const sku = firstString(req.query.sku);
  const mpn = firstString(req.query.mpn);
  const upc = firstString(req.query.upc);
  const identifiers = [sku, mpn, upc].filter(Boolean);
  if (identifiers.length !== 1) {
    res.status(400).json({
      error: 'bad_request',
      detail: 'Provide exactly one of: sku, mpn, upc',
    });
    return;
  }

  const providerName = firstString(req.query.provider) ?? 'intcomex';
  const provider = PROVIDERS[providerName];
  if (!provider) {
    res.status(400).json({
      error: 'bad_request',
      detail: `Unknown provider '${providerName}'. Available: ${Object.keys(PROVIDERS).join(', ')}`,
    });
    return;
  }

  try {
    const result = await provider.getPrecio({ sku, mpn, upc });
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof ProviderError) {
      const status = error.kind === 'not_found' ? 404 : 502;
      if (status === 502) console.error('[price] fallo getPrice', { sku, mpn, upc, error });
      res.status(status).json({ error: error.kind, detail: error.detail ?? error.message });
      return;
    }
    console.error('[price] fallo getPrice', { sku, mpn, upc, error });
    res.status(502).json({ error: 'upstream', detail: 'Unexpected error calling provider' });
  }
}
