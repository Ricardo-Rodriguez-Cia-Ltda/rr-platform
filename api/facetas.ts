import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '../lib/auth.js';
import { CatalogUnavailableError, obtenerCatalogo } from '../lib/catalog.js';
import { calcularFacetas } from '../lib/search.js';

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method && req.method !== 'GET') {
    res.status(405).json({ error: 'method_not_allowed', detail: 'Use GET' });
    return;
  }
  if (!isAuthorized(firstString(req.headers['x-api-key']), process.env.API_SECRET_KEY)) {
    res.status(401).json({ error: 'unauthorized', detail: 'Missing or invalid x-api-key header' });
    return;
  }

  let catalogo;
  try {
    catalogo = obtenerCatalogo('intcomex');
  } catch (error) {
    if (error instanceof CatalogUnavailableError) {
      res.status(503).json({
        error: 'catalogo_no_disponible',
        detail: 'El catalogo aun no esta disponible. Reintenta mas tarde.',
      });
      return;
    }
    throw error;
  }

  const facetas = calcularFacetas(catalogo);
  res.status(200).json({ total_productos: catalogo.length, ...facetas });
}
