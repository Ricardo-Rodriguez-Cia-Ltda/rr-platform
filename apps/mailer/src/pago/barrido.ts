import type { VercelRequest, VercelResponse } from '@vercel/node';
import { firstString } from '@rr/http/http';
import { listarAprobadasViejas, type PagoEnv, type PagoRow } from './datos.js';
import { formatearClp } from './mensajes.js';
import { UMBRAL_FILA_ATASCADA_MS, type Alertar } from './webhook.js';

/**
 * El barrido periodico de filas atascadas en `aprobado`.
 *
 * Hasta aca, detectar una fila atascada -- pago cobrado, orden no emitida --
 * dependia de que Mercado Pago mandara OTRA notificacion mas de diez minutos
 * despues de la reclamacion. Las dos que manda de rutina llegan con segundos
 * de diferencia, y despues de un 200 no tiene motivo para mandar una tercera:
 * una fila realmente muerta podia no alertar nunca. Este endpoint recorre esas
 * filas sin que nadie se lo pida. Lo llama Vercel Cron (ver vercel.json).
 *
 * Se repite en cada corrida mientras la fila siga en `aprobado`, a proposito:
 * es plata cobrada sin orden, y se calla sola cuando alguien resuelve la fila
 * (la mueve a `emitido` o `aprobado_sin_emitir`). No hay columna para anotar
 * "ya avise" y agregarla seria una migracion a mano.
 */
const REQUERIDAS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'CRON_SECRET'] as const;

export interface BarridoEnv extends PagoEnv {
  // Lo manda Vercel en `Authorization: Bearer <CRON_SECRET>` en cada llamada
  // del cron. Sin el, cualquiera que sepa la URL podria hacer que el interno
  // reciba un correo por corrida.
  CRON_SECRET?: string;
}

function minutosDesde(marca: unknown, ahoraMs: number): number | null {
  const t = Date.parse(String(marca ?? ''));
  return Number.isNaN(t) ? null : Math.round((ahoraMs - t) / 60_000);
}

export function redactarAlertaAtascadas(filas: PagoRow[], ahoraMs: number): { asunto: string; detalle: string } {
  const n = filas.length;
  const asunto = n === 1
    ? '1 pago atascado en aprobado sin orden emitida'
    : `${n} pagos atascados en aprobado sin orden emitida`;
  const lineas = filas.map((f) => {
    const min = minutosDesde(f.aprobado_at, ahoraMs);
    const edad = min === null ? 'sin marca de reclamacion' : `reclamado hace ${min} min`;
    return `- Pedido ${f.numero ?? 'S/N'} (cotizacion ${f.quote_id}), pago MP ${f.mp_payment_id ?? 'sin id'}, `
      + `${formatearClp(Number(f.monto_clp))}, ${edad}.`;
  });
  const detalle = [
    'Estas filas de `pagos` llevan mas de diez minutos en estado `aprobado`: el pago se cobro y la '
    + 'emision de las ordenes de compra no llego a su desenlace. Lo mas probable es que el proceso se '
    + 'haya muerto a mitad de camino.',
    '',
    ...lineas,
    '',
    'Que hacer: revisar el correo de ordenes de compra y el backoffice. Si las ordenes salieron, mover '
    + 'la fila a `emitido` (y el pedido a pagado); si no salieron, emitirlas a mano y despues mover la '
    + 'fila. Si hay que devolver la plata, moverla a `aprobado_sin_emitir` y avisarle al cliente.',
    '',
    'Este aviso se repite cada 30 minutos mientras alguna fila siga en `aprobado`.',
  ].join('\n');
  return { asunto, detalle };
}

export function createBarridoHandler(alertar: Alertar, ahora: () => number = Date.now) {
  return async function handler(
    req: VercelRequest,
    res: VercelResponse,
    env: BarridoEnv = process.env as BarridoEnv,
  ): Promise<void> {
    if (req.method !== 'GET') {
      res.status(405).json({ ok: false, error: 'metodo_no_permitido' });
      return;
    }
    // Sin secreto configurado el endpoint no puede autorizar a nadie: mejor
    // un 503 que lo diga que un 401 que mande a buscar un problema de
    // credenciales que no existe. Y nunca abierto.
    if (!env.CRON_SECRET) {
      res.status(503).json({ ok: false, error: 'falta_configuracion', faltan: ['CRON_SECRET'] });
      return;
    }
    const auth = firstString(req.headers.authorization) ?? '';
    if (auth !== `Bearer ${env.CRON_SECRET}`) {
      res.status(401).json({ ok: false, error: 'no_autorizado' });
      return;
    }
    const faltan = REQUERIDAS.filter((n) => !env[n]);
    if (faltan.length > 0) {
      res.status(503).json({ ok: false, error: 'falta_configuracion', faltan });
      return;
    }

    const ahoraMs = ahora();
    const filas = await listarAprobadasViejas(env, ahoraMs - UMBRAL_FILA_ATASCADA_MS);
    if (filas === null) {
      // Un barrido que falla en silencio es el mismo hueco que este endpoint
      // existe para cerrar.
      await alertar(
        'El barrido de pagos atascados no pudo consultar la base',
        'Supabase no respondio al listar las filas de `pagos` en estado `aprobado`. Si se repite en la '
        + 'proxima corrida, revisar la base a mano: puede haber plata cobrada sin orden que nadie esta viendo.',
      );
      res.status(503).json({ ok: false, error: 'upstream' });
      return;
    }
    if (filas.length === 0) {
      res.status(200).json({ ok: true, atascadas: 0 });
      return;
    }
    const { asunto, detalle } = redactarAlertaAtascadas(filas, ahoraMs);
    await alertar(asunto, detalle);
    res.status(200).json({ ok: true, atascadas: filas.length, cotizaciones: filas.map((f) => f.quote_id) });
  };
}
