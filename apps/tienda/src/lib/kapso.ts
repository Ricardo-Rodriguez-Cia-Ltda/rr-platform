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
    if (!r.ok) return null;
    const { data } = (await r.json()) as { data: Array<{ id: string; name: string }> };
    for (const f of data ?? []) cacheIds.set(f.name, f.id);
    return cacheIds.get(nombre) ?? null;
  } catch {
    return null;
  }
}

export async function invocarFunction(
  nombre: string,
  payload: unknown,
): Promise<{ status: number; data: Record<string, unknown> } | null> {
  const key = process.env.KAPSO_API_KEY;
  if (!key) return null;
  let id = await idPorNombre(nombre, key);
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
      cacheIds.delete(nombre);
      const nuevoId = await idPorNombre(nombre, key, true);
      if (nuevoId) {
        const r2 = await fetch(`${BASE}/functions/${nuevoId}/invoke`, {
          method: 'POST',
          headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
          signal: AbortSignal.timeout(TIMEOUT_MS),
        });
        const data2 = (await r2.json().catch(() => ({}))) as Record<string, unknown>;
        return { status: r2.status, data: data2 };
      }
    }

    return { status: r.status, data };
  } catch {
    return null;
  }
}
