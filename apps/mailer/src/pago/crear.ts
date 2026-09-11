import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '@rr/http/auth';
import { firstString } from '@rr/http/http';
import { crearPago, leerCotizacion, leerPago, type PagoEnv, type PagoRow } from './datos.js';
import { enviarBotonPago, enviarTexto } from './kapso.js';
import { MENSAJES, formatearClp } from './mensajes.js';
import { construirPreferencia, crearPreferencia } from './mercadopago.js';
import { vigenciaUtil } from './quote.js';

const REQUERIDAS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'MAILER_API_KEY', 'MP_ACCESS_TOKEN', 'PAGO_BASE_URL', 'KAPSO_API_KEY'] as const;

export interface CrearEnv extends PagoEnv {
  MAILER_API_KEY?: string;
  MP_ACCESS_TOKEN?: string;
  PAGO_BASE_URL?: string;
  KAPSO_API_KEY?: string;
}

const BILLING = [
  'billing_rut', 'billing_razon_social', 'billing_giro', 'billing_direccion',
  'billing_comuna', 'billing_ciudad', 'billing_email',
] as const;

interface Entrada {
  quoteId: string;
  quoteVersion: string;
  telefono: string;
  phoneNumberId: string;
  datos: Record<string, unknown>;
  email: string;
  nombre: string;
}

// El nodo `webhook` de Kapso rellena plantillas {{vars.xxx}} en el cuerpo que
// manda. Si una variable nunca se escribio durante la conversacion, Kapso
// puede entregar el literal sin renderizar en vez de una cadena vacia. Un
// valor asi no es un dato real: es un placeholder roto que, sin sanear, puede
// llegar a un lugar que lo muestra a una persona -- el PDF de la orden de
// compra via `datos`, o la pagina de pago de Mercado Pago via el nombre del
// pagador. Por eso se trata igual que un valor vacio, y el saneo ocurre UNA
// sola vez, al leer cada campo (ver `leerTexto`): todo lo que corre aguas
// abajo hereda el valor ya sano, sin repetir el guard en cada punto de uso.
// No "limpiar" esto: el origen del riesgo es el webhook de Kapso, no un bug
// de formato.
function esPlantillaSinRenderizar(valor: string): boolean {
  return valor.startsWith('{{') && valor.endsWith('}}');
}

// Lee y recorta un campo de texto del cuerpo; si el resultado esta vacio o
// parece una plantilla de Kapso sin renderizar, devuelve `porDefecto`.
function leerTexto(valor: unknown, porDefecto = ''): string {
  const texto = String(valor ?? '').trim();
  return texto && !esPlantillaSinRenderizar(texto) ? texto : porDefecto;
}

function leerEntrada(body: unknown): Entrada | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const quoteId = leerTexto(b.quote_id);
  if (!quoteId) return null;

  const datos: Record<string, unknown> = {};
  const nombre = leerTexto(b.customer_name);
  if (nombre) datos.quote_customer_name = nombre;
  for (const campo of BILLING) {
    const valor = leerTexto(b[campo]);
    if (valor) datos[campo] = valor;
  }

  return {
    quoteId,
    quoteVersion: leerTexto(b.quote_version, '1'),
    // El digit-strip de mas abajo ya diluye casi cualquier plantilla sin
    // renderizar (no trae digitos), pero se sanea primero de todos modos:
    // es el mismo campo que decide si `enviarBotonPago`/`enviarTexto`
    // encuentran destinatario, y no debe depender de esa coincidencia.
    telefono: leerTexto(b.phone_number).replace(/\D/g, ''),
    // Si llega sin renderizar, cae a cadena vacia: `enviarMensaje` en
    // kapso.ts ya trata phoneNumberId vacio como "no hay a quien mandarle" y
    // no intenta la llamada, en vez de pegarle a la API de Meta con un id
    // literal como "{{vars.phone_number_id}}".
    phoneNumberId: leerTexto(b.phone_number_id),
    datos,
    // `datos.billing_email` ya paso por el mismo saneo en el loop de arriba;
    // se reusa en vez de releer el campo crudo una segunda vez.
    email: typeof datos.billing_email === 'string' ? datos.billing_email : 'sin-email@drcomputacion.cl',
    nombre: nombre || 'Cliente',
  };
}

export function createCrearHandler() {
  return async function handler(
    req: VercelRequest,
    res: VercelResponse,
    env: CrearEnv = process.env as CrearEnv,
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'metodo_no_permitido' });
      return;
    }
    if (!isAuthorized(firstString(req.headers['x-api-key']), env.MAILER_API_KEY)) {
      res.status(401).json({ ok: false, error: 'no_autorizado' });
      return;
    }

    const entrada = leerEntrada(req.body);
    if (!entrada) {
      res.status(400).json({ ok: false, error: 'cuerpo_invalido' });
      return;
    }

    // Se nombran las que faltan; nunca sus valores.
    const faltan = REQUERIDAS.filter((n) => !env[n]);
    if (faltan.length > 0) {
      res.status(503).json({ ok: false, error: 'falta_configuracion', faltan });
      return;
    }

    const avisar = (texto: string) => enviarTexto({
      telefono: entrada.telefono,
      phoneNumberId: entrada.phoneNumberId,
      key: env.KAPSO_API_KEY as string,
      texto,
    });

    // Idempotencia: una segunda llamada por la misma cotizacion devuelve el
    // link que ya existe en vez de crear otra preferencia. La llave primaria
    // de `pagos` es el quote_id justamente para esto.
    const yaExiste = await leerPago(env, entrada.quoteId);
    if (yaExiste === undefined) {
      res.status(503).json({ ok: false, error: 'upstream' });
      return;
    }
    if (yaExiste) {
      res.status(200).json({ ok: true, estado: yaExiste.estado, init_point: yaExiste.init_point });
      return;
    }

    const cotizacion = await leerCotizacion(env, entrada.quoteId);
    if (cotizacion === undefined) {
      res.status(503).json({ ok: false, error: 'upstream' });
      return;
    }
    if (cotizacion === null) {
      res.status(404).json({ ok: false, error: 'cotizacion_no_encontrada' });
      return;
    }

    // Por debajo del margen el link nace condenado: se aprobaria el pago y
    // emitir-ordenes-compra lo rechazaria por vigencia. Mejor no mandarlo.
    if (!vigenciaUtil(cotizacion.valida_hasta, Date.now())) {
      await avisar(MENSAJES.sinVigencia);
      res.status(409).json({ ok: false, error: 'sin_vigencia' });
      return;
    }

    const montoClp = Number(cotizacion.total_clp);
    if (!Number.isFinite(montoClp) || montoClp <= 0) {
      await avisar(MENSAJES.sinLink);
      res.status(422).json({ ok: false, error: 'monto_invalido' });
      return;
    }

    const preferencia = await crearPreferencia(
      construirPreferencia({
        quoteId: entrada.quoteId,
        numero: cotizacion.numero ?? null,
        montoClp,
        nombre: entrada.nombre,
        email: entrada.email,
        baseUrl: env.PAGO_BASE_URL as string,
        validUntil: cotizacion.valida_hasta,
      }),
      env.MP_ACCESS_TOKEN as string,
      entrada.quoteId,
    );
    if (!preferencia) {
      await avisar(MENSAJES.sinLink);
      res.status(502).json({ ok: false, error: 'mercadopago_no_responde' });
      return;
    }

    const fila: PagoRow = {
      quote_id: entrada.quoteId,
      quote_version: String(cotizacion.version ?? entrada.quoteVersion),
      numero: cotizacion.numero ?? null,
      telefono: entrada.telefono || cotizacion.telefono || null,
      phone_number_id: entrada.phoneNumberId || null,
      preference_id: preferencia.id,
      init_point: preferencia.init_point,
      monto_clp: montoClp,
      expira_at: cotizacion.valida_hasta,
      estado: 'pendiente',
      datos: entrada.datos,
    };
    if (!(await crearPago(env, fila))) {
      // La preferencia existe en Mercado Pago pero no tenemos donde anotarla:
      // sin fila, el webhook no sabria que emitir. No se manda el link.
      await avisar(MENSAJES.sinLink);
      res.status(503).json({ ok: false, error: 'no_se_pudo_registrar' });
      return;
    }

    await enviarBotonPago({
      telefono: fila.telefono ?? '',
      phoneNumberId: entrada.phoneNumberId,
      key: env.KAPSO_API_KEY as string,
      texto: MENSAJES.linkCreado(formatearClp(montoClp)),
      url: preferencia.init_point,
      boton: 'Pagar',
    });

    res.status(200).json({ ok: true, estado: 'pendiente', init_point: preferencia.init_point });
  };
}
