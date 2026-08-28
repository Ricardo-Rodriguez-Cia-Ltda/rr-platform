export interface Message {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendResult {
  id: string;
}

export interface Mailer {
  send(message: Message): Promise<SendResult>;
}

// Lo mínimo que este paquete necesita de nodemailer. Tenerlo como interfaz
// propia es lo que permite probar sin red y cambiar de transporte sin tocar
// a quien llama.
export interface Transport {
  sendMail(options: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<{ messageId: string }>;
}

export function createMailer(transport: Transport, from: string): Mailer {
  return {
    async send(message: Message): Promise<SendResult> {
      const info = await transport.sendMail({ from, ...message });
      return { id: info.messageId };
    },
  };
}

export { createGmailTransport } from './gmail.js';
