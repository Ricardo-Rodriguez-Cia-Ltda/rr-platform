import nodemailer from 'nodemailer';
import type { Transport } from './index.js';

/**
 * Timeouts del transporte SMTP, en milisegundos.
 *
 * Sin ellos nodemailer usa los suyos, que son de otra escala: 2 minutos para
 * conectar y 10 para el socket. Mientras el techo de las funciones era de 30s
 * eso quedaba acotado por el techo mismo; con las rutas de pago en 300s un
 * servidor de correo colgado puede retener el webhook de Mercado Pago casi
 * cinco minutos, y la rama de pago ya procesado puede mandar dos alertas
 * seguidas.
 *
 * Los valores salen de lo que tarda un envio real contra smtp.gmail.com --
 * decimas de segundo por fase -- con un orden de magnitud de margen, no de un
 * numero redondo:
 *
 * - 10s para conectar y 10s para el saludo: si el TCP o el banner no llegan en
 *   ese tiempo el servidor no esta, y esperar mas no lo mejora.
 * - 20s de socket: cubre el envio del cuerpo, que es la fase que de verdad
 *   puede tardar. Las alertas de pagos son texto corto.
 *
 * Peor caso, 40s por envio y 80s para los dos envios seguidos de la rama de ya
 * procesado: holgadamente por debajo de los 300s del techo, con sitio de sobra
 * para todo lo demas que ese handler hace antes.
 */
export const TIMEOUTS_SMTP = {
  connectionTimeout: 10_000,
  greetingTimeout: 10_000,
  socketTimeout: 20_000,
} as const;

// Puerto 465 con TLS directo. El 587 tambien sirve, pero exige STARTTLS y da
// un modo de falla mas: negociar en claro y quedarse ahi.
//
// Los timeouts son opcionales con default: los consumidores que ya existen
// (api/send.ts, la alerta interna de pagos) no tocan nada, y un consumidor con
// otro servidor de correo o con adjuntos pesados puede subirlos sin que este
// paquete tenga que saber de el.
export function createGmailTransport(config: {
  user: string;
  appPassword: string;
  connectionTimeoutMs?: number;
  greetingTimeoutMs?: number;
  socketTimeoutMs?: number;
}): Transport {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: config.user, pass: config.appPassword },
    connectionTimeout: config.connectionTimeoutMs ?? TIMEOUTS_SMTP.connectionTimeout,
    greetingTimeout: config.greetingTimeoutMs ?? TIMEOUTS_SMTP.greetingTimeout,
    socketTimeout: config.socketTimeoutMs ?? TIMEOUTS_SMTP.socketTimeout,
  });
}
