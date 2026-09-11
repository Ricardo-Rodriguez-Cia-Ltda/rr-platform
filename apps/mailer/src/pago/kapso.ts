// Puente a Kapso: invoca las MISMAS functions que usa el workflow del bot, con
// un execution context sintetico, y manda mensajes por el proxy Meta. Copia
// adaptada de apps/tienda/src/lib/kapso.ts; cuando la tienda cobre, las dos
// colapsan en una sola.
const BASE = 'https://api.kapso.ai/platform/v1';
const META = 'https://api.kapso.ai/meta/whatsapp/v24.0';
const TIMEOUT_MS = 30000;
const TIMEOUT_MSG_MS = 5000;

const cacheIds = new Map<string, string>();

export function _limpiarCacheKapso(): void {
  cacheIds.clear();
}

// NUNCA recibe la api key ni el payload: un pago lleva nombre, telefono y
// email, y los logs de Vercel los lee cualquiera con acceso al proyecto.
function registrar(etapa: string, nombre: string, detalle: string): void {
  console.error(`[pago/kapso] ${etapa} fallo`, { function: nombre, detalle });
}

function tipoDeFallo(error: unknown): string {
  if (error instanceof Error) return error.name === 'TimeoutError' ? 'timeout' : error.name;
  return 'desconocido';
}

async function idPorNombre(nombre: string, key: string): Promise<string | null> {
  const cacheado = cacheIds.get(nombre);
  if (cacheado) return cacheado;
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
  key: string,
): Promise<{ status: number; data: Record<string, unknown> } | null> {
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
    if (r.status >= 400) registrar('invoke', nombre, `status ${r.status}`);
    return { status: r.status, data };
  } catch (error) {
    registrar('invoke', nombre, tipoDeFallo(error));
    return null;
  }
}

async function enviarMensaje(
  telefono: string,
  phoneNumberId: string,
  key: string,
  mensaje: Record<string, unknown>,
): Promise<boolean> {
  // Sin destinatario no es un error: las invocaciones sinteticas y el canal de
  // prueba no traen telefono ni phone_number_id. Se devuelve false sin llamar.
  if (!telefono || !phoneNumberId || !key) return false;
  try {
    const r = await fetch(`${META}/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: { 'X-API-Key': key, 'Content-Type': 'application/json' },
      body: JSON.stringify({ messaging_product: 'whatsapp', to: telefono, ...mensaje }),
      signal: AbortSignal.timeout(TIMEOUT_MSG_MS),
    });
    if (!r.ok) registrar('mensaje', 'whatsapp', `status ${r.status}`);
    return r.ok;
  } catch (error) {
    registrar('mensaje', 'whatsapp', tipoDeFallo(error));
    return false;
  }
}

export function enviarTexto(p: {
  telefono: string; phoneNumberId: string; key: string; texto: string;
}): Promise<boolean> {
  return enviarMensaje(p.telefono, p.phoneNumberId, p.key, {
    type: 'text',
    text: { body: p.texto },
  });
}

export function enviarBotonPago(p: {
  telefono: string; phoneNumberId: string; key: string; texto: string; url: string; boton: string;
}): Promise<boolean> {
  return enviarMensaje(p.telefono, p.phoneNumberId, p.key, {
    type: 'interactive',
    interactive: {
      type: 'cta_url',
      body: { text: p.texto },
      action: { name: 'cta_url', parameters: { display_text: p.boton, url: p.url } },
    },
  });
}
