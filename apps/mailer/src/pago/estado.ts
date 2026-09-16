import type { VercelRequest, VercelResponse } from '@vercel/node';
import { firstString } from '@rr/http/http';
import { leerPago, type PagoEnv, type PagoRow } from './datos.js';
import { vigenciaUtil } from './quote.js';

// Publico por URL de capacidad, misma politica que GET /api/cotizacion/{id}:
// el quote_id es un UUID v4 y conocerlo es la credencial. Por eso la forma del
// id se valida antes de tocar la base, y un id malo responde lo mismo que una
// fila inexistente: no hay que darle a nadie una sonda para distinguirlos.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUERIDAS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] as const;

export interface EstadoPago {
  estado: PagoRow['estado'];
  monto_clp: number;
  intentos_rechazados: number;
  expira_at: string;
  init_point?: string;
}

/**
 * Lo unico de la fila que sale por este endpoint. Es una lista blanca, no un
 * `omit`: un campo nuevo en `pagos` no viaja hasta que alguien lo agregue aca
 * a proposito. Nunca telefono, datos, preference_id ni mp_payment_id.
 *
 * `init_point` solo mientras se puede pagar: fila pendiente y link vivo. El
 * link muere 15 minutos antes que la cotizacion (MARGEN_VIGENCIA_MS), asi que
 * la vigencia se mide con `vigenciaUtil`, no contra `expira_at` a secas. Una
 * fila pendiente sin init_point es, para la pagina, "el link vencio".
 */
export function proyectarEstado(fila: PagoRow, ahoraMs: number): EstadoPago {
  const sePuedePagar = fila.estado === 'pendiente' && vigenciaUtil(String(fila.expira_at), ahoraMs);
  return {
    estado: fila.estado,
    monto_clp: Number(fila.monto_clp),
    intentos_rechazados: Number(fila.intentos_rechazados ?? 0),
    expira_at: String(fila.expira_at),
    ...(sePuedePagar ? { init_point: fila.init_point } : {}),
  };
}

export function createEstadoHandler(ahora: () => number = Date.now) {
  return async function handler(
    req: VercelRequest,
    res: VercelResponse,
    env: PagoEnv = process.env as PagoEnv,
  ): Promise<void> {
    if (req.method !== 'GET') {
      res.status(405).json({ ok: false, error: 'metodo_no_permitido' });
      return;
    }
    // La pagina del pedido lo consulta en bucle mientras espera el webhook:
    // una respuesta cacheada le mentiria justo cuando cambia.
    res.setHeader('Cache-Control', 'no-store');

    const id = firstString(req.query.id as string | string[] | undefined) ?? '';
    if (!UUID_RE.test(id)) {
      res.status(404).json({ ok: false, error: 'no_encontrado' });
      return;
    }

    const faltan = REQUERIDAS.filter((n) => !env[n]);
    if (faltan.length > 0) {
      res.status(503).json({ ok: false, error: 'falta_configuracion', faltan });
      return;
    }

    const fila = await leerPago(env, id);
    if (fila === undefined) {
      res.status(503).json({ ok: false, error: 'upstream' });
      return;
    }
    if (fila === null) {
      res.status(404).json({ ok: false, error: 'no_encontrado' });
      return;
    }
    res.status(200).json({ ok: true, ...proyectarEstado(fila, ahora()) });
  };
}
