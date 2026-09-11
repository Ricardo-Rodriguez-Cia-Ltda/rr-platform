import { beforeEach, describe, expect, it, vi } from 'vitest';

type OpcionesSmtp = Record<string, any>;
const createTransport = vi.fn((_opciones: OpcionesSmtp) => (
  { sendMail: async () => ({ messageId: '<x@gmail.com>' }) }
));
vi.mock('nodemailer', () => ({ default: { createTransport } }));

const { TIMEOUTS_SMTP, createGmailTransport } = await import('../src/gmail.js');

const CREDENCIALES = { user: 'ordenes@ejemplo.cl', appPassword: 'clave-de-aplicacion' };

// =====================================================================
// R4: el transporte se creaba sin timeouts y nodemailer deja el socket
// abierto varios minutos por defecto. Mientras el techo de las rutas era de
// 30s eso estaba acotado por el techo mismo; con las rutas de pago en 300s un
// servidor de correo colgado puede retener el webhook mucho mas, y la rama de
// ya procesado puede mandar dos alertas seguidas.
// =====================================================================
describe('createGmailTransport', () => {
  beforeEach(() => createTransport.mockClear());

  it('construye el transporte con timeouts explicitos', () => {
    createGmailTransport(CREDENCIALES);
    const opciones = createTransport.mock.calls[0][0];
    expect(opciones.connectionTimeout).toBe(TIMEOUTS_SMTP.connectionTimeout);
    expect(opciones.greetingTimeout).toBe(TIMEOUTS_SMTP.greetingTimeout);
    expect(opciones.socketTimeout).toBe(TIMEOUTS_SMTP.socketTimeout);
  });

  // El techo de las rutas de pago es 300s y en la rama de ya procesado puede
  // haber dos envios secuenciales: las tres fases de un envio, dos veces,
  // tienen que caber con mucho aire.
  it('el peor caso de dos envios seguidos cabe holgadamente bajo el techo de 300s', () => {
    const porEnvio = TIMEOUTS_SMTP.connectionTimeout
      + TIMEOUTS_SMTP.greetingTimeout
      + TIMEOUTS_SMTP.socketTimeout;
    expect(porEnvio * 2).toBeLessThan(120_000);
  });

  it('sigue siendo 465 con TLS directo y la autenticacion que le pasan', () => {
    createGmailTransport(CREDENCIALES);
    const opciones = createTransport.mock.calls[0][0];
    expect(opciones.host).toBe('smtp.gmail.com');
    expect(opciones.port).toBe(465);
    expect(opciones.secure).toBe(true);
    expect(opciones.auth).toEqual({ user: CREDENCIALES.user, pass: CREDENCIALES.appPassword });
  });

  // packages/mailer lo usan tambien otros consumidores (api/send.ts): el
  // cambio no puede obligarlos a pasar nada, pero un consumidor con otro
  // servidor de correo tiene que poder subirlos.
  it('los timeouts son configurables sin romper a quien no los pasa', () => {
    createGmailTransport({ ...CREDENCIALES, socketTimeoutMs: 45_000 });
    const opciones = createTransport.mock.calls[0][0];
    expect(opciones.socketTimeout).toBe(45_000);
    expect(opciones.connectionTimeout).toBe(TIMEOUTS_SMTP.connectionTimeout);
  });
});
