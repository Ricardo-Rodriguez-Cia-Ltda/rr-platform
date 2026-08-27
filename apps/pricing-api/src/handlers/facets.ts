import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '../auth.js';
import { CatalogUnavailableError, getCatalog } from '@rr/providers/catalog';
import { computeFacets } from '@rr/domain/search';
import type { Provider } from '@rr/domain/types';
import { resolveOrRespond } from './guards.js';
import { firstString, type Handler } from './types.js';

export function createFacetsHandler(provider: Provider): Handler {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method && req.method !== 'GET') {
      res.status(405).json({ error: 'method_not_allowed', detail: 'Use GET' });
      return;
    }
    if (!isAuthorized(firstString(req.headers['x-api-key']), process.env.API_SECRET_KEY)) {
      res.status(401).json({ error: 'unauthorized', detail: 'Missing or invalid x-api-key header' });
      return;
    }

    let catalog;
    try {
      catalog = getCatalog(provider.nombre);
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

    const facets = computeFacets(catalog);
    res.status(200).json({ total_productos: catalog.length, ...facets });
  };
}

/**
 * Variante para las rutas /api/{proveedor}/facetas: el proveedor no se conoce al
 * construir el handler, sale de la ruta en cada request.
 *
 * La api key se valida antes de resolver el proveedor: un cliente sin
 * autenticar no debe poder enumerar que proveedores existen probando nombres.
 */
export function createFacetsByRouteHandler(): Handler {
  return async function handler(req, res) {
    if (req.method && req.method !== 'GET') {
      res.status(405).json({ error: 'method_not_allowed', detail: 'Use GET' });
      return;
    }
    if (!isAuthorized(firstString(req.headers['x-api-key']), process.env.API_SECRET_KEY)) {
      res.status(401).json({ error: 'unauthorized', detail: 'Missing or invalid x-api-key header' });
      return;
    }

    const provider = resolveOrRespond(firstString(req.query.proveedor), res);
    if (!provider) return;

    await createFacetsHandler(provider)(req, res);
  };
}
