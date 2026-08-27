import { readFileSync } from 'node:fs';

export type Handler = (request: Request, env: Record<string, unknown>) => Promise<Response>;

// Las functions de Kapso se despliegan como `async function handler(request, env)`
// sin export. Cargarlas con new Function permite probar el MISMO archivo que se
// sube, en vez de una copia que se puede desincronizar.
export function cargarHandler(ruta: string): Handler {
  const codigo = readFileSync(ruta, 'utf8');
  return new Function(`${codigo}\nreturn handler;`)() as Handler;
}

export function peticion(cuerpo: unknown): Request {
  return new Request('https://kapso.test/fn', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(cuerpo),
  });
}
