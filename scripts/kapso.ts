const BASE = 'https://api.kapso.ai/platform/v1';

export interface Opciones {
  metodo?: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  cuerpo?: unknown;
}

export async function kapso<T = unknown>(ruta: string, opciones: Opciones = {}): Promise<T> {
  const clave = process.env.KAPSO_API_KEY;
  if (!clave) throw new Error('Falta KAPSO_API_KEY. Corre con `npm run kapso:functions`, que carga .env.local.');

  const respuesta = await fetch(`${BASE}${ruta}`, {
    method: opciones.metodo ?? 'GET',
    headers: { 'X-API-Key': clave, 'Content-Type': 'application/json' },
    body: opciones.cuerpo === undefined ? undefined : JSON.stringify(opciones.cuerpo),
  });

  const texto = await respuesta.text();
  if (!respuesta.ok) throw new Error(`${opciones.metodo ?? 'GET'} ${ruta} → ${respuesta.status}: ${texto.slice(0, 400)}`);
  return texto ? (JSON.parse(texto) as T) : (undefined as T);
}
