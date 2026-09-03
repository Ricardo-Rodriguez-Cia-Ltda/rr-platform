// Puente a la Platform API de Kapso: la tienda invoca las MISMAS functions
// que usa el workflow del bot, con un execution context sintetico. Los IDs
// se resuelven por nombre (sobreviven a un recreate de la function) y se
// cachean en memoria del proceso.
const BASE = 'https://api.kapso.ai/platform/v1';
const TIMEOUT_MS = 30000; // generar-cotizacion cotiza en vivo: puede tardar

const cacheIds = new Map<string, string>();

export function _limpiarCacheKapso(): void {
  cacheIds.clear();
}

/**
 * Log de fallos. NUNCA recibe la api key ni el payload: un pedido lleva
 * nombre, telefono y email del comprador, y los logs de Vercel los lee
 * cualquiera con acceso al proyecto. Solo function + tipo de fallo.
 */
function registrar(etapa: string, nombre: string, detalle: string): void {
  console.error(`[kapso] ${etapa} fallo`, { function: nombre, detalle });
}

function tipoDeFallo(error: unknown): string {
  if (error instanceof Error) return error.name === 'TimeoutError' ? 'timeout' : error.name;
  return 'desconocido';
}

async function idPorNombre(nombre: string, key: string, forzar: boolean = false): Promise<string | null> {
  if (!forzar) {
    const cacheado = cacheIds.get(nombre);
    if (cacheado) return cacheado;
  }
  try {
    const r = await fetch(`${BASE}/functions`, {
      headers: { 'X-API-Key': key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) {
      registrar('listado', nombre, `status ${r.status}`);
      return null;
    }
    const { data } = (await r.json()) as { data: Array<{ id: string; name: string }> };
    for (const f of data ?? []) cacheIds.set(f.name, f.id);
    const id = cacheIds.get(nombre) ?? null;
    if (!id) registrar('listado', nombre, 'la function no existe en el proyecto');
    return id;
  } catch (error) {
    registrar('listado', nombre, tipoDeFallo(error));
    return null;
  }
}

export async function invocarFunction(
  nombre: string,
  payload: unknown,
): Promise<{ status: number; data: Record<string, unknown> } | null> {
  const key = process.env.KAPSO_API_KEY;
  if (!key) {
    registrar('config', nombre, 'falta KAPSO_API_KEY');
    return null;
  }
  const id = await idPorNombre(nombre, key);
  if (!id) return null;
  try {
    const r = await fetch(`${BASE}/functions/${id}/invoke`, {
      method: 'POST',
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;

    // Si es 404, el id puede ser obsoleto: borra cache, re-resuelve y reintenta una sola vez
    if (r.status === 404) {
      registrar('invoke', nombre, 'status 404 (id obsoleto): re-resolviendo');
      cacheIds.delete(nombre);
      const nuevoId = await idPorNombre(nombre, key, true);
      if (nuevoId) {
        try {
          const r2 = await fetch(`${BASE}/functions/${nuevoId}/invoke`, {
            method: 'POST',
            headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(TIMEOUT_MS),
          });
          const data2 = (await r2.json().catch(() => ({}))) as Record<string, unknown>;
          if (r2.status >= 400) registrar('invoke (reintento)', nombre, `status ${r2.status}`);
          return { status: r2.status, data: data2 };
        } catch (error) {
          registrar('invoke (reintento)', nombre, tipoDeFallo(error));
          return null;
        }
      }
    }

    if (r.status >= 400) registrar('invoke', nombre, `status ${r.status}`);
    return { status: r.status, data };
  } catch (error) {
    registrar('invoke', nombre, tipoDeFallo(error));
    return null;
  }
}
