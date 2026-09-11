import { createGmailTransport, createMailer, type Mailer } from '@rr/mailer';
import type { Alertar } from './webhook.js';

export interface AlertaEnv {
  GMAIL_USER?: string;
  GMAIL_APP_PASSWORD?: string;
  MAILER_FROM?: string;
  MAILER_ALLOWED_RECIPIENTS?: string;
}

/**
 * Aviso interno para los casos en que hay plata recibida y ninguna orden
 * emitida. Es best-effort a proposito: un fallo del correo no puede cambiar la
 * respuesta del webhook -- la fila en Supabase ya dice la verdad, y hacer que
 * Mercado Pago reintente por un correo caido solo agrega ruido.
 */
export function crearAlertar(env: AlertaEnv, mailerInyectado?: Mailer): Alertar {
  return async (asunto: string, detalle: string): Promise<void> => {
    const destino = String(env.MAILER_ALLOWED_RECIPIENTS ?? '').split(',')[0]?.trim();
    if (!destino) return;
    try {
      const mailer = mailerInyectado ?? createMailer(
        createGmailTransport({
          user: env.GMAIL_USER as string,
          appPassword: env.GMAIL_APP_PASSWORD as string,
        }),
        env.MAILER_FROM as string,
      );
      await mailer.send({
        to: destino,
        subject: `[pagos] ${asunto}`,
        text: detalle,
        html: `<p>${detalle.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`,
      });
    } catch {
      // Ya quedo en la fila de `pagos`; el correo es un extra.
      console.error('[pago] no se pudo mandar la alerta interna');
    }
  };
}
