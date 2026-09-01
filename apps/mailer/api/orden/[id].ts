import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createOrdenHandler } from '../../src/orden.js';

// Envoltorio fino, igual que api/cotizacion/[id].ts: el id llega en
// req.query.id por la ruta dinamica de Vercel; la validacion de entorno vive
// en el handler mismo porque las pruebas lo ejercitan inyectando `env`.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return createOrdenHandler()(req, res);
}
