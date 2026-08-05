# Local Server + Cloudflare Tunnel — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Servir el handler existente `api/price.ts` desde un PC de la oficina con un mini servidor `node:http`, listo para exponerse vía Cloudflare Tunnel.

**Architecture:** `lib/server.ts` exporta `createApp()` (un `http.Server` que adapta req/res de Node al handler con firma Vercel); `server.ts` en la raíz lo instancia y escucha en `HOST:PORT`. El handler, providers y deploy de Vercel no se tocan.

**Tech Stack:** Node 20+ `node:http`, TypeScript strict ESM (NodeNext — imports relativos CON extensión `.js`), vitest, tsx. Sin dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-08-05-local-hosting-tunnel-design.md`

## Global Constraints

- Sin dependencias de producción nuevas.
- Imports relativos SIEMPRE con extensión `.js` (tsconfig NodeNext los exige; el runtime ESM de Vercel también).
- Secretos solo por env; nunca en logs (el log de arranque solo dice host/puerto).
- Formato de error uniforme `{ "error": "...", "detail": "..." }`.
- Bind por defecto `127.0.0.1` (solo cloudflared local alcanza el servidor).

---

### Task 1: Adaptador HTTP `createApp` + `server.ts` + script `serve`

**Files:**
- Create: `lib/server.ts`
- Create: `server.ts`
- Modify: `package.json` (agregar script `serve`)
- Test: `tests/server.test.ts`

**Interfaces:**
- Consumes: `default export handler(req: VercelRequest, res: VercelResponse)` de `api/price.ts` (ya existe; valida x-api-key, método y parámetros).
- Produces: `createApp(): import('node:http').Server` en `lib/server.ts`; entrypoint `server.ts` que escucha en `HOST` (default `127.0.0.1`) y `PORT` (default `3000`); script npm `serve`.

- [ ] **Step 1: Escribir tests que fallan (`tests/server.test.ts`)**

```ts
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AddressInfo } from 'node:net';
import type { Server } from 'node:http';

const getPriceMock = vi.fn();

vi.mock('../lib/providers/intcomex.js', () => ({
  intcomex: {
    name: 'intcomex',
    getPrice: (query: unknown) => getPriceMock(query),
  },
}));

const { createApp } = await import('../lib/server.js');

const RESULT = {
  provider: 'intcomex',
  sku: 'SE001MSE01',
  mpn: 'AAA-01148',
  description: 'Microsoft Access 2013',
  price: 103.5294,
  currency: 'US',
  inStock: 203,
};

let server: Server;
let base: string;

beforeAll(async () => {
  server = createApp();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
});

afterAll(async () => {
  await new Promise((resolve) => server.close(resolve));
});

describe('local server adapter', () => {
  beforeEach(() => {
    vi.stubEnv('API_SECRET_KEY', 'test-secret');
    getPriceMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('serves GET /api/price end-to-end with query and key', async () => {
    getPriceMock.mockResolvedValue(RESULT);
    const res = await fetch(`${base}/api/price?mpn=AAA-01148`, {
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(await res.json()).toEqual(RESULT);
    expect(getPriceMock).toHaveBeenCalledWith({ sku: undefined, mpn: 'AAA-01148', upc: undefined });
  });

  it('returns 401 without x-api-key (handler auth reached)', async () => {
    const res = await fetch(`${base}/api/price?sku=X`);
    expect(res.status).toBe(401);
    expect(await res.json()).toMatchObject({ error: 'unauthorized' });
  });

  it('returns 404 for unknown routes', async () => {
    const res = await fetch(`${base}/otra-cosa`);
    expect(res.status).toBe(404);
    expect(await res.json()).toMatchObject({ error: 'not_found' });
  });

  it('returns 405 for POST (handler method guard reached)', async () => {
    const res = await fetch(`${base}/api/price?sku=X`, {
      method: 'POST',
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.status).toBe(405);
  });

  it('takes the first value of repeated query params', async () => {
    getPriceMock.mockResolvedValue(RESULT);
    const res = await fetch(`${base}/api/price?sku=PRIMERO&sku=SEGUNDO`, {
      headers: { 'x-api-key': 'test-secret' },
    });
    expect(res.status).toBe(200);
    expect(getPriceMock).toHaveBeenCalledWith({ sku: 'PRIMERO', mpn: undefined, upc: undefined });
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — no existe `lib/server.ts`.

- [ ] **Step 3: Implementar `lib/server.ts`**

```ts
import { createServer, type Server } from 'node:http';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import handler from '../api/price.js';

export function createApp(): Server {
  return createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', `http://${req.headers.host ?? 'localhost'}`);

    const vres = res as unknown as VercelResponse;
    vres.status = (code: number) => {
      res.statusCode = code;
      return vres;
    };
    vres.json = (payload: unknown) => {
      res.setHeader('content-type', 'application/json; charset=utf-8');
      res.end(JSON.stringify(payload));
      return vres;
    };

    if (url.pathname !== '/api/price') {
      vres.status(404).json({ error: 'not_found', detail: 'Unknown route' });
      return;
    }

    const query: Record<string, string> = {};
    for (const [key, value] of url.searchParams) {
      if (!(key in query)) query[key] = value;
    }
    (req as unknown as VercelRequest).query = query;

    try {
      await handler(req as unknown as VercelRequest, vres);
    } catch {
      if (!res.headersSent) {
        vres.status(500).json({ error: 'internal', detail: 'Unexpected server error' });
      }
    }
  });
}
```

- [ ] **Step 4: Implementar `server.ts` (raíz)**

```ts
import { createApp } from './lib/server.js';

const port = Number(process.env.PORT ?? 3000);
const host = process.env.HOST ?? '127.0.0.1';

createApp().listen(port, host, () => {
  console.log(`price-fetcher API listening on http://${host}:${port}`);
});
```

- [ ] **Step 5: Agregar el script `serve` a `package.json`** (junto a los scripts existentes)

```json
"serve": "tsx --env-file=.env.local server.ts"
```

- [ ] **Step 6: Verificar que pasan**

Run: `npx vitest run tests/server.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 7: Suite completa + typecheck**

Run: `npm test` y `npm run typecheck`
Expected: 31 tests PASS, typecheck exit 0.

- [ ] **Step 8: Commit**

```bash
git add lib/server.ts server.ts package.json tests/server.test.ts
git commit -m "feat: add local HTTP server wrapping the Vercel handler"
```

---

### Task 2: Documentación de operación (túnel + autoarranque) y smoke manual

**Files:**
- Modify: `README.md` (nueva sección al final, antes de la línea "Referencia IWS")

**Interfaces:**
- Consumes: script `serve` (Task 1).
- Produces: README con la guía completa de hosting local.

- [ ] **Step 1: Smoke manual del servidor** (requiere `.env.local`; si no existe, saltar y anotar)

Run (en una terminal): `npm run serve`
Run (en otra): `curl -s -H "x-api-key: <API_SECRET_KEY>" "http://127.0.0.1:3000/api/price?sku=MT027DEL20"`
Expected: JSON con `price` numérico. Detener el servidor después.

- [ ] **Step 2: Agregar al `README.md`** (antes de la sección "Referencia IWS", texto exacto; reemplazar `TUDOMINIO.cl` se deja como placeholder deliberado para el usuario)

````markdown
## Hosting local (PC oficina) + Cloudflare Tunnel

Intcomex valida IP de origen; las IPs de Vercel son dinámicas. Alternativa: servir la API desde un PC de la oficina (IP registrada) y exponerla con Cloudflare Tunnel.

### Servidor local

```bash
npm run serve        # sirve en http://127.0.0.1:3000 (PORT/HOST para cambiar)
```

Usa el mismo handler y `.env.local` que el resto del proyecto.

### Cloudflare Tunnel (una vez, como servicio de Windows)

Requisitos: dominio de la empresa con DNS en Cloudflare (plan gratuito).

```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel login                 # abre el navegador; elegir el dominio
cloudflared tunnel create precios        # anota el TUNNEL-ID que imprime
```

Crear `C:\Users\<usuario>\.cloudflared\config.yml`:

```yaml
tunnel: <TUNNEL-ID>
credentials-file: C:\Users\<usuario>\.cloudflared\<TUNNEL-ID>.json
ingress:
  - hostname: precios.TUDOMINIO.cl
    service: http://localhost:3000
  - service: http_status:404
```

```powershell
cloudflared tunnel route dns precios precios.TUDOMINIO.cl
cloudflared service install              # queda como servicio de Windows (auto-arranca)
```

### Autoarranque del servidor

Task Scheduler → Create Task: trigger "At startup", action "Start a program":
- Program: `cmd`
- Arguments: `/c cd /d C:\ruta\al\proyecto && npm run serve`
- Marcar "Run whether user is logged on or not".

### Consumo externo

```
GET https://precios.TUDOMINIO.cl/api/price?sku=...   (o mpn= / upc=)
Header: x-api-key: <API_SECRET_KEY>
```

El PC debe permanecer encendido y con internet. Si cambia `.env.local`, reiniciar el servidor (la tarea programada o `npm run serve`).
````

- [ ] **Step 3: Suite completa final**

Run: `npm test` y `npm run typecheck`
Expected: todo PASS.

- [ ] **Step 4: Commit**

```bash
git add README.md
git commit -m "docs: add local hosting + Cloudflare Tunnel guide"
```

---

## Post-implementación (manual, con el usuario)

1. Merge de la rama `feature/local-server` a `main` (PR).
2. En el PC designado: `git pull`, `npm install`, `.env.local` con credenciales prod, `npm run serve`.
3. Usuario ejecuta los pasos de Cloudflare del README (login requiere su cuenta).
4. Probar desde fuera: `curl -H "x-api-key: ..." https://precios.<dominio>/api/price?sku=MT027DEL20`.
5. Configurar la tarea programada de autoarranque.
