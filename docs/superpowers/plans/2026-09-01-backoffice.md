# Backoffice Interno Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dashboard interno (`apps/backoffice`) para que el dueño/operador vea y opere pedidos (nuevo → pagado → entregado), cotizaciones, clientes y la salud del sistema.

**Architecture:** App Next.js (App Router) como tercer proyecto Vercel. Todo acceso a datos es server-side contra Supabase (PostgREST vía `fetch` con `service_role`). Login de clave compartida con cookie HMAC verificada en middleware (Web Crypto, corre en Edge). La lógica vive en `src/lib/*.ts` puro y testeable; las páginas son componentes de servidor finos.

**Tech Stack:** Next.js ^15, React ^19, TypeScript, vitest (config raíz existente), Web Crypto (sin dependencias de auth).

**Spec:** `docs/superpowers/specs/2026-09-01-backoffice-design.md`

## Global Constraints

- Al navegador **nunca** viaja una credencial: Supabase solo se toca desde componentes de servidor / route handlers con `SUPABASE_URL` + `SUPABASE_SERVICE_KEY` (nombres exactos).
- Cookie de sesión: nombre `bo_session`, `HttpOnly; Secure; SameSite=Lax; Path=/`, vigencia 30 días, firmada HMAC-SHA256 con `BACKOFFICE_SESSION_SECRET`.
- Login contra `BACKOFFICE_PASSWORD` con comparación de tiempo constante y pausa de 1 s al fallar.
- Transiciones legales exactas: `nuevo→pagado`, `pagado→entregado`, `nuevo→anulado`, `pagado→anulado`. Misma→misma es idempotente (ok sin efecto). Todo lo demás → 409. La unidad de escritura es el grupo `quote_id + quote_version` completo.
- `estado` (correo `sent`/`failed`/`processing`) NO se modifica nunca desde el backoffice; solo se muestra.
- Timeouts: 8 s para consultas Supabase, 4 s para los chequeos de salud. Fallo de upstream → la vista lo dice y ofrece reintentar; nunca página en blanco.
- Fechas mostradas en zona `America/Santiago` vía `Intl` con `timeZone` explícito (nunca offsets hardcodeados). CLP con separador de miles es-CL.
- UI en español. Sin dependencias nuevas más allá de `next`, `react`, `react-dom`.
- Pruebas en `apps/backoffice/tests/*.test.ts` (la config raíz de vitest ya las incluye), con `fetch` stubbeado vía `vi.stubGlobal` como en `apps/mailer/tests`.
- No commitear secretos; no usar `git add -A` (hay carpetas sin trackear del usuario).
- Commits con trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Scaffold de `apps/backoffice`

**Files:**
- Create: `apps/backoffice/package.json`, `apps/backoffice/tsconfig.json`, `apps/backoffice/next.config.ts`, `apps/backoffice/next-env.d.ts` (lo genera next), `apps/backoffice/app/layout.tsx`, `apps/backoffice/app/globals.css`, `apps/backoffice/app/page.tsx` (placeholder), `apps/backoffice/.gitignore`
- Modify: `tsconfig.json` (raíz), `package.json` (raíz)

**Interfaces:**
- Produces: el layout con barra de navegación que todas las vistas usan; la clase CSS `.tarjeta`, `.badge`, `.botonera` que las tareas 7-10 referencian.

- [ ] **Step 1: package.json del workspace**

```json
{
  "name": "@rr/backoffice",
  "version": "0.0.0",
  "private": true,
  "scripts": {
    "dev": "next dev",
    "build": "next build",
    "start": "next start"
  },
  "dependencies": {
    "next": "^15",
    "react": "^19",
    "react-dom": "^19"
  }
}
```

- [ ] **Step 2: instalar** — `npm install` desde la raíz (workspaces resuelve).

- [ ] **Step 3: tsconfig propio** (`apps/backoffice/tsconfig.json`):

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["dom", "dom.iterable", "esnext"],
    "allowJs": false,
    "skipLibCheck": true,
    "strict": true,
    "noEmit": true,
    "esModuleInterop": true,
    "module": "esnext",
    "moduleResolution": "bundler",
    "resolveJsonModule": true,
    "isolatedModules": true,
    "jsx": "preserve",
    "incremental": true,
    "plugins": [{ "name": "next" }]
  },
  "include": ["next-env.d.ts", "**/*.ts", "**/*.tsx", ".next/types/**/*.ts"],
  "exclude": ["node_modules"]
}
```

- [ ] **Step 4: excluir backoffice del tsconfig raíz y encadenar su typecheck.** En `tsconfig.json` raíz: `"exclude": ["**/dist", "node_modules", "apps/backoffice"]`. En `package.json` raíz: `"typecheck": "tsc --noEmit && tsc --noEmit -p apps/backoffice/tsconfig.json"`. (El raíz usa NodeNext sin JSX; mezclar reventaría.)

- [ ] **Step 5: next.config.ts, .gitignore, layout y CSS**

`next.config.ts`:
```ts
import type { NextConfig } from 'next';
const config: NextConfig = {};
export default config;
```

`.gitignore`:
```
.next/
.vercel
```

`app/layout.tsx` — barra con las cuatro vistas + link a Kapso + salir:
```tsx
import './globals.css';
export const metadata = { title: 'RR Backoffice' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <nav className="barra">
          <span className="logo">RR</span>
          <a href="/">Pedidos</a>
          <a href="/cotizaciones">Cotizaciones</a>
          <a href="/clientes">Clientes</a>
          <a href="/salud">Salud</a>
          <a href="https://app.kapso.ai" target="_blank" rel="noreferrer">Conversaciones ↗</a>
          <a href="/api/logout" className="salir">Salir</a>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
```

`app/globals.css` (completo; mobile-first, sin framework):
```css
* { box-sizing: border-box; margin: 0; }
:root {
  --azul: #3b3bb3; --fondo: #f6f6f9; --tinta: #1c1c28; --gris: #6b6b7a;
  --ok: #1a7f37; --alerta: #b54708; --error: #b42318; --borde: #e2e2ea;
}
body { font-family: system-ui, -apple-system, sans-serif; background: var(--fondo); color: var(--tinta); }
.barra { display: flex; gap: 14px; align-items: center; padding: 10px 16px; background: #fff; border-bottom: 1px solid var(--borde); flex-wrap: wrap; position: sticky; top: 0; }
.barra a { color: var(--tinta); text-decoration: none; font-size: 14px; }
.barra a:hover { color: var(--azul); }
.barra .logo { font-weight: 700; color: var(--azul); border: 1.5px solid var(--azul); padding: 1px 7px; }
.barra .salir { margin-left: auto; color: var(--gris); }
main { max-width: 960px; margin: 0 auto; padding: 16px; }
h1 { font-size: 20px; margin: 8px 0 16px; }
.contadores { display: grid; grid-template-columns: repeat(auto-fit, minmax(150px, 1fr)); gap: 10px; margin-bottom: 18px; }
.contador { background: #fff; border: 1px solid var(--borde); border-radius: 8px; padding: 12px; }
.contador b { display: block; font-size: 26px; }
.contador span { color: var(--gris); font-size: 13px; }
.tarjeta { background: #fff; border: 1px solid var(--borde); border-radius: 8px; padding: 14px; margin-bottom: 10px; }
.tarjeta header { display: flex; justify-content: space-between; gap: 8px; flex-wrap: wrap; align-items: baseline; }
.badge { display: inline-block; border-radius: 99px; padding: 2px 10px; font-size: 12px; font-weight: 600; }
.badge.nuevo { background: #eef; color: var(--azul); }
.badge.pagado { background: #fff4e5; color: var(--alerta); }
.badge.entregado { background: #e8f5ec; color: var(--ok); }
.badge.anulado { background: #f2f2f5; color: var(--gris); }
.badge.fallo { background: #fde8e8; color: var(--error); }
.meta { color: var(--gris); font-size: 13px; }
.lineas { width: 100%; border-collapse: collapse; margin: 10px 0; font-size: 13px; }
.lineas th, .lineas td { text-align: left; padding: 4px 6px; border-bottom: 1px solid var(--borde); }
.lineas td.num { text-align: right; font-variant-numeric: tabular-nums; }
.botonera { display: flex; gap: 8px; flex-wrap: wrap; margin-top: 10px; }
.botonera button, .boton { border: 1px solid var(--azul); background: var(--azul); color: #fff; border-radius: 6px; padding: 8px 14px; font-size: 14px; cursor: pointer; }
.botonera button.secundario { background: #fff; color: var(--azul); }
.botonera button.peligro { background: #fff; color: var(--error); border-color: var(--error); }
.botonera button:disabled { opacity: 0.5; }
.docs { display: flex; gap: 12px; flex-wrap: wrap; font-size: 13px; }
.aviso-error { background: #fde8e8; color: var(--error); border-radius: 8px; padding: 12px; }
.login { max-width: 320px; margin: 80px auto; }
.login input { width: 100%; padding: 10px; margin: 8px 0; border: 1px solid var(--borde); border-radius: 6px; }
.semaforo { display: flex; align-items: center; gap: 10px; }
.punto { width: 12px; height: 12px; border-radius: 50%; display: inline-block; }
.punto.ok { background: var(--ok); } .punto.fallo { background: var(--error); } .punto.gris { background: var(--gris); }
@media (max-width: 600px) { .barra { gap: 10px; font-size: 13px; } main { padding: 10px; } }
```

`app/page.tsx` placeholder (la tarea 7 lo reemplaza):
```tsx
export default function Home() {
  return <h1>Pedidos</h1>;
}
```

- [ ] **Step 6: verificar** — `npm run build -w @rr/backoffice` compila; `npm run typecheck` desde la raíz pasa; `npm test` sigue verde.

- [ ] **Step 7: Commit** — `git add apps/backoffice package.json package-lock.json tsconfig.json && git commit -m "feat(backoffice): scaffold Next.js"`.

---

### Task 2: Sesión firmada (`lib/session.ts`)

**Files:**
- Create: `apps/backoffice/src/lib/session.ts`
- Test: `apps/backoffice/tests/session.test.ts`

**Interfaces:**
- Produces: `crearToken(secret: string, ahoraMs: number): Promise<string>`; `tokenValido(token: string | undefined, secret: string, ahoraMs: number): Promise<boolean>`; `VIGENCIA_MS` (30 días); `COOKIE_NOMBRE = 'bo_session'`. Todo Web Crypto (corre en Edge y en Node ≥20).

- [ ] **Step 1: pruebas que fallan** (`tests/session.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { crearToken, tokenValido, VIGENCIA_MS } from '../src/lib/session.js';

const SECRET = 'secreto-de-prueba';
const AHORA = 1_756_000_000_000;

describe('sesion', () => {
  it('un token recien creado es valido', async () => {
    const token = await crearToken(SECRET, AHORA);
    expect(await tokenValido(token, SECRET, AHORA)).toBe(true);
  });
  it('expira a los 30 dias', async () => {
    const token = await crearToken(SECRET, AHORA);
    expect(await tokenValido(token, SECRET, AHORA + VIGENCIA_MS - 1)).toBe(true);
    expect(await tokenValido(token, SECRET, AHORA + VIGENCIA_MS + 1)).toBe(false);
  });
  it('un token adulterado (fecha o firma) no valida', async () => {
    const token = await crearToken(SECRET, AHORA);
    const [exp, firma] = token.split('.');
    expect(await tokenValido(`${Number(exp) + 9999}.${firma}`, SECRET, AHORA)).toBe(false);
    expect(await tokenValido(`${exp}.${firma}x`, SECRET, AHORA)).toBe(false);
  });
  it('con otro secreto no valida', async () => {
    const token = await crearToken(SECRET, AHORA);
    expect(await tokenValido(token, 'otro', AHORA)).toBe(false);
  });
  it('undefined, vacio, sin punto, o secreto vacio: false, sin lanzar', async () => {
    expect(await tokenValido(undefined, SECRET, AHORA)).toBe(false);
    expect(await tokenValido('', SECRET, AHORA)).toBe(false);
    expect(await tokenValido('sinpunto', SECRET, AHORA)).toBe(false);
    const token = await crearToken(SECRET, AHORA);
    expect(await tokenValido(token, '', AHORA)).toBe(false);
  });
});
```

- [ ] **Step 2: correr y ver fallar** — `npx vitest run apps/backoffice/tests/session.test.ts` desde la raíz. Esperado: no existe el módulo.

- [ ] **Step 3: implementación** (`src/lib/session.ts`):

```ts
// Sesion del backoffice: token `exp.firma` donde exp es epoch-ms de
// vencimiento y firma es HMAC-SHA256(exp, secret) en base64url. Web Crypto
// (no node:crypto) porque el middleware de Next corre en el runtime Edge.
export const VIGENCIA_MS = 30 * 24 * 60 * 60 * 1000;
export const COOKIE_NOMBRE = 'bo_session';

async function hmac(datos: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const firma = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(datos));
  return Buffer.from(firma).toString('base64url');
}

// Comparacion de tiempo constante sobre strings del mismo largo.
function igualesConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function crearToken(secret: string, ahoraMs: number): Promise<string> {
  const exp = String(ahoraMs + VIGENCIA_MS);
  return `${exp}.${await hmac(exp, secret)}`;
}

export async function tokenValido(token: string | undefined, secret: string, ahoraMs: number): Promise<boolean> {
  if (!token || !secret) return false;
  const punto = token.indexOf('.');
  if (punto < 1) return false;
  const exp = token.slice(0, punto);
  const firma = token.slice(punto + 1);
  if (!/^\d+$/.test(exp) || Number(exp) <= ahoraMs) return false;
  return igualesConstante(firma, await hmac(exp, secret));
}
```

Nota Edge: `Buffer` no existe en Edge. Reemplazar `Buffer.from(firma).toString('base64url')` por conversión manual:
```ts
  const bytes = new Uint8Array(firma);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
```
(usar esta versión, no la de Buffer).

- [ ] **Step 4: correr y ver pasar** — mismo comando. Esperado: PASS.

- [ ] **Step 5: Commit** — `git add apps/backoffice/src/lib/session.ts apps/backoffice/tests/session.test.ts && git commit -m "feat(backoffice): sesion firmada con Web Crypto"`.

---

### Task 3: Login, logout y middleware

**Files:**
- Create: `apps/backoffice/app/login/page.tsx`, `apps/backoffice/app/api/login/route.ts`, `apps/backoffice/app/api/logout/route.ts`, `apps/backoffice/middleware.ts`
- Test: `apps/backoffice/tests/login.test.ts`

**Interfaces:**
- Consumes: `crearToken`, `tokenValido`, `COOKIE_NOMBRE`, `VIGENCIA_MS` de `src/lib/session.js`.
- Produces: `POST /api/login` (form-urlencoded, campo `password`): éxito → 303 a `/` + Set-Cookie; fallo → 303 a `/login?error=1` tras ≥1 s. `GET /api/logout` → 303 a `/login` + cookie vencida. El handler de login se exporta como `POST(req: Request): Promise<Response>` para testearlo directo.

- [ ] **Step 1: pruebas que fallan** (`tests/login.test.ts`):

```ts
import { describe, expect, it, vi } from 'vitest';
import { POST } from '../app/api/login/route.js';

function reqCon(password: string): Request {
  return new Request('http://localhost/api/login', {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ password }).toString(),
  });
}
const ENV = { BACKOFFICE_PASSWORD: 'clave-buena', BACKOFFICE_SESSION_SECRET: 'secreto' };

describe('POST /api/login', () => {
  it('con la clave buena setea cookie firmada y redirige a /', async () => {
    vi.stubEnv('BACKOFFICE_PASSWORD', ENV.BACKOFFICE_PASSWORD);
    vi.stubEnv('BACKOFFICE_SESSION_SECRET', ENV.BACKOFFICE_SESSION_SECRET);
    const res = await POST(reqCon('clave-buena'));
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/');
    const cookie = res.headers.get('set-cookie') ?? '';
    expect(cookie).toContain('bo_session=');
    expect(cookie).toContain('HttpOnly');
    expect(cookie).toContain('SameSite=Lax');
    expect(cookie).toContain('Secure');
    vi.unstubAllEnvs();
  });
  it('con clave mala: sin cookie, redirect a /login?error=1, y demora >= 1s', async () => {
    vi.stubEnv('BACKOFFICE_PASSWORD', ENV.BACKOFFICE_PASSWORD);
    vi.stubEnv('BACKOFFICE_SESSION_SECRET', ENV.BACKOFFICE_SESSION_SECRET);
    const t0 = Date.now();
    const res = await POST(reqCon('clave-mala'));
    expect(Date.now() - t0).toBeGreaterThanOrEqual(1000);
    expect(res.status).toBe(303);
    expect(res.headers.get('location')).toContain('/login?error=1');
    expect(res.headers.get('set-cookie')).toBeNull();
    vi.unstubAllEnvs();
  }, 10000);
  it('sin BACKOFFICE_PASSWORD configurada nadie entra', async () => {
    vi.stubEnv('BACKOFFICE_SESSION_SECRET', ENV.BACKOFFICE_SESSION_SECRET);
    const res = await POST(reqCon(''));
    expect(res.headers.get('set-cookie')).toBeNull();
    vi.unstubAllEnvs();
  }, 10000);
});
```

- [ ] **Step 2: ver fallar** — `npx vitest run apps/backoffice/tests/login.test.ts`.

- [ ] **Step 3: implementar**

`app/api/login/route.ts`:
```ts
import { crearToken, COOKIE_NOMBRE, VIGENCIA_MS } from '../../../src/lib/session.js';

// Comparacion de tiempo constante via digests SHA-256 (largos iguales, sin
// fuga de longitud de la clave real).
async function claveCorrecta(entregada: string, real: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(entregada)),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(real)),
  ]);
  const va = new Uint8Array(a); const vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export async function POST(req: Request): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const password = String(form?.get('password') ?? '');
  const real = process.env.BACKOFFICE_PASSWORD ?? '';
  const secret = process.env.BACKOFFICE_SESSION_SECRET ?? '';

  // Sin secretos configurados nadie entra (real vacia nunca calza porque
  // igual pasa por el digest, y ademas se exige no-vacia).
  const ok = real !== '' && secret !== '' && (await claveCorrecta(password, real));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 1000)); // freno de fuerza bruta
    return new Response(null, { status: 303, headers: { Location: '/login?error=1' } });
  }
  const token = await crearToken(secret, Date.now());
  return new Response(null, {
    status: 303,
    headers: {
      Location: '/',
      'Set-Cookie': `${COOKIE_NOMBRE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(VIGENCIA_MS / 1000)}`,
    },
  });
}
```

`app/api/logout/route.ts`:
```ts
import { COOKIE_NOMBRE } from '../../../src/lib/session.js';
export async function GET(): Promise<Response> {
  return new Response(null, {
    status: 303,
    headers: { Location: '/login', 'Set-Cookie': `${COOKIE_NOMBRE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` },
  });
}
```

`app/login/page.tsx`:
```tsx
export default async function Login({ searchParams }: { searchParams: Promise<{ error?: string }> }) {
  const { error } = await searchParams;
  return (
    <div className="login">
      <h1>RR Backoffice</h1>
      {error ? <p className="aviso-error">Contraseña incorrecta.</p> : null}
      <form method="post" action="/api/login">
        <input type="password" name="password" placeholder="Contraseña" autoFocus />
        <button className="boton" type="submit">Entrar</button>
      </form>
    </div>
  );
}
```

`middleware.ts` (raíz de apps/backoffice):
```ts
import { NextRequest, NextResponse } from 'next/server';
import { tokenValido, COOKIE_NOMBRE } from './src/lib/session.js';

export async function middleware(req: NextRequest): Promise<NextResponse | Response> {
  const { pathname } = req.nextUrl;
  if (pathname === '/login' || pathname === '/api/login') return NextResponse.next();
  const token = req.cookies.get(COOKIE_NOMBRE)?.value;
  const ok = await tokenValido(token, process.env.BACKOFFICE_SESSION_SECRET ?? '', Date.now());
  if (ok) return NextResponse.next();
  if (pathname.startsWith('/api/')) {
    return new Response(JSON.stringify({ error: 'no_autorizado' }), { status: 401, headers: { 'content-type': 'application/json' } });
  }
  return NextResponse.redirect(new URL('/login', req.url));
}

export const config = { matcher: ['/((?!_next/static|_next/image|favicon.ico).*)'] };
```

- [ ] **Step 4: ver pasar** las pruebas y `npm run build -w @rr/backoffice`.

- [ ] **Step 5: Commit** — `git add apps/backoffice/app apps/backoffice/middleware.ts apps/backoffice/tests/login.test.ts && git commit -m "feat(backoffice): login de clave compartida y middleware"`.

---

### Task 4: Cliente Supabase (`lib/supabase.ts`)

**Files:**
- Create: `apps/backoffice/src/lib/supabase.ts`
- Test: `apps/backoffice/tests/supabase.test.ts`

**Interfaces:**
- Produces: `supabaseGet(path: string): Promise<unknown[] | null>` (null = falta config, red caída o status no-2xx); `supabasePatch(path: string, body: unknown): Promise<boolean>`. Lee `process.env.SUPABASE_URL` / `SUPABASE_SERVICE_KEY` en cada llamada. Timeout 8 s.

- [ ] **Step 1: pruebas que fallan** (`tests/supabase.test.ts`):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { supabaseGet, supabasePatch } from '../src/lib/supabase.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function conEnv() {
  vi.stubEnv('SUPABASE_URL', 'https://supabase.test/');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
}

describe('supabaseGet', () => {
  it('arma la URL sin doble slash y manda las dos cabeceras de auth', async () => {
    conEnv();
    const spy = vi.fn(async () => new Response('[]', { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await supabaseGet('/pedidos?limit=1');
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://supabase.test/rest/v1/pedidos?limit=1');
    const headers = init.headers as Record<string, string>;
    expect(headers.apikey).toBe('clave');
    expect(headers.Authorization).toBe('Bearer clave');
  });
  it('sin env devuelve null sin llamar fetch', async () => {
    const spy = vi.fn(); vi.stubGlobal('fetch', spy);
    expect(await supabaseGet('/pedidos')).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });
  it('status no-2xx o red caida devuelven null', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 500 })));
    expect(await supabaseGet('/pedidos')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(await supabaseGet('/pedidos')).toBeNull();
  });
});

describe('supabasePatch', () => {
  it('PATCH con Prefer minimal; true en 2xx, false en error', async () => {
    conEnv();
    const spy = vi.fn(async () => new Response(null, { status: 204 }));
    vi.stubGlobal('fetch', spy);
    expect(await supabasePatch('/pedidos?quote_id=eq.q', { estado_negocio: 'pagado' })).toBe(true);
    const [, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect(init.method).toBe('PATCH');
    expect((init.headers as Record<string, string>).Prefer).toBe('return=minimal');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('x', { status: 400 })));
    expect(await supabasePatch('/pedidos?quote_id=eq.q', {})).toBe(false);
  });
});
```

- [ ] **Step 2: ver fallar.**

- [ ] **Step 3: implementar** (`src/lib/supabase.ts`):

```ts
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

export async function supabasePatch(path: string, body: unknown): Promise<boolean> {
  const cfg = base();
  if (!cfg) return false;
  try {
    const r = await fetch(`${cfg.url}/rest/v1${path}`, {
      method: 'PATCH',
      headers: {
        apikey: cfg.key, Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json', Prefer: 'return=minimal',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    return r.ok;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: ver pasar. Step 5: Commit** — `git add apps/backoffice/src/lib/supabase.ts apps/backoffice/tests/supabase.test.ts && git commit -m "feat(backoffice): cliente Supabase server-side"`.

---

### Task 5: SQL de estado de negocio + dominio de pedidos y formato

**Files:**
- Create: `docs/sql/2026-09-01-estado-negocio.sql`, `apps/backoffice/src/lib/pedidos.ts`, `apps/backoffice/src/lib/formato.ts`
- Test: `apps/backoffice/tests/pedidos.test.ts`, `apps/backoffice/tests/formato.test.ts`

**Interfaces:**
- Produces:
  - `type EstadoNegocio = 'nuevo' | 'pagado' | 'entregado' | 'anulado'`
  - `transicionValida(desde: EstadoNegocio, hacia: EstadoNegocio): boolean`
  - `interface FilaPedido { po_id: string; quote_id: string; quote_version: string; proveedor: string; telefono: string | null; rut: string | null; razon_social: string | null; estado: string; estado_negocio?: EstadoNegocio; pagado_at?: string | null; entregado_at?: string | null; created_at: string; neto_grupo_clp: number | null; lineas: Array<{ nombre?: string | null; mpn?: string | null; cantidad?: number; precio_unitario_clp?: number; subtotal_neto_clp?: number }> }`
  - `interface GrupoPedido { quoteId: string; version: string; telefono: string | null; razonSocial: string | null; fecha: string; estadoNegocio: EstadoNegocio; ocs: Array<{ poId: string; proveedor: string; correo: string }>; lineas: FilaPedido['lineas'] }`
  - `agruparPedidos(filas: FilaPedido[]): GrupoPedido[]` (orden descendente por fecha)
  - `contadores(grupos: GrupoPedido[]): { porEntregar: number; nuevos: number; ocFallidas: number }`
  - `formatCLP(n: number): string` (`1221795` → `"$1.221.795"`); `fechaCorta(iso: string): string` (`"01-09-2026 14:00"`, zona America/Santiago).

- [ ] **Step 1: el SQL** (`docs/sql/2026-09-01-estado-negocio.sql`) — lo pega el usuario, idempotente:

```sql
-- Estado de NEGOCIO del pedido (spec 2026-09-01-backoffice), separado del
-- estado tecnico del correo (`estado`). Filas existentes nacen 'nuevo'.
alter table pedidos add column if not exists estado_negocio text not null default 'nuevo'
  check (estado_negocio in ('nuevo','pagado','entregado','anulado'));
alter table pedidos add column if not exists pagado_at timestamptz;
alter table pedidos add column if not exists entregado_at timestamptz;
```

- [ ] **Step 2: pruebas que fallan** (`tests/pedidos.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { agruparPedidos, contadores, transicionValida, type FilaPedido } from '../src/lib/pedidos.js';

const fila = (extra: Partial<FilaPedido>): FilaPedido => ({
  po_id: 'oc-q-1-1-ingram', quote_id: 'q-1', quote_version: '1', proveedor: 'ingram',
  telefono: '569', rut: null, razon_social: 'Acme', estado: 'sent', estado_negocio: 'nuevo',
  created_at: '2026-09-01T18:00:00Z', neto_grupo_clp: 1000,
  lineas: [{ nombre: 'A', cantidad: 1, precio_unitario_clp: 1000, subtotal_neto_clp: 1000 }],
  ...extra,
});

describe('transicionValida', () => {
  it.each([
    ['nuevo', 'pagado', true], ['pagado', 'entregado', true],
    ['nuevo', 'anulado', true], ['pagado', 'anulado', true],
    ['nuevo', 'entregado', false], ['entregado', 'anulado', false],
    ['entregado', 'pagado', false], ['anulado', 'pagado', false],
  ] as const)('%s -> %s = %s', (desde, hacia, esperado) => {
    expect(transicionValida(desde, hacia)).toBe(esperado);
  });
});

describe('agruparPedidos', () => {
  it('agrupa por quote_id+version y junta las OCs', () => {
    const grupos = agruparPedidos([
      fila({}), fila({ po_id: 'oc-q-1-1-intcomex', proveedor: 'intcomex', estado: 'failed' }),
      fila({ po_id: 'oc-q-2-1-ingram', quote_id: 'q-2', created_at: '2026-09-02T10:00:00Z' }),
    ]);
    expect(grupos).toHaveLength(2);
    expect(grupos[0].quoteId).toBe('q-2'); // mas reciente primero
    expect(grupos[1].ocs.map((o) => o.proveedor).sort()).toEqual(['ingram', 'intcomex']);
  });
  it('sin estado_negocio (fila pre-ALTER en una consulta vieja) asume nuevo', () => {
    const grupos = agruparPedidos([fila({ estado_negocio: undefined })]);
    expect(grupos[0].estadoNegocio).toBe('nuevo');
  });
});

describe('contadores', () => {
  it('cuenta pagados-por-entregar, nuevos y OC fallidas', () => {
    const grupos = agruparPedidos([
      fila({}),
      fila({ quote_id: 'q-2', po_id: 'p2', estado_negocio: 'pagado' }),
      fila({ quote_id: 'q-3', po_id: 'p3', estado_negocio: 'entregado' }),
      fila({ quote_id: 'q-4', po_id: 'p4', estado: 'failed' }),
    ]);
    expect(contadores(grupos)).toEqual({ porEntregar: 1, nuevos: 2, ocFallidas: 1 });
  });
});
```

y `tests/formato.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { formatCLP, fechaCorta } from '../src/lib/formato.js';

describe('formato', () => {
  it('CLP con puntos de miles', () => {
    expect(formatCLP(1221795)).toBe('$1.221.795');
  });
  it('fecha corta en hora de Santiago (UTC-4 el 1 de septiembre)', () => {
    expect(fechaCorta('2026-09-01T18:00:00.000Z')).toBe('01-09-2026 14:00');
  });
});
```

- [ ] **Step 3: ver fallar. Step 4: implementar**

`src/lib/formato.ts`:
```ts
const ZONA = 'America/Santiago';
export function formatCLP(n: number): string {
  return '$' + Math.round(n).toLocaleString('es-CL');
}
export function fechaCorta(iso: string): string {
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONA, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  const hora = v('hour') === '24' ? '00' : v('hour');
  return `${v('day')}-${v('month')}-${v('year')} ${hora}:${v('minute')}`;
}
```

`src/lib/pedidos.ts`:
```ts
export type EstadoNegocio = 'nuevo' | 'pagado' | 'entregado' | 'anulado';

// Maquina de estados del negocio. `anulado` solo desde estados no terminales;
// `entregado` es terminal. La idempotencia (misma->misma) la resuelve el
// route handler, no esta tabla.
const TRANSICIONES: Record<EstadoNegocio, EstadoNegocio[]> = {
  nuevo: ['pagado', 'anulado'],
  pagado: ['entregado', 'anulado'],
  entregado: [],
  anulado: [],
};
export function transicionValida(desde: EstadoNegocio, hacia: EstadoNegocio): boolean {
  return TRANSICIONES[desde]?.includes(hacia) ?? false;
}

export interface FilaPedido {
  po_id: string; quote_id: string; quote_version: string; proveedor: string;
  telefono: string | null; rut: string | null; razon_social: string | null;
  estado: string; estado_negocio?: EstadoNegocio;
  pagado_at?: string | null; entregado_at?: string | null;
  created_at: string; neto_grupo_clp: number | null;
  lineas: Array<{ nombre?: string | null; mpn?: string | null; cantidad?: number; precio_unitario_clp?: number; subtotal_neto_clp?: number }>;
}

export interface GrupoPedido {
  quoteId: string; version: string; telefono: string | null; razonSocial: string | null;
  fecha: string; estadoNegocio: EstadoNegocio;
  ocs: Array<{ poId: string; proveedor: string; correo: string }>;
  lineas: FilaPedido['lineas'];
}

// La unidad operativa: el pedido del cliente = todas las filas (una por
// mayorista) que comparten quote_id+version. Las transiciones escriben el
// grupo entero, asi que el estado_negocio de la primera fila representa al
// grupo; `?? 'nuevo'` cubre consultas sin la columna (pre-ALTER).
export function agruparPedidos(filas: FilaPedido[]): GrupoPedido[] {
  const grupos = new Map<string, GrupoPedido>();
  for (const f of filas) {
    const clave = `${f.quote_id}:${f.quote_version}`;
    const grupo = grupos.get(clave) ?? {
      quoteId: f.quote_id, version: f.quote_version, telefono: f.telefono,
      razonSocial: f.razon_social, fecha: f.created_at,
      estadoNegocio: f.estado_negocio ?? 'nuevo', ocs: [], lineas: [],
    };
    grupo.ocs.push({ poId: f.po_id, proveedor: f.proveedor, correo: f.estado });
    grupo.lineas = grupo.lineas.concat(f.lineas ?? []);
    if (f.created_at < grupo.fecha) grupo.fecha = f.created_at;
    grupos.set(clave, grupo);
  }
  return [...grupos.values()].sort((a, b) => (a.fecha < b.fecha ? 1 : -1));
}

export function contadores(grupos: GrupoPedido[]): { porEntregar: number; nuevos: number; ocFallidas: number } {
  return {
    porEntregar: grupos.filter((g) => g.estadoNegocio === 'pagado').length,
    nuevos: grupos.filter((g) => g.estadoNegocio === 'nuevo').length,
    ocFallidas: grupos.reduce((n, g) => n + g.ocs.filter((o) => o.correo === 'failed').length, 0),
  };
}
```

- [ ] **Step 5: ver pasar. Step 6: Commit** — `git add docs/sql/2026-09-01-estado-negocio.sql apps/backoffice/src/lib/pedidos.ts apps/backoffice/src/lib/formato.ts apps/backoffice/tests/pedidos.test.ts apps/backoffice/tests/formato.test.ts && git commit -m "feat(backoffice): estados de negocio, agrupacion y formato"`.

---

### Task 6: API de transición

**Files:**
- Create: `apps/backoffice/app/api/pedidos/transicion/route.ts`
- Test: `apps/backoffice/tests/transicion.test.ts`

**Interfaces:**
- Consumes: `supabaseGet`/`supabasePatch` (Task 4); `transicionValida`, `EstadoNegocio` (Task 5).
- Produces: `POST /api/pedidos/transicion` con JSON `{ quote_id, quote_version, hacia }`. Respuestas: `200 {ok:true, estado}` (incluye idempotente), `400` cuerpo malo, `404` grupo inexistente, `409 {error:'transicion_invalida', desde}`, `503 {error:'upstream'}`. (El 401 sin sesión lo pone el middleware, no este handler.)

- [ ] **Step 1: pruebas que fallan** (`tests/transicion.test.ts`):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../app/api/pedidos/transicion/route.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function conEnv() {
  vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
}
function req(body: unknown): Request {
  return new Request('http://localhost/api/pedidos/transicion', {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
  });
}
// GET de grupo -> filas con estado dado; captura los PATCH.
function stubSupabase(estadoActual: string | null, patches: Array<{ url: string; body: any }> = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => {
    if (init?.method === 'PATCH') {
      patches.push({ url: String(url), body: JSON.parse(String(init.body)) });
      return new Response(null, { status: 204 });
    }
    const filas = estadoActual === null ? [] : [{ estado_negocio: estadoActual }];
    return new Response(JSON.stringify(filas), { status: 200 });
  }));
  return patches;
}

describe('POST /api/pedidos/transicion', () => {
  it('nuevo -> pagado: PATCH al grupo completo con pagado_at', async () => {
    conEnv();
    const patches = stubSupabase('nuevo');
    const res = await POST(req({ quote_id: 'q-1', quote_version: '1', hacia: 'pagado' }));
    expect(res.status).toBe(200);
    expect(patches).toHaveLength(1);
    expect(patches[0].url).toContain('quote_id=eq.q-1');
    expect(patches[0].url).toContain('quote_version=eq.1');
    expect(patches[0].body.estado_negocio).toBe('pagado');
    expect(typeof patches[0].body.pagado_at).toBe('string');
  });
  it('pagado -> entregado estampa entregado_at', async () => {
    conEnv();
    const patches = stubSupabase('pagado');
    const res = await POST(req({ quote_id: 'q-1', quote_version: '1', hacia: 'entregado' }));
    expect(res.status).toBe(200);
    expect(typeof patches[0].body.entregado_at).toBe('string');
  });
  it('idempotente: pagado -> pagado responde ok SIN escribir', async () => {
    conEnv();
    const patches = stubSupabase('pagado');
    const res = await POST(req({ quote_id: 'q-1', quote_version: '1', hacia: 'pagado' }));
    expect(res.status).toBe(200);
    expect(patches).toHaveLength(0);
  });
  it('transicion ilegal -> 409 con el estado actual', async () => {
    conEnv();
    stubSupabase('nuevo');
    const res = await POST(req({ quote_id: 'q-1', quote_version: '1', hacia: 'entregado' }));
    expect(res.status).toBe(409);
    expect((await res.json()).desde).toBe('nuevo');
  });
  it('grupo inexistente -> 404; cuerpo invalido -> 400; supabase caido -> 503', async () => {
    conEnv();
    stubSupabase(null);
    expect((await POST(req({ quote_id: 'q-x', quote_version: '1', hacia: 'pagado' }))).status).toBe(404);
    expect((await POST(req({ hacia: 'volado' }))).status).toBe(400);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caida'); }));
    expect((await POST(req({ quote_id: 'q-1', quote_version: '1', hacia: 'pagado' }))).status).toBe(503);
  });
});
```

- [ ] **Step 2: ver fallar. Step 3: implementar** (`app/api/pedidos/transicion/route.ts`):

```ts
import { supabaseGet, supabasePatch } from '../../../../src/lib/supabase.js';
import { transicionValida, type EstadoNegocio } from '../../../../src/lib/pedidos.js';

const ESTADOS: EstadoNegocio[] = ['nuevo', 'pagado', 'entregado', 'anulado'];
const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

export async function POST(req: Request): Promise<Response> {
  const body = (await req.json().catch(() => null)) as
    | { quote_id?: string; quote_version?: string; hacia?: string } | null;
  const quoteId = String(body?.quote_id ?? '');
  const version = String(body?.quote_version ?? '');
  const hacia = String(body?.hacia ?? '') as EstadoNegocio;
  if (!quoteId || !version || !ESTADOS.includes(hacia)) return json({ error: 'cuerpo_invalido' }, 400);

  const filtro = `quote_id=eq.${encodeURIComponent(quoteId)}&quote_version=eq.${encodeURIComponent(version)}`;
  const filas = await supabaseGet(`/pedidos?${filtro}&select=estado_negocio&limit=1`);
  if (filas === null) return json({ error: 'upstream' }, 503);
  const actual = (filas[0] as { estado_negocio?: EstadoNegocio } | undefined)?.estado_negocio;
  if (actual === undefined) return json({ error: 'pedido_no_encontrado' }, 404);

  if (actual === hacia) return json({ ok: true, estado: actual }); // idempotente, sin escritura
  if (!transicionValida(actual, hacia)) return json({ error: 'transicion_invalida', desde: actual }, 409);

  const cambio: Record<string, unknown> = { estado_negocio: hacia };
  if (hacia === 'pagado') cambio.pagado_at = new Date().toISOString();
  if (hacia === 'entregado') cambio.entregado_at = new Date().toISOString();
  const ok = await supabasePatch(`/pedidos?${filtro}`, cambio);
  if (!ok) return json({ error: 'upstream' }, 503);
  return json({ ok: true, estado: hacia });
}
```

- [ ] **Step 4: ver pasar. Step 5: Commit** — `git add apps/backoffice/app/api/pedidos apps/backoffice/tests/transicion.test.ts && git commit -m "feat(backoffice): transiciones de estado por grupo"`.

---

### Task 7: Vista Pedidos (portada)

**Files:**
- Create: `apps/backoffice/src/lib/vista-pedidos.ts`, `apps/backoffice/app/componentes/BotonesTransicion.tsx`, `apps/backoffice/app/componentes/TarjetaPedido.tsx`
- Modify: `apps/backoffice/app/page.tsx` (reemplaza el placeholder)
- Test: `apps/backoffice/tests/vista-pedidos.test.ts`

**Interfaces:**
- Consumes: `supabaseGet` (4); `agruparPedidos`, `contadores`, `GrupoPedido` (5); `formatCLP`, `fechaCorta` (5).
- Produces: `cargarVistaPedidos(): Promise<VistaPedidos | null>` con `interface VistaPedidos { contadores: { porEntregar: number; nuevos: number; ocFallidas: number }; pedidos: Array<GrupoPedido & { totalFmt: string; numeroCotizacion: number | null }> }`. Constante `RELAY_BASE = 'https://rr-mailing.vercel.app'` en `src/lib/constantes.ts` (crearla aquí; URLs públicas, no secretos).

- [ ] **Step 1: pruebas que fallan** (`tests/vista-pedidos.test.ts`):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarVistaPedidos } from '../src/lib/vista-pedidos.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const FILA = {
  po_id: 'oc-q-1-1-ingram', quote_id: 'q-1', quote_version: '1', proveedor: 'ingram',
  telefono: '569', rut: null, razon_social: 'Acme', estado: 'sent', estado_negocio: 'pagado',
  created_at: '2026-09-01T18:00:00Z', neto_grupo_clp: 1000,
  lineas: [{ nombre: 'A', cantidad: 1, precio_unitario_clp: 1000, subtotal_neto_clp: 1000 }],
};
const COT = { quote_id: 'q-1', version: '1', numero: 1600001, total_clp: 1190 };

function stub() {
  vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
  vi.stubGlobal('fetch', vi.fn(async (url: any) =>
    new Response(JSON.stringify(String(url).includes('/cotizaciones') ? [COT] : [FILA]), { status: 200 })));
}

describe('cargarVistaPedidos', () => {
  it('junta pedido + total y numero de su cotizacion', async () => {
    stub();
    const vista = await cargarVistaPedidos();
    expect(vista?.contadores.porEntregar).toBe(1);
    expect(vista?.pedidos[0].totalFmt).toBe('$1.190');
    expect(vista?.pedidos[0].numeroCotizacion).toBe(1600001);
  });
  it('cotizacion no encontrada: total "—" y numero null, sin reventar', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    vi.stubGlobal('fetch', vi.fn(async (url: any) =>
      new Response(JSON.stringify(String(url).includes('/cotizaciones') ? [] : [FILA]), { status: 200 })));
    const vista = await cargarVistaPedidos();
    expect(vista?.pedidos[0].totalFmt).toBe('—');
    expect(vista?.pedidos[0].numeroCotizacion).toBeNull();
  });
  it('supabase caido -> null', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caida'); }));
    expect(await cargarVistaPedidos()).toBeNull();
  });
});
```

- [ ] **Step 2: ver fallar. Step 3: implementar**

`src/lib/constantes.ts`:
```ts
// URLs publicas (no secretos): el rele que sirve los PDF y el front de Kapso.
export const RELAY_BASE = 'https://rr-mailing.vercel.app';
export const KAPSO_URL = 'https://app.kapso.ai';
```

`src/lib/vista-pedidos.ts`:
```ts
import { supabaseGet } from './supabase.js';
import { agruparPedidos, contadores, type FilaPedido, type GrupoPedido } from './pedidos.js';
import { formatCLP } from './formato.js';

export interface VistaPedidos {
  contadores: { porEntregar: number; nuevos: number; ocFallidas: number };
  pedidos: Array<GrupoPedido & { totalFmt: string; numeroCotizacion: number | null }>;
}

const LIMITE = 200; // los ~ultimos 200 pedidos; paginacion cuando haga falta de verdad

export async function cargarVistaPedidos(): Promise<VistaPedidos | null> {
  const filas = await supabaseGet(`/pedidos?select=*&order=created_at.desc&limit=${LIMITE}`);
  if (filas === null) return null;
  const grupos = agruparPedidos(filas as FilaPedido[]);

  // Total de venta y numero correlativo viven en la cotizacion de origen.
  const ids = [...new Set(grupos.map((g) => `"${g.quoteId}"`))];
  const cots = ids.length > 0
    ? await supabaseGet(`/cotizaciones?select=quote_id,version,numero,total_clp&quote_id=in.(${encodeURIComponent(ids.join(','))})`)
    : [];
  if (cots === null) return null;
  const porClave = new Map(
    (cots as Array<{ quote_id: string; version: string; numero: number | null; total_clp: number }>).map(
      (c) => [`${c.quote_id}:${c.version}`, c],
    ),
  );

  return {
    contadores: contadores(grupos),
    pedidos: grupos.map((g) => {
      const cot = porClave.get(`${g.quoteId}:${g.version}`);
      return {
        ...g,
        totalFmt: cot ? formatCLP(cot.total_clp) : '—',
        numeroCotizacion: cot?.numero ?? null,
      };
    }),
  };
}
```

`app/componentes/BotonesTransicion.tsx` (client component):
```tsx
'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function BotonesTransicion({ quoteId, version, estado }: { quoteId: string; version: string; estado: string }) {
  const router = useRouter();
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');

  async function marcar(hacia: string) {
    if (hacia === 'anulado' && !confirm('¿Anular este pedido?')) return;
    setOcupado(true); setError('');
    const res = await fetch('/api/pedidos/transicion', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quote_id: quoteId, quote_version: version, hacia }),
    }).catch(() => null);
    setOcupado(false);
    if (res?.ok) router.refresh();
    else setError('No se pudo guardar el cambio. Intenta de nuevo.');
  }

  return (
    <div className="botonera">
      {estado === 'nuevo' ? <button disabled={ocupado} onClick={() => marcar('pagado')}>Marcar pagado</button> : null}
      {estado === 'pagado' ? <button disabled={ocupado} onClick={() => marcar('entregado')}>Marcar entregado</button> : null}
      {estado === 'nuevo' || estado === 'pagado'
        ? <button disabled={ocupado} className="peligro" onClick={() => marcar('anulado')}>Anular</button> : null}
      {error ? <span className="aviso-error">{error}</span> : null}
    </div>
  );
}
```

`app/componentes/TarjetaPedido.tsx` (server component):
```tsx
import { RELAY_BASE, KAPSO_URL } from '../../src/lib/constantes.js';
import { fechaCorta, formatCLP } from '../../src/lib/formato.js';
import type { GrupoPedido } from '../../src/lib/pedidos.js';
import { BotonesTransicion } from './BotonesTransicion.js';

type Pedido = GrupoPedido & { totalFmt: string; numeroCotizacion: number | null };

export function TarjetaPedido({ pedido }: { pedido: Pedido }) {
  return (
    <details className="tarjeta">
      <summary>
        <header>
          <span><b>{pedido.razonSocial ?? pedido.telefono ?? 'Sin cliente'}</b> · {pedido.totalFmt}</span>
          <span>
            <span className={`badge ${pedido.estadoNegocio}`}>{pedido.estadoNegocio}</span>{' '}
            {pedido.ocs.some((o) => o.correo === 'failed') ? <span className="badge fallo">OC fallida</span> : null}
          </span>
        </header>
        <div className="meta">
          {fechaCorta(pedido.fecha)}
          {pedido.numeroCotizacion !== null ? ` · Cotización N° ${pedido.numeroCotizacion}` : ''}
        </div>
      </summary>
      <table className="lineas">
        <thead><tr><th>Producto</th><th>Cant.</th><th>Unitario</th><th>Subtotal</th></tr></thead>
        <tbody>
          {pedido.lineas.map((l, i) => (
            <tr key={i}>
              <td>{l.nombre ?? '—'}</td>
              <td className="num">{l.cantidad ?? 0}</td>
              <td className="num">{formatCLP(l.precio_unitario_clp ?? 0)}</td>
              <td className="num">{formatCLP(l.subtotal_neto_clp ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="docs">
        <a href={`${RELAY_BASE}/api/cotizacion/${pedido.quoteId}`} target="_blank" rel="noreferrer">PDF cotización</a>
        {pedido.ocs.map((o) => (
          <a key={o.poId} href={`${RELAY_BASE}/api/orden/${o.poId}`} target="_blank" rel="noreferrer">
            OC {o.proveedor}{o.correo === 'failed' ? ' (correo falló)' : ''}
          </a>
        ))}
        <a href={KAPSO_URL} target="_blank" rel="noreferrer">Conversación ↗</a>
      </div>
      <BotonesTransicion quoteId={pedido.quoteId} version={pedido.version} estado={pedido.estadoNegocio} />
    </details>
  );
}
```

`app/page.tsx`:
```tsx
import { cargarVistaPedidos } from '../src/lib/vista-pedidos.js';
import { TarjetaPedido } from './componentes/TarjetaPedido.js';

export const dynamic = 'force-dynamic';

export default async function Pedidos({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const { estado } = await searchParams;
  const vista = await cargarVistaPedidos();
  if (!vista) {
    return <div className="aviso-error">No se pudo cargar desde la base. <a href="/">Reintentar</a></div>;
  }
  const pedidos = estado ? vista.pedidos.filter((p) => p.estadoNegocio === estado) : vista.pedidos;
  return (
    <>
      <h1>Pedidos</h1>
      <div className="contadores">
        <div className="contador"><b>{vista.contadores.porEntregar}</b><span>pagados por entregar</span></div>
        <div className="contador"><b>{vista.contadores.nuevos}</b><span>nuevos</span></div>
        <div className="contador"><b>{vista.contadores.ocFallidas}</b><span>OC con correo fallido</span></div>
      </div>
      <div className="meta" style={{ marginBottom: 10 }}>
        Filtrar: <a href="/">todos</a> · <a href="/?estado=nuevo">nuevos</a> · <a href="/?estado=pagado">pagados</a> · <a href="/?estado=entregado">entregados</a> · <a href="/?estado=anulado">anulados</a>
      </div>
      {pedidos.length === 0 ? <p className="meta">Sin pedidos.</p> : pedidos.map((p) => (
        <TarjetaPedido key={`${p.quoteId}:${p.version}`} pedido={p} />
      ))}
    </>
  );
}
```

- [ ] **Step 4: ver pasar** las pruebas + `npm run build -w @rr/backoffice`.

- [ ] **Step 5: Commit** — `git add apps/backoffice/src/lib apps/backoffice/app apps/backoffice/tests/vista-pedidos.test.ts && git commit -m "feat(backoffice): vista de pedidos con contadores y acciones"`.

---

### Task 8: Vista Cotizaciones

**Files:**
- Create: `apps/backoffice/src/lib/vista-cotizaciones.ts`, `apps/backoffice/app/cotizaciones/page.tsx`
- Test: `apps/backoffice/tests/vista-cotizaciones.test.ts`

**Interfaces:**
- Consumes: `supabaseGet`, `formatCLP`, `fechaCorta`, `RELAY_BASE`.
- Produces: `cargarVistaCotizaciones(ahoraMs: number): Promise<VistaCotizaciones | null>` con filas `{ numero: number | null; quoteId: string; fecha: string; clienteLabel: string; totalFmt: string; vigente: boolean; tienePedido: boolean; pdfUrl: string }`.

- [ ] **Step 1: pruebas que fallan** (`tests/vista-cotizaciones.test.ts`):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarVistaCotizaciones } from '../src/lib/vista-cotizaciones.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const AHORA = Date.parse('2026-09-01T20:00:00Z');
const COT = {
  quote_id: 'q-1', version: '1', numero: 1600001, telefono: '569', total_clp: 1190,
  valida_hasta: '2026-09-01T21:00:00Z', created_at: '2026-09-01T18:00:00Z',
};

function stub(cots: unknown[], pedidos: unknown[] = [], clientes: unknown[] = []) {
  vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    const u = String(url);
    const datos = u.includes('/pedidos') ? pedidos : u.includes('/clientes') ? clientes : cots;
    return new Response(JSON.stringify(datos), { status: 200 });
  }));
}

describe('cargarVistaCotizaciones', () => {
  it('vigencia contra ahora, badge de pedido, razon social si el telefono calza', async () => {
    stub([COT], [{ quote_id: 'q-1', quote_version: '1' }], [{ telefono: '569', razon_social: 'Acme' }]);
    const vista = await cargarVistaCotizaciones(AHORA);
    const fila = vista!.filas[0];
    expect(fila.vigente).toBe(true);
    expect(fila.tienePedido).toBe(true);
    expect(fila.clienteLabel).toBe('Acme');
    expect(fila.totalFmt).toBe('$1.190');
    expect(fila.pdfUrl).toBe('https://rr-mailing.vercel.app/api/cotizacion/q-1');
  });
  it('expirada cuando valida_hasta ya paso; telefono pelado si no hay cliente', async () => {
    stub([{ ...COT, valida_hasta: '2026-09-01T19:00:00Z' }]);
    const fila = (await cargarVistaCotizaciones(AHORA))!.filas[0];
    expect(fila.vigente).toBe(false);
    expect(fila.clienteLabel).toBe('569');
  });
  it('supabase caido -> null', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caida'); }));
    expect(await cargarVistaCotizaciones(AHORA)).toBeNull();
  });
});
```

- [ ] **Step 2: ver fallar. Step 3: implementar**

`src/lib/vista-cotizaciones.ts`:
```ts
import { supabaseGet } from './supabase.js';
import { formatCLP } from './formato.js';
import { RELAY_BASE } from './constantes.js';

export interface FilaCotizacion {
  numero: number | null; quoteId: string; fecha: string; clienteLabel: string;
  totalFmt: string; vigente: boolean; tienePedido: boolean; pdfUrl: string;
}
export interface VistaCotizaciones { filas: FilaCotizacion[] }

const LIMITE = 200;

export async function cargarVistaCotizaciones(ahoraMs: number): Promise<VistaCotizaciones | null> {
  const cots = await supabaseGet(
    `/cotizaciones?select=quote_id,version,numero,telefono,total_clp,valida_hasta,created_at&order=created_at.desc&limit=${LIMITE}`,
  );
  if (cots === null) return null;
  const tipadas = cots as Array<{
    quote_id: string; version: string; numero: number | null; telefono: string | null;
    total_clp: number; valida_hasta: string | null; created_at: string;
  }>;

  const [pedidos, clientes] = await Promise.all([
    supabaseGet(`/pedidos?select=quote_id,quote_version&limit=1000`),
    supabaseGet(`/clientes?select=telefono,razon_social&limit=1000`),
  ]);
  if (pedidos === null || clientes === null) return null;
  const conPedido = new Set(
    (pedidos as Array<{ quote_id: string; quote_version: string }>).map((p) => `${p.quote_id}:${p.quote_version}`),
  );
  const razonPorTelefono = new Map(
    (clientes as Array<{ telefono: string; razon_social: string }>).map((c) => [c.telefono, c.razon_social]),
  );

  return {
    filas: tipadas.map((c) => ({
      numero: c.numero,
      quoteId: c.quote_id,
      fecha: c.created_at,
      clienteLabel: (c.telefono ? razonPorTelefono.get(c.telefono) : null) ?? c.telefono ?? 'Sin teléfono',
      totalFmt: formatCLP(c.total_clp),
      vigente: c.valida_hasta !== null && Date.parse(c.valida_hasta) > ahoraMs,
      tienePedido: conPedido.has(`${c.quote_id}:${c.version}`),
      pdfUrl: `${RELAY_BASE}/api/cotizacion/${c.quote_id}`,
    })),
  };
}
```

`app/cotizaciones/page.tsx`:
```tsx
import { cargarVistaCotizaciones } from '../../src/lib/vista-cotizaciones.js';
import { fechaCorta } from '../../src/lib/formato.js';

export const dynamic = 'force-dynamic';

export default async function Cotizaciones() {
  const vista = await cargarVistaCotizaciones(Date.now());
  if (!vista) return <div className="aviso-error">No se pudo cargar desde la base. <a href="/cotizaciones">Reintentar</a></div>;
  return (
    <>
      <h1>Cotizaciones</h1>
      {vista.filas.length === 0 ? <p className="meta">Sin cotizaciones.</p> : vista.filas.map((f) => (
        <div className="tarjeta" key={f.quoteId}>
          <header>
            <span><b>N° {f.numero ?? 'S/N'}</b> · {f.clienteLabel} · {f.totalFmt}</span>
            <span>
              <span className={`badge ${f.vigente ? 'entregado' : 'anulado'}`}>{f.vigente ? 'vigente' : 'expirada'}</span>{' '}
              {f.tienePedido ? <span className="badge pagado">→ pedido</span> : null}
            </span>
          </header>
          <div className="meta">{fechaCorta(f.fecha)} · <a href={f.pdfUrl} target="_blank" rel="noreferrer">PDF</a></div>
        </div>
      ))}
    </>
  );
}
```

- [ ] **Step 4: ver pasar + build. Step 5: Commit** — `git add apps/backoffice/src/lib/vista-cotizaciones.ts apps/backoffice/app/cotizaciones apps/backoffice/tests/vista-cotizaciones.test.ts && git commit -m "feat(backoffice): vista de cotizaciones"`.

---

### Task 9: Vista Clientes (lista + ficha)

**Files:**
- Create: `apps/backoffice/src/lib/vista-clientes.ts`, `apps/backoffice/app/clientes/page.tsx`, `apps/backoffice/app/clientes/[telefono]/page.tsx`
- Test: `apps/backoffice/tests/vista-clientes.test.ts`

**Interfaces:**
- Consumes: `supabaseGet`, `formatCLP`, `fechaCorta`, `agruparPedidos`.
- Produces: `cargarClientes(): Promise<Array<{ telefono: string; razonSocial: string; rut: string }> | null>`; `cargarFichaCliente(telefono: string): Promise<FichaCliente | null | 'no_existe'>` con `interface FichaCliente { datos: { telefono: string; rut: string; razonSocial: string; giro: string; direccion: string; comuna: string; ciudad: string; email: string }; cotizaciones: Array<{ numero: number | null; fecha: string; totalFmt: string }>; pedidos: Array<{ fecha: string; estadoNegocio: string }> }`.

- [ ] **Step 1: pruebas que fallan** (`tests/vista-clientes.test.ts`):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarClientes, cargarFichaCliente } from '../src/lib/vista-clientes.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const CLIENTE = {
  telefono: '569', rut: '1-9', razon_social: 'Acme', giro: 'Ventas',
  direccion: 'Calle 1', comuna: 'Ñuñoa', ciudad: 'Santiago', email: 'a@a.cl',
};

function stub(clientes: unknown[], cots: unknown[] = [], pedidos: unknown[] = []) {
  vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    const u = String(url);
    const datos = u.includes('/clientes') ? clientes : u.includes('/cotizaciones') ? cots : pedidos;
    return new Response(JSON.stringify(datos), { status: 200 });
  }));
}

describe('clientes', () => {
  it('la lista sale con telefono, razon social y rut', async () => {
    stub([CLIENTE]);
    expect(await cargarClientes()).toEqual([{ telefono: '569', razonSocial: 'Acme', rut: '1-9' }]);
  });
  it('la ficha junta datos + historial', async () => {
    stub([CLIENTE], [{ numero: 1600001, created_at: '2026-09-01T18:00:00Z', total_clp: 1190 }],
      [{ po_id: 'p', quote_id: 'q-1', quote_version: '1', proveedor: 'ingram', telefono: '569',
         rut: null, razon_social: 'Acme', estado: 'sent', estado_negocio: 'pagado',
         created_at: '2026-09-01T18:05:00Z', neto_grupo_clp: 1000, lineas: [] }]);
    const ficha = await cargarFichaCliente('569');
    expect(ficha).not.toBe('no_existe');
    if (ficha === null || ficha === 'no_existe') throw new Error('inesperado');
    expect(ficha.datos.giro).toBe('Ventas');
    expect(ficha.cotizaciones[0].totalFmt).toBe('$1.190');
    expect(ficha.pedidos[0].estadoNegocio).toBe('pagado');
  });
  it('telefono desconocido -> no_existe; supabase caido -> null', async () => {
    stub([]);
    expect(await cargarFichaCliente('000')).toBe('no_existe');
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caida'); }));
    expect(await cargarFichaCliente('569')).toBeNull();
  });
});
```

- [ ] **Step 2: ver fallar. Step 3: implementar**

`src/lib/vista-clientes.ts`:
```ts
import { supabaseGet } from './supabase.js';
import { agruparPedidos, type FilaPedido } from './pedidos.js';
import { formatCLP } from './formato.js';

export interface FichaCliente {
  datos: { telefono: string; rut: string; razonSocial: string; giro: string; direccion: string; comuna: string; ciudad: string; email: string };
  cotizaciones: Array<{ numero: number | null; fecha: string; totalFmt: string }>;
  pedidos: Array<{ fecha: string; estadoNegocio: string }>;
}

export async function cargarClientes(): Promise<Array<{ telefono: string; razonSocial: string; rut: string }> | null> {
  const filas = await supabaseGet('/clientes?select=telefono,razon_social,rut&order=updated_at.desc&limit=500');
  if (filas === null) return null;
  return (filas as Array<{ telefono: string; razon_social: string; rut: string }>).map((c) => ({
    telefono: c.telefono, razonSocial: c.razon_social, rut: c.rut,
  }));
}

export async function cargarFichaCliente(telefono: string): Promise<FichaCliente | null | 'no_existe'> {
  const tel = encodeURIComponent(telefono);
  const clientes = await supabaseGet(`/clientes?telefono=eq.${tel}&limit=1`);
  if (clientes === null) return null;
  const c = clientes[0] as {
    telefono: string; rut: string; razon_social: string; giro: string;
    direccion: string; comuna: string; ciudad: string; email: string;
  } | undefined;
  if (!c) return 'no_existe';

  const [cots, pedidos] = await Promise.all([
    supabaseGet(`/cotizaciones?telefono=eq.${tel}&select=numero,created_at,total_clp&order=created_at.desc&limit=50`),
    supabaseGet(`/pedidos?telefono=eq.${tel}&select=*&order=created_at.desc&limit=100`),
  ]);
  if (cots === null || pedidos === null) return null;

  return {
    datos: {
      telefono: c.telefono, rut: c.rut, razonSocial: c.razon_social, giro: c.giro,
      direccion: c.direccion, comuna: c.comuna, ciudad: c.ciudad, email: c.email,
    },
    cotizaciones: (cots as Array<{ numero: number | null; created_at: string; total_clp: number }>).map((q) => ({
      numero: q.numero, fecha: q.created_at, totalFmt: formatCLP(q.total_clp),
    })),
    pedidos: agruparPedidos(pedidos as FilaPedido[]).map((g) => ({ fecha: g.fecha, estadoNegocio: g.estadoNegocio })),
  };
}
```

`app/clientes/page.tsx`:
```tsx
import { cargarClientes } from '../../src/lib/vista-clientes.js';

export const dynamic = 'force-dynamic';

export default async function Clientes() {
  const clientes = await cargarClientes();
  if (clientes === null) return <div className="aviso-error">No se pudo cargar desde la base. <a href="/clientes">Reintentar</a></div>;
  return (
    <>
      <h1>Clientes</h1>
      {clientes.length === 0 ? <p className="meta">Sin clientes guardados.</p> : clientes.map((c) => (
        <div className="tarjeta" key={c.telefono}>
          <header>
            <span><b><a href={`/clientes/${c.telefono}`}>{c.razonSocial}</a></b></span>
            <span className="meta">{c.rut} · +{c.telefono}</span>
          </header>
        </div>
      ))}
    </>
  );
}
```

`app/clientes/[telefono]/page.tsx`:
```tsx
import { cargarFichaCliente } from '../../../src/lib/vista-clientes.js';
import { fechaCorta } from '../../../src/lib/formato.js';

export const dynamic = 'force-dynamic';

export default async function Ficha({ params }: { params: Promise<{ telefono: string }> }) {
  const { telefono } = await params;
  const ficha = await cargarFichaCliente(telefono);
  if (ficha === null) return <div className="aviso-error">No se pudo cargar desde la base. Reintenta.</div>;
  if (ficha === 'no_existe') return <div className="aviso-error">No hay cliente guardado con ese teléfono.</div>;
  const d = ficha.datos;
  return (
    <>
      <h1>{d.razonSocial}</h1>
      <div className="tarjeta">
        <p>R.U.T. {d.rut} · {d.giro}</p>
        <p className="meta">{d.direccion}, {d.comuna}, {d.ciudad} · {d.email} · +{d.telefono}</p>
      </div>
      <h1>Cotizaciones</h1>
      {ficha.cotizaciones.length === 0 ? <p className="meta">Ninguna.</p> : ficha.cotizaciones.map((q, i) => (
        <div className="tarjeta" key={i}><header><span>N° {q.numero ?? 'S/N'} · {q.totalFmt}</span><span className="meta">{fechaCorta(q.fecha)}</span></header></div>
      ))}
      <h1>Pedidos</h1>
      {ficha.pedidos.length === 0 ? <p className="meta">Ninguno.</p> : ficha.pedidos.map((p, i) => (
        <div className="tarjeta" key={i}><header><span className={`badge ${p.estadoNegocio}`}>{p.estadoNegocio}</span><span className="meta">{fechaCorta(p.fecha)}</span></header></div>
      ))}
    </>
  );
}
```

- [ ] **Step 4: ver pasar + build. Step 5: Commit** — `git add apps/backoffice/src/lib/vista-clientes.ts apps/backoffice/app/clientes apps/backoffice/tests/vista-clientes.test.ts && git commit -m "feat(backoffice): vista de clientes con ficha e historial"`.

---

### Task 10: Vista Salud

**Files:**
- Create: `apps/backoffice/src/lib/salud.ts`, `apps/backoffice/app/salud/page.tsx`
- Test: `apps/backoffice/tests/salud.test.ts`

**Interfaces:**
- Consumes: `supabaseGet`, `RELAY_BASE`.
- Produces: `chequearSalud(ahoraMs: number): Promise<Salud>` con `interface Salud { supabase: boolean; oficina: boolean; rele: boolean; cotizaciones24h: number | null; ocFallidas: number | null }`. Constante `OFICINA_BASE = 'https://api.pyxis-latam.cl/rr/captador-precios'` en `constantes.ts`.

- [ ] **Step 1: pruebas que fallan** (`tests/salud.test.ts`):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { chequearSalud } from '../src/lib/salud.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const AHORA = Date.parse('2026-09-01T20:00:00Z');

// Enruta por URL: oficina responde su 404 de contrato, rele su 404 de
// contrato, supabase devuelve filas.
function stub(opciones: { oficinaStatus?: number; releBody?: string; supabaseCaido?: boolean; oficinaCaida?: boolean } = {}) {
  vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
  vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
  vi.stubGlobal('fetch', vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('pyxis-latam')) {
      if (opciones.oficinaCaida) throw new Error('tunel abajo');
      return new Response('{"error":"not_found"}', { status: opciones.oficinaStatus ?? 404 });
    }
    if (u.includes('rr-mailing')) {
      return new Response(opciones.releBody ?? '{"error":"cotizacion_no_encontrada"}', { status: 404 });
    }
    if (opciones.supabaseCaido) throw new Error('caida');
    return new Response(JSON.stringify([{ quote_id: 'q' }]), { status: 200 });
  }));
}

describe('chequearSalud', () => {
  it('todo verde con la oficina respondiendo su 404 de contrato', async () => {
    stub();
    const salud = await chequearSalud(AHORA);
    expect(salud).toEqual({ supabase: true, oficina: true, rele: true, cotizaciones24h: 1, ocFallidas: 1 });
  });
  it('un 502 del tunel o una caida de red marcan la oficina en rojo', async () => {
    stub({ oficinaStatus: 502 });
    expect((await chequearSalud(AHORA)).oficina).toBe(false);
    stub({ oficinaCaida: true });
    expect((await chequearSalud(AHORA)).oficina).toBe(false);
  });
  it('el rele solo esta vivo si responde SU contrato, no cualquier 404', async () => {
    stub({ releBody: '<html>Not Found</html>' });
    expect((await chequearSalud(AHORA)).rele).toBe(false);
  });
  it('supabase caido: rojo y contadores null, sin reventar', async () => {
    stub({ supabaseCaido: true });
    const salud = await chequearSalud(AHORA);
    expect(salud.supabase).toBe(false);
    expect(salud.cotizaciones24h).toBeNull();
  });
});
```

- [ ] **Step 2: ver fallar. Step 3: implementar**

En `src/lib/constantes.ts` agregar:
```ts
export const OFICINA_BASE = 'https://api.pyxis-latam.cl/rr/captador-precios';
```

`src/lib/salud.ts`:
```ts
import { supabaseGet } from './supabase.js';
import { OFICINA_BASE, RELAY_BASE } from './constantes.js';

export interface Salud {
  supabase: boolean; oficina: boolean; rele: boolean;
  cotizaciones24h: number | null; ocFallidas: number | null;
}

const TIMEOUT_MS = 4000;

// "Vivo" = responde SU contrato, no cualquier cosa: la oficina responde
// 404 {"error":"not_found"} en rutas desconocidas (y 401 si la auth corre
// antes); el rele responde 404 {"error":"cotizacion_no_encontrada"} para un
// UUID inexistente. Un 502/530 del tunel o un HTML de plataforma NO cuentan.
async function ping(url: string, esVivo: (status: number, body: string) => boolean): Promise<boolean> {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(TIMEOUT_MS), cache: 'no-store' });
    return esVivo(r.status, await r.text());
  } catch {
    return false;
  }
}

export async function chequearSalud(ahoraMs: number): Promise<Salud> {
  const hace24h = new Date(ahoraMs - 24 * 3600_000).toISOString();
  const [cots, fallidas, oficina, rele] = await Promise.all([
    supabaseGet(`/cotizaciones?select=quote_id&created_at=gte.${encodeURIComponent(hace24h)}&limit=1000`),
    supabaseGet(`/pedidos?select=po_id&estado=eq.failed&limit=1000`),
    ping(`${OFICINA_BASE}/ping-salud-backoffice`, (status) => status === 404 || status === 401),
    ping(`${RELAY_BASE}/api/cotizacion/00000000-0000-4000-8000-000000000000`,
      (status, body) => status === 404 && body.includes('cotizacion_no_encontrada')),
  ]);
  return {
    supabase: cots !== null && fallidas !== null,
    oficina, rele,
    cotizaciones24h: cots === null ? null : cots.length,
    ocFallidas: fallidas === null ? null : fallidas.length,
  };
}
```

`app/salud/page.tsx`:
```tsx
import { chequearSalud } from '../../src/lib/salud.js';

export const dynamic = 'force-dynamic';

const Punto = ({ ok }: { ok: boolean }) => <span className={`punto ${ok ? 'ok' : 'fallo'}`} />;

export default async function Salud() {
  const salud = await chequearSalud(Date.now());
  return (
    <>
      <h1>Salud</h1>
      <div className="tarjeta semaforo"><Punto ok={salud.supabase} /> Base de datos (Supabase)</div>
      <div className="tarjeta semaforo"><Punto ok={salud.oficina} /> API de precios de la oficina (túnel)</div>
      <div className="tarjeta semaforo"><Punto ok={salud.rele} /> Relé de correo y PDF</div>
      <div className="contadores">
        <div className="contador"><b>{salud.cotizaciones24h ?? '—'}</b><span>cotizaciones últimas 24 h</span></div>
        <div className="contador"><b>{salud.ocFallidas ?? '—'}</b><span>OC con correo fallido</span></div>
      </div>
      <p className="meta"><a href="/salud">Volver a chequear</a></p>
    </>
  );
}
```

- [ ] **Step 4: ver pasar + build. Step 5: Commit** — `git add apps/backoffice/src/lib apps/backoffice/app/salud apps/backoffice/tests/salud.test.ts && git commit -m "feat(backoffice): semaforo de salud"`.

---

### Task 11: README, verificación completa y despliegue

**Files:**
- Create: `apps/backoffice/README.md`
- Modify: nada más (el deploy es un paso del usuario)

- [ ] **Step 1: README** con el runbook:

```markdown
# Backoffice interno (rr-backoffice)

Dashboard de operación: pedidos (nuevo → pagado → entregado), cotizaciones,
clientes y salud. Spec: `docs/superpowers/specs/2026-09-01-backoffice-design.md`.

## Variables (proyecto Vercel rr-backoffice)

| Variable | Qué es |
|---|---|
| `SUPABASE_URL` | la misma del relé |
| `SUPABASE_SERVICE_KEY` | la misma del relé (service_role) |
| `BACKOFFICE_PASSWORD` | la clave compartida del local |
| `BACKOFFICE_SESSION_SECRET` | cadena aleatoria larga (firma las cookies; rotarla cierra todas las sesiones) |

## Antes del primer deploy

1. Pegar `docs/sql/2026-09-01-estado-negocio.sql` en el SQL Editor de Supabase.
2. Crear el proyecto Vercel con Root Directory `apps/backoffice` y cargar las
   4 variables.
3. Deploy desde la RAÍZ del repo (el build necesita los workspaces):
   `VERCEL_ORG_ID=<org> VERCEL_PROJECT_ID=<prj> npx vercel --prod --yes`
   (ids en `apps/backoffice/.vercel/project.json` tras el primer `vercel link`).

## Desarrollo local

`npm run dev -w @rr/backoffice` con las 4 variables en `apps/backoffice/.env.local`.
```

- [ ] **Step 2: suite completa y typecheck** — `npm test` y `npm run typecheck` desde la raíz, verdes.

- [ ] **Step 3: pasos del usuario** (el ejecutor los pide, no los corre: los deploys los bloquea el clasificador):
  - Pegar el SQL en Supabase.
  - Crear/linkear el proyecto `rr-backoffice` en Vercel (Root Directory `apps/backoffice`), cargar las 4 env vars.
  - `npx vercel --prod --yes` con los IDs del proyecto, desde la raíz.

- [ ] **Step 4: verificación de punta a punta** (con el usuario):
  1. Login desde teléfono y escritorio; clave mala rebota con mensaje.
  2. La portada muestra los pedidos reales; marcar `pagado` sube el contador "pagados por entregar"; `entregado` lo baja.
  3. Los links de PDF (cotización y OC) abren los documentos del relé.
  4. `/salud` en verde con la oficina arriba.
  5. Sin cookie (ventana incógnita) todo redirige a `/login`.

- [ ] **Step 5: Commit final** — `git add apps/backoffice/README.md && git commit -m "docs(backoffice): runbook de deploy"`.
