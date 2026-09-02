import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createCotizacionHandler } from '../../src/cotizacion.js';

// Envoltorio fino, igual que api/send.ts: el id llega en req.query.id por la
// ruta dinamica de Vercel. La validacion de entorno (503 falta_configuracion)
// vive en el handler mismo -- ver src/cotizacion.ts -- porque las pruebas lo
// ejercitan inyectando `env` directamente en el factory, sin pasar por aqui.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return createCotizacionHandler()(req, res);
}
