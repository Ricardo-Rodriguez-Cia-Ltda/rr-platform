import nodemailer from 'nodemailer';
import type { Transport } from './index.js';

// Puerto 465 con TLS directo. El 587 tambien sirve, pero exige STARTTLS y da
// un modo de falla mas: negociar en claro y quedarse ahi.
export function createGmailTransport(config: { user: string; appPassword: string }): Transport {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: config.user, pass: config.appPassword },
  });
}
