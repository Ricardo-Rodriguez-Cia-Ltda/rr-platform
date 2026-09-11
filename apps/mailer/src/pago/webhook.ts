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

/**
 * Ventana antiinundacion para las alertas de los retornos tempranos.
 *
 * Este endpoint es publico: la firma es lo unico que lo separa de cualquiera
 * que sepa la URL, asi que un 401 lo dispara quien quiera, a voluntad y en
 * bucle. Alertar por request convertiria la casilla del interno -- que es la
 * unica alarma del sistema -- en el blanco, y de paso enterraria las alertas
 * de plata que si importan.
 *
 * Diez minutos, y a proposito nada mas sofisticado:
 *
 * - Es mas largo que la rafaga de reintentos inmediatos de Mercado Pago, asi
 *   que un secreto mal cargado produce un correo, no ocho.
 * - Es lo bastante corto para que un fallo que dura horas siga apareciendo en
 *   la casilla en vez de avisar una sola vez y callarse para siempre. La
 *   alerta que se pierde es peor que la que se repite.
 * - Vive en memoria del proceso. En serverless cada instancia tiene la suya,
 *   asi que la ventana es best-effort: acota la inundacion por instancia, no
 *   globalmente. Alcanza -- el objetivo es no recibir miles de correos, no
 *   garantizar exactamente uno. Compartir estado para esto exigiria una
 *   escritura a Supabase en el camino de un request no autenticado, que es
 *   justo lo que un atacante quiere.
 *
 * Las claves son literales fijos ('firma_invalida', 'falta_configuracion'),
 * nunca datos del request: el Map queda acotado a dos entradas y no hay forma
 * de hacerlo crecer desde afuera. Las alertas de pagos -- que llevan el
 * quote_id y son la unica senal de que hay plata en el aire -- NO pasan por
 * aca: esas nunca se suprimen.
 */
export const VENTANA_ALERTAS_MS = 10 * 60_000;

const ultimaAlerta = new Map<string, number>();

export function _limpiarVentanaAlertas(): void {
  ultimaAlerta.clear();
}

function fueraDeVentana(clave: string): boolean {
  const ahora = Date.now();
  const previa = ultimaAlerta.get(clave);
  if (previa !== undefined && ahora - previa < VENTANA_ALERTAS_MS) return false;
  ultimaAlerta.set(clave, ahora);
  return true;
}

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
    const faltan = REQUERIDAS.filter((n) => !env[n]);
    if (faltan.length > 0) {
      // La respuesta publica NO las enumera -- a diferencia de
      // /api/pago/crear, que esta autenticado: decirle a cualquiera que sepa
      // la URL que variables le faltan al despliegue es una sonda gratis.
      // La alerta interna si las nombra, porque sin eso no sirve de nada.
      // Nunca sus valores.
      if (fueraDeVentana('falta_configuracion')) {
        await alertar(
          'El webhook de Mercado Pago esta mal configurado',
          `Faltan variables de entorno en el proyecto de Vercel: ${faltan.join(', ')}. `
          + `Mientras tanto ningun pago se esta procesando: Mercado Pago recibe 500, reintenta unas `
          + `veces y se rinde, y al cliente se le prometio que apenas se acredite el pago se le `
          + `confirma el pedido.`,
        );
      }
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
      // El modo de fallo mas probable del primer dia y el mas silencioso: si
      // `MP_WEBHOOK_SECRET` no es la clave de la seccion de webhooks del panel
      // de Mercado Pago, TODOS los pagos fallan con 401 y la unica senal era
      // un log que nadie mira.
      //
      // El texto es fijo a proposito: ni la firma, ni el secreto, ni el
      // cuerpo, ni el id del pago. Lo primero porque son credenciales; lo
      // ultimo porque viene de un request no autenticado y esta alerta se
      // archiva en una casilla de correo. Que sea constante ademas hace que
      // la ventana antiinundacion sea trivialmente correcta.
      if (fueraDeVentana('firma_invalida')) {
        await alertar(
          'Webhook de Mercado Pago rechazado por firma invalida',
          'Si esto se repite, la causa casi segura es que MP_WEBHOOK_SECRET en Vercel no es la clave '
          + 'secreta de la seccion Webhooks del panel de Mercado Pago (no se deriva de la preferencia). '
          + 'Mientras tanto ningun pago se esta acreditando y ningun cliente recibe confirmacion. '
          + 'Tambien puede ser trafico ajeno contra un endpoint publico: revisar el log antes de tocar nada.',
        );
      }
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
      // Cinturon, no el mecanismo: el camino normal es que leerPago ya
      // filtre por quote_id y esta rama nunca se ejercite -- una referencia
      // que no calza simplemente no trae fila (cae en el `fila === null` de
      // arriba). Esta comparacion cubre el caso en que, por lo que sea, ese
      // filtro no se haya aplicado y vuelva una fila de otra cotizacion: un
      // pago aprobado con el monto correcto sobre esa fila emitiria una
      // orden de compra real contra el pedido de otro cliente.
      res.status(200).json({ ok: true, ignorado: true });
      return;
    }

    const avisar = (texto: string) => enviarTexto({
      telefono: fila.telefono ?? '',
      phoneNumberId: fila.phone_number_id ?? '',
      key: env.KAPSO_API_KEY as string,
      texto,
    });

    // Entre la transicion atomica y esta escritura hay cuatro llamadas de red
    // y la emision entera. Si la escritura del desenlace falla, la fila queda
    // diciendo `aprobado` -- un estado sin salida: la reentrega de Mercado
    // Pago no vuelve a pasar la transicion condicional, y la emision ya corrio
    // en un Worker aparte, asi que lo mas probable es que las ordenes SI hayan
    // salido. Esta alerta es la unica senal de que eso paso.
    //
    // Solo alerta cuando la escritura fallo de verdad (`false`). Cero filas
    // afectadas porque el `desde` no calzo devuelve `true` y no alerta: eso es
    // "no correspondia escribir", una carrera benigna, no una fila colgada.
    const marcar = async (
      estado: 'emitido' | 'aprobado_sin_emitir',
      extra: Record<string, unknown> = {},
      desde: 'pendiente' | 'aprobado' = 'aprobado',
    ): Promise<void> => {
      if (await marcarEstado(env, quoteId, estado, extra, desde)) return;
      await alertar(
        `No se pudo escribir el estado del pago (cotizacion ${quoteId})`,
        `Estado que no se pudo escribir: ${estado}. La fila puede haber quedado colgada en 'aprobado' `
        + `mientras la emision si corrio. Revisar la fila de pagos y el correo de ordenes de compra a mano.`,
      );
    };

    // Mercado Pago reenvia habitualmente mas de una notificacion por el
    // mismo pago (una al crearse, otra al actualizarse), ambas con firma
    // valida y el mismo id de pago. Sin este guard, las ramas de rechazado y
    // de monto que no calza -- que corren ANTES de la transicion atomica y
    // por lo tanto no estan protegidas por ella -- mandarian el aviso o la
    // alerta una vez por cada reentrega.
    //
    // No suprime un rechazo genuino posterior: si el cliente reintenta con
    // el mismo link, Mercado Pago crea un pago NUEVO con id distinto, asi
    // que este guard no se activa y el cliente recibe su aviso.
    //
    // El camino aprobado con monto correcto no usa este guard: ya tiene su
    // propia proteccion en la transicion atomica de reclamarAprobado (mas
    // abajo), que es la que decide si esta entrega ya se tomo.
    const yaProcesado = fila.mp_payment_id != null && String(fila.mp_payment_id) === String(pagoMP.id);

    if (pagoMP.status === 'rejected') {
      if (yaProcesado) {
        res.status(200).json({ ok: true, estado: 'rechazado', duplicado: true });
        return;
      }
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
      if (yaProcesado) {
        res.status(200).json({ ok: true, estado: 'aprobado_sin_emitir', duplicado: true });
        return;
      }
      // Desde `pendiente`, no desde cualquier cosa: un segundo pago por el
      // monto equivocado sobre una fila que ya esta `emitido` por un pago
      // anterior legitimo no puede degradarla, porque eso borraria el registro
      // de que las ordenes si salieron. Si la fila ya no esta pendiente, el
      // PATCH no toca nada -- pero la alerta de abajo sale igual, que es lo
      // que hace falta: hay plata recibida que no cuadra.
      await marcar('aprobado_sin_emitir', { mp_payment_id: String(pagoMP.id) }, 'pendiente');
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
      // Una sola lectura del estado: `fila`, leida arriba. Dos cosas
      // distintas llegan hasta aca y las dos eran mudas.
      //
      // (a) La fila sigue en `aprobado`: alguien la reclamo y nunca escribio
      //     el desenlace -- el proceso murio entre medio. Como la emision
      //     corre en un Worker aparte, lo mas probable es que las ordenes de
      //     compra ya hayan salido: hay un mayorista despachando, un cliente
      //     que pago sin saber nada, y una fila que miente. No se deduplica
      //     por reentrega a proposito: es el unico aviso que existe y un
      //     correo repetido es mucho mas barato que ninguno.
      //
      // (b) El id del pago no es el que la fila tiene registrado: Checkout
      //     Pro no impide que una preferencia se pague dos veces, y el
      //     mensaje de rechazo invita literalmente a reintentar con el mismo
      //     link. Un segundo pago trae id distinto y monto correcto, asi que
      //     pasa el guard de duplicado y el chequeo de monto y muere aca.
      //     Es plata cobrada dos veces y alguien tiene que devolverla.
      //
      // Pueden ser ciertas las dos a la vez, y entonces salen las dos: son
      // dos hechos distintos con dos acciones distintas.
      if (fila.estado === 'aprobado') {
        await alertar(
          `Pago atascado entre la reclamacion y el desenlace (cotizacion ${quoteId})`,
          `La fila sigue en 'aprobado' y la reentrega ya no puede reclamarla. Es probable que las ordenes `
          + `de compra SI se hayan emitido y que el cliente no haya recibido confirmacion. Revisar la fila `
          + `de pagos, el correo de ordenes de compra y avisarle al cliente a mano.`,
        );
      }
      if (fila.mp_payment_id != null && String(fila.mp_payment_id) !== String(pagoMP.id)) {
        await alertar(
          `Segundo pago aprobado sobre la misma cotizacion (${quoteId})`,
          `La fila ya tenia registrado el pago ${fila.mp_payment_id} y llego el pago ${pagoMP.id} por el `
          + `mismo monto. Checkout Pro permite pagar dos veces la misma preferencia: hay un cobro de mas `
          + `que hay que devolver. No se emitio nada por segunda vez.`,
        );
      }
      res.status(200).json({ ok: true, estado: 'ya_procesado' });
      return;
    }

    const cotizacion = await leerCotizacion(env, quoteId);
    if (!cotizacion) {
      await marcar('aprobado_sin_emitir');
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
      await marcar('aprobado_sin_emitir');
      await alertar(
        `Pago aprobado que NO se pudo emitir (cotizacion ${quoteId})`,
        `Pago MP: ${pagoMP.id}. Monto: ${fila.monto_clp}. Emision: ${motivo}.`,
      );
      await avisar(MENSAJES.aprobadoSinEmitir);
      res.status(200).json({ ok: true, estado: 'aprobado_sin_emitir' });
      return;
    }

    await marcar('emitido', { emitido_at: new Date().toISOString() });
    // El pedido nace `nuevo` en emitir-ordenes-compra; acá ya está pagado.
    // Si esa escritura falla en silencio, el backoffice muestra como
    // pendiente de cobro un pedido que ya se pago: nadie lo nota hasta que
    // alguien va a cobrarlo por segunda vez.
    if (!(await marcarPedidosPagados(env, quoteId))) {
      await alertar(
        `No se pudieron marcar los pedidos como pagados (cotizacion ${quoteId})`,
        `El pago quedo en 'emitido' y las ordenes de compra salieron, pero los pedidos siguen en 'nuevo' `
        + `en el backoffice. Moverlos a 'pagado' a mano para que nadie los cobre de nuevo.`,
      );
    }
    await avisar(MENSAJES.emitido);
    res.status(200).json({ ok: true, estado: 'emitido' });
  };
}
