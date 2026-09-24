import type { VercelRequest, VercelResponse } from '@vercel/node';
import { crearAlertar } from '../../src/pago/alerta.js';
import { createBarridoHandler } from '../../src/pago/barrido.js';

// Mismo techo que el resto de api/pago/ (lo exige la prueba del techo). El
// techo efectivo lo pone vercel.json; este export es documentacion.
export const maxDuration = 300;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return createBarridoHandler(crearAlertar(process.env))(req, res);
}
