const TIMEOUT_MS = 8000;

export interface PagoEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
}

export interface CotizacionRow {
  quote_id: string;
  version: string;
  numero?: number | null;
  telefono?: string | null;
  total_clp: number;
  valida_hasta: string;
  lineas: unknown[];
  proveedores_incompletos?: unknown[] | null;
}

export interface PagoRow {
  quote_id: string;
  quote_version: string;
  numero?: number | null;
  telefono?: string | null;
  phone_number_id?: string | null;
  preference_id: string;
  init_point: string;
  monto_clp: number;
  expira_at: string;
  estado: 'pendiente' | 'aprobado' | 'emitido' | 'aprobado_sin_emitir';
  // Lo escribe `reclamarAprobado` al tomar la fila. Es lo que le permite al
  // webhook distinguir una emision en vuelo de una fila realmente atascada.
  aprobado_at?: string | null;
  mp_payment_id?: string | null;
  intentos_rechazados?: number;
  datos: Record<string, unknown>;
}

function registrar(etapa: string, detalle: string): void {
  console.error(`[pago/datos] ${etapa} fallo`, { detalle });
}

// Devuelve null cuando la llamada fallo, para que el caller distinga "no se
// pudo preguntar" de "la respuesta vino vacia".
async function pedir(
  env: PagoEnv,
  metodo: string,
  path: string,
  cuerpo?: unknown,
  prefer?: string,
): Promise<unknown[] | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;
  const base = env.SUPABASE_URL.replace(/\/+$/, '');
  try {
    const r = await fetch(`${base}/rest/v1${path}`, {
      method: metodo,
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: prefer ?? 'return=representation',
      },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) {
      registrar(`${metodo} ${path.split('?')[0]}`, `status ${r.status}`);
      return null;
    }
    const texto = await r.text();
    if (!texto) return [];
    try {
      const data = JSON.parse(texto);
      return Array.isArray(data) ? data : [data];
    } catch {
      return [];
    }
  } catch (error) {
    registrar(`${metodo} ${path.split('?')[0]}`, error instanceof Error ? error.name : 'desconocido');
    return null;
  }
}

const ahora = () => new Date().toISOString();

/**
 * Devuelve null = no existe · undefined = no se pudo preguntar.
 *
 * Nota: `cotizaciones` tiene llave primaria compuesta (quote_id, version), pero esta
 * función consulta solo por quote_id sin filtro ni orden de versión, trayendo la
 * primera fila. Hoy es correcto porque generar-cotizacion-v2 genera un quote_id UUID
 * fresco en cada cotización, así que hay exactamente uno por quote_id. Si en el
 * futuro una re-cotización reutilizara quote_id, este limit=1 podría traer una
 * versión distinta de la que se cobró, emitiendo compras con líneas equivocadas.
 * Revisar cuando se implemente re-cotización.
 */
export async function leerCotizacion(env: PagoEnv, quoteId: string): Promise<CotizacionRow | null | undefined> {
  const filas = await pedir(env, 'GET', `/cotizaciones?quote_id=eq.${encodeURIComponent(quoteId)}&limit=1`);
  if (filas === null) return undefined;
  return (filas[0] as CotizacionRow | undefined) ?? null;
}

export async function leerPago(env: PagoEnv, quoteId: string): Promise<PagoRow | null | undefined> {
  const filas = await pedir(env, 'GET', `/pagos?quote_id=eq.${encodeURIComponent(quoteId)}&limit=1`);
  if (filas === null) return undefined;
  return (filas[0] as PagoRow | undefined) ?? null;
}

export async function crearPago(env: PagoEnv, fila: PagoRow): Promise<boolean> {
  return (await pedir(env, 'POST', '/pagos', fila)) !== null;
}

/**
 * La transicion que sostiene toda la idempotencia del webhook: el PATCH va
 * condicionado a `estado=eq.pendiente`, asi que la segunda entrega de la misma
 * notificacion devuelve cero filas y no emite nada. Mismo patron condicional
 * que apps/backoffice/app/api/pedidos/transicion/route.ts.
 *
 * Tri-estado, la misma convencion que `leerCotizacion` mas arriba:
 *
 * - `true`  = esta entrega tomo la fila y le toca emitir.
 * - `false` = habia cero filas que tomar: otra entrega gano la carrera. Es
 *             idempotencia funcionando, no un error.
 * - `undefined` = no se pudo preguntar (5xx de Supabase, timeout, red caida).
 *             No se sabe nada del estado de la fila.
 *
 * Devolver `false` para el tercer caso, como se hacia antes, se leia en el
 * webhook como "otra entrega ya la tomo": se respondia 200, Mercado Pago
 * dejaba de reintentar, y un solo error transitorio de la base bastaba para
 * dejar el pago cobrado, sin ordenes emitidas y sin una sola alerta. El
 * llamador NO puede confundirlos.
 */
export async function reclamarAprobado(
  env: PagoEnv,
  quoteId: string,
  mpPaymentId: string,
): Promise<boolean | undefined> {
  const filas = await pedir(
    env,
    'PATCH',
    `/pagos?quote_id=eq.${encodeURIComponent(quoteId)}&estado=eq.pendiente`,
    { estado: 'aprobado', mp_payment_id: mpPaymentId, aprobado_at: ahora(), updated_at: ahora() },
  );
  if (filas === null) return undefined;
  return filas.length > 0;
}

/**
 * `desde` es el estado desde el que se permite la transicion. Sin el, el PATCH
 * va solo por quote_id y pisa la fila este como este: asi, la rama de monto
 * que no calza podia degradar a `aprobado_sin_emitir` una fila que ya estaba
 * `emitido` por un pago anterior legitimo, borrando el registro de que las
 * ordenes si salieron. Los llamadores que transicionan desde un estado
 * conocido lo pasan; queda opcional para no tocar a los que no lo necesitan.
 *
 * El valor de retorno significa **"la escritura no fallo"**, no "la fila
 * cambio": cero filas afectadas (el `desde` no calzo) devuelve `true`. La
 * distincion importa porque webhook.ts alerta al interno cuando esto devuelve
 * `false` -- una fila que quedo colgada sin desenlace. Una transicion que
 * legitimamente no correspondia no es eso, y confundirlas convertiria cada
 * carrera benigna en una falsa alarma.
 */
export async function marcarEstado(
  env: PagoEnv,
  quoteId: string,
  estado: PagoRow['estado'],
  extra: Record<string, unknown> = {},
  desde?: PagoRow['estado'],
): Promise<boolean> {
  const condicion = desde ? `&estado=eq.${encodeURIComponent(desde)}` : '';
  const filas = await pedir(env, 'PATCH', `/pagos?quote_id=eq.${encodeURIComponent(quoteId)}${condicion}`, {
    estado, updated_at: ahora(), ...extra,
  });
  return filas !== null;
}

/**
 * Un rechazo NO cambia el estado: la fila sigue `pendiente` para que el
 * siguiente intento con el mismo link pueda reclamarla.
 */
export async function sumarRechazo(env: PagoEnv, quoteId: string, mpPaymentId: string): Promise<boolean> {
  const actual = await leerPago(env, quoteId);
  if (!actual) return false;
  const filas = await pedir(env, 'PATCH', `/pagos?quote_id=eq.${encodeURIComponent(quoteId)}`, {
    intentos_rechazados: Number(actual.intentos_rechazados ?? 0) + 1,
    mp_payment_id: mpPaymentId,
    updated_at: ahora(),
  });
  return filas !== null;
}

// Solo los que siguen en `nuevo`: si un humano ya los movio a entregado o
// anulado desde el backoffice, esta escritura no lo pisa.
export async function marcarPedidosPagados(env: PagoEnv, quoteId: string): Promise<boolean> {
  const filas = await pedir(
    env,
    'PATCH',
    `/pedidos?quote_id=eq.${encodeURIComponent(quoteId)}&estado_negocio=eq.nuevo`,
    { estado_negocio: 'pagado', pagado_at: ahora() },
  );
  return filas !== null;
}

/**
 * Las filas que el barrido periodico llama atascadas: en `aprobado` desde hace
 * mas del umbral, o en `aprobado` sin marca de reclamacion (que el webhook ya
 * trata como atascada, porque `reclamarAprobado` siempre la escribe). Mismo
 * criterio que `emisionYaNoPuedeEstarEnVuelo` en webhook.ts, expresado en
 * PostgREST para no traer la tabla entera.
 *
 * `null` = no se pudo preguntar; `[]` = no hay atascadas.
 */
// Tope de filas por barrido. Si se alcanza, el barrido avisa que hay mas: en
// una falla sistemica (muchas filas atascadas a la vez) es justo cuando no se
// puede subestimar. Las filas sin marca van primero porque son la anomalia mas
// grave y no deben ser las que queden fuera de la pagina.
export const TOPE_BARRIDO = 100;

export async function listarAprobadasViejas(env: PagoEnv, limiteMs: number): Promise<PagoRow[] | null> {
  const corte = new Date(limiteMs).toISOString();
  const filtro = `or=(aprobado_at.is.null,aprobado_at.lt.${encodeURIComponent(corte)})`;
  const filas = await pedir(
    env, 'GET',
    `/pagos?estado=eq.aprobado&${filtro}&order=aprobado_at.asc.nullsfirst&limit=${TOPE_BARRIDO}`,
  );
  return filas === null ? null : (filas as PagoRow[]);
}
