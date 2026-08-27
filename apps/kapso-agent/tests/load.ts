import { readFileSync } from 'node:fs';

export type Handler = (request: Request, env: Record<string, unknown>) => Promise<Response>;

// Las functions de Kapso se despliegan como `async function handler(request, env)`
// sin export. Cargarlas con new Function permite probar el MISMO archivo que se
// sube, en vez de una copia que se puede desincronizar.
export function loadHandler(path: string): Handler {
  const code = readFileSync(path, 'utf8');
  return new Function(`${code}\nreturn handler;`)() as Handler;
}

export function request(body: unknown): Request {
  return new Request('https://kapso.test/fn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}
