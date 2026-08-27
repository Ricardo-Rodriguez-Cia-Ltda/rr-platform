const BASE = 'https://api.kapso.ai/platform/v1';

export interface Options {
  method?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  body?: unknown;
}

export async function kapso<T = unknown>(path: string, options: Options = {}): Promise<T> {
  const apiKey = process.env.KAPSO_API_KEY;
  if (!apiKey) throw new Error('Falta KAPSO_API_KEY. Corre con `npm run kapso:functions`, que carga .env.local.');

  const response = await fetch(`${BASE}${path}`, {
    method: options.method ?? 'GET',
    headers: { 'X-API-Key': apiKey, 'Content-Type': 'application/json' },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });

  const text = await response.text();
  if (!response.ok) throw new Error(`${options.method ?? 'GET'} ${path} → ${response.status}: ${text.slice(0, 400)}`);
  return text ? (JSON.parse(text) as T) : (undefined as T);
}
