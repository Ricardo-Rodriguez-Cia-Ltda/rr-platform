// Acceso a Supabase (PostgREST) SIEMPRE server-side con la service_role.
// null/false = no se pudo (config faltante, red, status no-2xx): el caller
// muestra "no se pudo cargar", nunca revienta la pagina.
const TIMEOUT_MS = 8000;

function base(): { url: string; key: string } | null {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

export async function supabaseGet(path: string): Promise<unknown[] | null> {
  const cfg = base();
  if (!cfg) return null;
  try {
    const r = await fetch(`${cfg.url}/rest/v1${path}`, {
      headers: { apikey: cfg.key, Authorization: `Bearer ${cfg.key}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!r.ok) return null;
    return (await r.json()) as unknown[];
  } catch {
    return null;
  }
}

export async function supabasePatch(path: string, body: unknown): Promise<unknown[] | null> {
  const cfg = base();
  if (!cfg) return null;
  try {
    const r = await fetch(`${cfg.url}/rest/v1${path}`, {
      method: 'PATCH',
      headers: {
        apikey: cfg.key, Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json', Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return null;
    return (await r.json()) as unknown[];
  } catch {
    return null;
  }
}
