import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '../auth.js';
import { CatalogUnavailableError, obtenerCatalogo } from '../catalog.js';
import { calcularFacetas } from '../search.js';
import type { Proveedor } from '../types.js';
import { firstString, type Handler } from './tipos.js';

export function crearHandlerFacetas(proveedor: Proveedor): Handler {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
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
      catalogo = obtenerCatalogo(proveedor.nombre);
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
  };
}
