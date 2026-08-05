import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '../lib/auth';
import { intcomex } from '../lib/providers/intcomex';
import type { Provider } from '../lib/types';
import { ProviderError } from '../lib/types';

const providers: Record<string, Provider> = {
  intcomex,
};

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
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
  const provider = providers[providerName];
  if (!provider) {
    res.status(400).json({
      error: 'bad_request',
      detail: `Unknown provider '${providerName}'. Available: ${Object.keys(providers).join(', ')}`,
    });
    return;
  }

  try {
    const result = await provider.getPrice({ sku, mpn, upc });
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof ProviderError) {
      const status = error.kind === 'not_found' ? 404 : 502;
      res.status(status).json({ error: error.kind, detail: error.message });
      return;
    }
    res.status(502).json({ error: 'upstream', detail: 'Unexpected error calling provider' });
  }
}
