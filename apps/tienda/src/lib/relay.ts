// Puente al servicio de pagos del rele (apps/mailer, rutas api/pago/*). La
// tienda le pide el link de pago con el mismo endpoint que usa el bot; la
// diferencia es `origen: 'tienda'` en el cuerpo (ver pedido.ts).
const TIMEOUT_MS = 15000; // crear = leer cotizacion + preferencia en MP + insertar fila

/**
 * Log de fallos. NUNCA recibe la api key ni el cuerpo: lleva nombre, telefono
 * y email del comprador, y los logs de Vercel los lee cualquiera con acceso
 * al proyecto. Solo etapa + tipo de fallo.
 */
function registrar(etapa: string, detalle: string): void {
  console.error(`[relay] ${etapa} fallo`, { detalle });
}

function tipoDeFallo(error: unknown): string {
  if (error instanceof Error) return error.name === 'TimeoutError' ? 'timeout' : error.name;
  return 'desconocido';
}

export async function crearPago(
  cuerpo: unknown,
): Promise<{ status: number; data: Record<string, unknown> } | null> {
  const base = process.env.MAILER_URL;
  const key = process.env.MAILER_API_KEY;
  if (!base || !key) {
    registrar('config', 'falta MAILER_URL o MAILER_API_KEY');
    return null;
  }
  try {
    const r = await fetch(`${base.replace(/\/+$/, '')}/api/pago/crear`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    // El codigo de error del rele (sin_vigencia, falta_configuracion...) es
    // un literal fijo, no un dato del cliente: se puede registrar.
    if (r.status >= 400) registrar('crear', `status ${r.status} ${String(data.error ?? '')}`.trim());
    return { status: r.status, data };
  } catch (error) {
    registrar('crear', tipoDeFallo(error));
    return null;
  }
}
