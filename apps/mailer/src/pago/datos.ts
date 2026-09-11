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

// null = no existe · undefined = no se pudo preguntar.
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
 */
export async function reclamarAprobado(env: PagoEnv, quoteId: string, mpPaymentId: string): Promise<boolean> {
  const filas = await pedir(
    env,
    'PATCH',
    `/pagos?quote_id=eq.${encodeURIComponent(quoteId)}&estado=eq.pendiente`,
    { estado: 'aprobado', mp_payment_id: mpPaymentId, aprobado_at: ahora(), updated_at: ahora() },
  );
  return filas !== null && filas.length > 0;
}

export async function marcarEstado(
  env: PagoEnv,
  quoteId: string,
  estado: PagoRow['estado'],
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const filas = await pedir(env, 'PATCH', `/pagos?quote_id=eq.${encodeURIComponent(quoteId)}`, {
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
