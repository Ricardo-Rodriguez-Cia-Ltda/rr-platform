import type { VercelRequest, VercelResponse } from '@vercel/node';
import { firstString } from '@rr/http/http';
import {
  leerCotizacion, leerPago, marcarEstado, marcarPedidosPagados,
  reclamarAprobado, sumarRechazo, type PagoEnv,
} from './datos.js';
import { firmaValida } from './firma.js';
import { enviarTexto, invocarFunction } from './kapso.js';
import { MENSAJES } from './mensajes.js';
import { consultarPago } from './mercadopago.js';
import { armarPayloadEmision, reconstruirQuote } from './quote.js';

const REQUERIDAS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET', 'KAPSO_API_KEY'] as const;

export interface WebhookEnv extends PagoEnv {
  MP_ACCESS_TOKEN?: string;
  MP_WEBHOOK_SECRET?: string;
  KAPSO_API_KEY?: string;
}

export type Alertar = (asunto: string, detalle: string) => Promise<void>;

// Alerta interna por defecto: al log. La Task 9 la reemplaza por el correo.
const alertarPorDefecto: Alertar = async (asunto, detalle) => {
  console.error(`[pago] ALERTA ${asunto}`, { detalle });
};

/** Tipo y id de la notificacion, que Mercado Pago manda por query o por body. */
function leerNotificacion(req: VercelRequest): { tipo: string; dataId: string } {
  const q = req.query as Record<string, unknown>;
  const b = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, any>;
  return {
    tipo: String(firstString(q.type as any) ?? b.type ?? ''),
    dataId: String(firstString(q['data.id'] as any) ?? b?.data?.id ?? ''),
  };
}

export function createWebhookHandler(alertar: Alertar = alertarPorDefecto) {
  return async function handler(
    req: VercelRequest,
    res: VercelResponse,
    env: WebhookEnv = process.env as WebhookEnv,
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false });
      return;
    }
    if (REQUERIDAS.some((n) => !env[n])) {
      res.status(500).json({ ok: false, error: 'falta_configuracion' });
      return;
    }

    const { tipo, dataId } = leerNotificacion(req);
    // Solo pagos. Cualquier otro tipo se acusa recibo y se ignora, para que
    // Mercado Pago no lo reintente para siempre.
    if (tipo !== 'payment' || !dataId) {
      res.status(200).json({ ok: true, ignorado: true });
      return;
    }

    // La firma es lo unico que separa este endpoint publico de cualquiera que
    // sepa la URL. Va antes de tocar red o base de datos.
    const valida = firmaValida({
      dataId,
      requestId: firstString(req.headers['x-request-id']),
      header: firstString(req.headers['x-signature']),
      secret: env.MP_WEBHOOK_SECRET as string,
    });
    if (!valida) {
      console.error('[pago] webhook con firma invalida');
      res.status(401).json({ ok: false, error: 'firma_invalida' });
      return;
    }

    // El cuerpo del webhook NO decide nada: el monto y la referencia salen de
    // preguntarle a Mercado Pago.
    const pagoMP = await consultarPago(dataId, env.MP_ACCESS_TOKEN as string);
    if (!pagoMP) {
      res.status(500).json({ ok: false, error: 'mercadopago_no_responde' });
      return;
    }

    const quoteId = String(pagoMP.external_reference ?? '');
    if (!quoteId) {
      res.status(200).json({ ok: true, ignorado: true });
      return;
    }

    const fila = await leerPago(env, quoteId);
    if (fila === undefined) {
      res.status(500).json({ ok: false, error: 'upstream' });
      return;
    }
    if (fila === null) {
      // Un pago que no corresponde a ninguna fila nuestra. No es un error.
      res.status(200).json({ ok: true, ignorado: true });
      return;
    }
    if (String(fila.quote_id) !== quoteId) {
      // Salvaguarda de integridad: la fila que devolvio leerPago no
      // corresponde al quote_id que estamos procesando. En producción esto no
      // deberia pasar (leerPago ya filtra por quote_id), pero un pago
      // aprobado con este monto es dinero real: no se asume que la fila es
      // la correcta sin verificarlo, se trata igual que "no es nuestro".
      res.status(200).json({ ok: true, ignorado: true });
      return;
    }

    const avisar = (texto: string) => enviarTexto({
      telefono: fila.telefono ?? '',
      phoneNumberId: fila.phone_number_id ?? '',
      key: env.KAPSO_API_KEY as string,
      texto,
    });

    if (pagoMP.status === 'rejected') {
      // No cambia el estado: la fila sigue `pendiente` para que el siguiente
      // intento con el mismo link pueda reclamarla.
      await sumarRechazo(env, quoteId, String(pagoMP.id));
      await avisar(MENSAJES.rechazado);
      res.status(200).json({ ok: true, estado: 'rechazado' });
      return;
    }

    if (pagoMP.status !== 'approved') {
      res.status(200).json({ ok: true, estado: pagoMP.status });
      return;
    }

    // El monto tiene que ser exactamente el que cobramos. Un pago aprobado por
    // otra cifra es plata recibida contra un pedido que no cuadra: se congela.
    if (Number(pagoMP.transaction_amount) !== Number(fila.monto_clp)) {
      await marcarEstado(env, quoteId, 'aprobado_sin_emitir', { mp_payment_id: String(pagoMP.id) });
      await alertar(
        `Pago aprobado con monto que no calza (cotizacion ${quoteId})`,
        `Cobrado: ${fila.monto_clp}. Pagado: ${pagoMP.transaction_amount}. Pago MP: ${pagoMP.id}. No se emitio ninguna orden.`,
      );
      await avisar(MENSAJES.aprobadoSinEmitir);
      res.status(200).json({ ok: true, estado: 'aprobado_sin_emitir' });
      return;
    }

    // La transicion que sostiene la idempotencia: si otra entrega del mismo
    // webhook ya la tomo, aca se devuelven cero filas y no se emite de nuevo.
    if (!(await reclamarAprobado(env, quoteId, String(pagoMP.id)))) {
      res.status(200).json({ ok: true, estado: 'ya_procesado' });
      return;
    }

    const cotizacion = await leerCotizacion(env, quoteId);
    if (!cotizacion) {
      await marcarEstado(env, quoteId, 'aprobado_sin_emitir');
      await alertar(
        `Pago aprobado sin cotizacion legible (cotizacion ${quoteId})`,
        `Pago MP: ${pagoMP.id}. No se emitio ninguna orden.`,
      );
      await avisar(MENSAJES.aprobadoSinEmitir);
      res.status(200).json({ ok: true, estado: 'aprobado_sin_emitir' });
      return;
    }

    const emision = await invocarFunction(
      'emitir-ordenes-compra',
      armarPayloadEmision(reconstruirQuote(cotizacion), fila.datos ?? {}, fila.telefono ?? null),
      env.KAPSO_API_KEY as string,
    );
    const emitido = emision !== null
      && emision.status === 200
      && (emision.data as { ok?: boolean }).ok === true;

    if (!emitido) {
      // Incluye el 409 por vigencia vencida: el pago esta hecho y los precios
      // ya no valen. Lo resuelve una persona, con la plata ya recibida.
      const motivo = emision === null ? 'sin respuesta' : `status ${emision.status}`;
      await marcarEstado(env, quoteId, 'aprobado_sin_emitir');
      await alertar(
        `Pago aprobado que NO se pudo emitir (cotizacion ${quoteId})`,
        `Pago MP: ${pagoMP.id}. Monto: ${fila.monto_clp}. Emision: ${motivo}.`,
      );
      await avisar(MENSAJES.aprobadoSinEmitir);
      res.status(200).json({ ok: true, estado: 'aprobado_sin_emitir' });
      return;
    }

    await marcarEstado(env, quoteId, 'emitido', { emitido_at: new Date().toISOString() });
    // El pedido nace `nuevo` en emitir-ordenes-compra; acá ya está pagado.
    await marcarPedidosPagados(env, quoteId);
    await avisar(MENSAJES.emitido);
    res.status(200).json({ ok: true, estado: 'emitido' });
  };
}
