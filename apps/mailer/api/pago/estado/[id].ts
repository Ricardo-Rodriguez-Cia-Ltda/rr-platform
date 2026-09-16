import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createEstadoHandler } from '../../../src/pago/estado.js';

// Mismo techo que el resto de api/pago/: lo exige la prueba «techo de
// ejecucion de las rutas de pago». Este handler no lo necesita (un GET con
// un timeout de 8s), pero una excepcion en la regla es peor que 300s sin usar.
export const maxDuration = 300;

// Envoltorio fino, patron de api/cotizacion/[id].ts: el id llega en
// req.query.id por la ruta dinamica de Vercel.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return createEstadoHandler()(req, res);
}
