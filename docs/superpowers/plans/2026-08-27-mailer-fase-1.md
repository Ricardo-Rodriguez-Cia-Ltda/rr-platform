# Envío de correo propio, fase 1 — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Sacar a Resend del camino: las órdenes de compra internas se envían por un relé propio en Vercel que habla SMTP con Gmail.

**Architecture:** `packages/mailer` guarda la interfaz de envío y una implementación sobre nodemailer. `apps/mailer` la expone como `POST /api/send`, autenticado con `x-api-key` y con lista blanca de destinatarios. La function de Kapso —un Cloudflare Worker, que no puede hablar SMTP— deja de llamar a Resend y llama a ese endpoint por HTTPS.

**Tech Stack:** TypeScript con `moduleResolution: NodeNext`, nodemailer, Vercel Functions (runtime Node), vitest, npm workspaces.

**Spec:** `docs/superpowers/specs/2026-08-27-mailer-fase-1-design.md`

## Global Constraints

- **La lista blanca de destinatarios es un requisito, no una mejora.** Un endpoint de envío protegido solo por una clave es, si esa clave se filtra, un relé de spam a nombre de la cuenta de Gmail — y Google la suspende. El endpoint rechaza cualquier `to` que no esté en `MAILER_ALLOWED_RECIPIENTS`, y lo rechaza **antes** de llamar al transporte.
- **Ninguna respuesta ni ningún log puede contener la contraseña de aplicación**, ni el error crudo del transporte si la incluye.
- **El cambio en el Worker es solo el bloque del `fetch`.** La agrupación por mayorista, la reserva idempotente en D1, la reconstrucción del costo, el fallo parcial y el guard de vigencia no se tocan.
- Nombres de archivo e identificadores en **inglés**; comentarios y documentación en **español** (ver `CONTRIBUTING.md`).
- **Imports relativos con extensión `.js`**; imports de paquete sin extensión.
- Paquetes: `@rr/mailer`. Cada `package.json` **declara sus dependencias** — npm enlaza los workspaces igual, pero sin declararlas el grafo no es verificable.
- La suite tiene 671 pruebas hoy; las nuevas se suman y todas quedan verdes.
- `npm run typecheck` limpio.
- **Nunca `git add -A`**: hay carpetas sin trackear en la raíz que son del usuario.

## Prerrequisitos humanos

Dos cosas que el implementador no puede hacer solo. Pídelas antes de empezar la Task 3:

1. **Contraseña de aplicación de Gmail.** En la cuenta que enviará: activar verificación en dos pasos, y luego crear una contraseña de aplicación en `myaccount.google.com/apppasswords`. Son 16 caracteres. La cuenta de Gmail normal permite 500 envíos al día.
2. **Proyecto nuevo en Vercel** apuntando a este repositorio, con **Root Directory** `apps/mailer` y el interruptor **"Include files outside the root directory in the Build Step"** activado — `apps/mailer` importa `@rr/mailer`, que vive fuera de su directorio.

---

## Estructura de archivos

```
packages/mailer/
  src/index.ts          # la interfaz y createMailer
  src/gmail.ts          # createGmailTransport (nodemailer)
  tests/mailer.test.ts
  package.json
packages/http/
  src/auth.ts           # isAuthorized, movido desde apps/pricing-api
  tests/auth.test.ts
  package.json
apps/mailer/
  api/send.ts           # la ruta, delgada
  src/send.ts           # la lógica, testeable
  tests/send.test.ts
  package.json
  vercel.json
```

`isAuthorized` se mueve a `packages/http` porque a partir de esta fase tiene dos consumidores, que es exactamente lo que `CONTRIBUTING.md` pone como condición para extraer un paquete. Duplicar ocho líneas de comparación de credenciales en dos apps es la alternativa, y es peor.

---

### Task 1: `packages/mailer`

**Files:**
- Create: `packages/mailer/package.json`, `packages/mailer/src/index.ts`, `packages/mailer/src/gmail.ts`
- Test: `packages/mailer/tests/mailer.test.ts`
- Modify: `package-lock.json` (al instalar nodemailer)

**Interfaces:**
- Consumes: nada.
- Produces: `Message` (`{ to, subject, html, text }`, todos `string`), `SendResult` (`{ id: string }`), `Mailer` (`{ send(message: Message): Promise<SendResult> }`), `createMailer(transport: Transport, from: string): Mailer` y `createGmailTransport(config: { user: string; appPassword: string }): Transport`. La Task 3 los consume.

La separación entre `createMailer` y `createGmailTransport` es lo que hace testeable el paquete sin red: las pruebas inyectan un transporte falso.

- [ ] **Step 1: Instalar nodemailer**

```bash
npm install nodemailer --workspace @rr/mailer
npm install --save-dev @types/nodemailer --workspace @rr/mailer
```

Requiere que `packages/mailer/package.json` exista antes; créalo primero:

```json
{
  "name": "@rr/mailer",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./*": "./src/*.ts"
  }
}
```

Nota: nodemailer es la primera dependencia de producción del repositorio — hasta ahora `package.json` solo tenía `devDependencies`.

- [ ] **Step 2: Escribir las pruebas que fallan**

`packages/mailer/tests/mailer.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { createMailer } from '@rr/mailer';

describe('createMailer', () => {
  it('arma el mensaje con el remitente configurado', async () => {
    const sendMail = vi.fn(async () => ({ messageId: '<abc@gmail.com>' }));
    const mailer = createMailer({ sendMail }, 'ordenes@ejemplo.cl');

    await mailer.send({
      to: 'destino@ejemplo.cl',
      subject: 'Asunto',
      html: '<p>hola</p>',
      text: 'hola',
    });

    expect(sendMail).toHaveBeenCalledWith({
      from: 'ordenes@ejemplo.cl',
      to: 'destino@ejemplo.cl',
      subject: 'Asunto',
      html: '<p>hola</p>',
      text: 'hola',
    });
  });

  it('devuelve el messageId del transporte', async () => {
    const mailer = createMailer(
      { sendMail: async () => ({ messageId: '<xyz@gmail.com>' }) },
      'ordenes@ejemplo.cl',
    );
    const result = await mailer.send({ to: 'a@b.cl', subject: 's', html: 'h', text: 't' });
    expect(result).toEqual({ id: '<xyz@gmail.com>' });
  });

  it('propaga el error del transporte', async () => {
    const mailer = createMailer(
      { sendMail: async () => { throw new Error('535 autenticacion rechazada'); } },
      'ordenes@ejemplo.cl',
    );
    await expect(mailer.send({ to: 'a@b.cl', subject: 's', html: 'h', text: 't' }))
      .rejects.toThrow('535 autenticacion rechazada');
  });
});
```

- [ ] **Step 3: Correr y verificar que fallan**

Run: `npx vitest run packages/mailer/tests/mailer.test.ts`
Expected: FAIL — no existe `@rr/mailer`.

- [ ] **Step 4: Escribir el paquete**

`packages/mailer/src/index.ts`:

```ts
export interface Message {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendResult {
  id: string;
}

export interface Mailer {
  send(message: Message): Promise<SendResult>;
}

// Lo mínimo que este paquete necesita de nodemailer. Tenerlo como interfaz
// propia es lo que permite probar sin red y cambiar de transporte sin tocar
// a quien llama.
export interface Transport {
  sendMail(options: {
    from: string;
    to: string;
    subject: string;
    html: string;
    text: string;
  }): Promise<{ messageId: string }>;
}

export function createMailer(transport: Transport, from: string): Mailer {
  return {
    async send(message: Message): Promise<SendResult> {
      const info = await transport.sendMail({ from, ...message });
      return { id: info.messageId };
    },
  };
}

export { createGmailTransport } from './gmail.js';
```

`packages/mailer/src/gmail.ts`:

```ts
import nodemailer from 'nodemailer';
import type { Transport } from './index.js';

// Puerto 465 con TLS directo. El 587 tambien sirve, pero exige STARTTLS y da
// un modo de falla mas: negociar en claro y quedarse ahi.
export function createGmailTransport(config: { user: string; appPassword: string }): Transport {
  return nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: config.user, pass: config.appPassword },
  });
}
```

- [ ] **Step 5: Correr y verificar que pasan**

Run: `npx vitest run packages/mailer/tests/mailer.test.ts`
Expected: PASS, 3 pruebas.

- [ ] **Step 6: Verificar todo**

```bash
npm run typecheck
npm test
```
Expected: typecheck limpio, 674 pruebas verdes (671 + 3).

- [ ] **Step 7: Commit**

```bash
git add packages/mailer package.json package-lock.json
git commit -m "feat(mailer): interfaz de envio y transporte de Gmail"
```

---

### Task 2: `packages/http` y el endpoint de `apps/mailer`

**Files:**
- Create: `packages/http/package.json`, `packages/http/src/auth.ts`, `packages/http/tests/auth.test.ts`
- Move: `apps/pricing-api/src/auth.ts` → `packages/http/src/auth.ts`; `apps/pricing-api/tests/auth.test.ts` → `packages/http/tests/auth.test.ts`
- Create: `apps/mailer/package.json`, `apps/mailer/vercel.json`, `apps/mailer/src/send.ts`, `apps/mailer/api/send.ts`
- Test: `apps/mailer/tests/send.test.ts`
- Modify: los archivos de `apps/pricing-api` que importan `isAuthorized`

**Interfaces:**
- Consumes: `Mailer` y `Message` de `@rr/mailer` (Task 1).
- Produces: `createSendHandler(deps)` desde `apps/mailer/src/send.ts`, donde `deps` es `{ mailer: Mailer; apiKey: string; allowedRecipients: string[] }`, y devuelve un handler con la firma de Vercel. La Task 3 lo despliega; la Task 4 le pega desde el Worker.

- [ ] **Step 1: Mover `isAuthorized` a un paquete**

Tiene dos consumidores desde esta fase, que es la condición que `CONTRIBUTING.md` pone para extraer.

`packages/http/package.json`:

```json
{
  "name": "@rr/http",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./*": "./src/*.ts"
  }
}
```

```bash
mkdir -p packages/http/src packages/http/tests
git mv apps/pricing-api/src/auth.ts   packages/http/src/auth.ts
git mv apps/pricing-api/tests/auth.test.ts packages/http/tests/auth.test.ts
```

Actualiza el import de la prueba a `@rr/http/auth`, y en `apps/pricing-api` cambia cada `from '../src/auth.js'` (y variantes) por `from '@rr/http/auth'`. Encuéntralos con:

Run: `grep -rn "auth.js" --include="*.ts" apps/pricing-api`

Declara la dependencia en `apps/pricing-api/package.json`: `"@rr/http": "*"`.

Y antes de dar el paso por bueno, confirma que `tests/docs.test.ts` no leía el archivo movido — lee varios por ruta y revienta la suite entera al cargar si una queda mal:

Run: `grep -n "auth" tests/docs.test.ts`
Expected: sin salida. Si aparece algo, actualiza esa ruta en el mismo commit.

- [ ] **Step 2: Verificar que el movimiento no rompió nada**

```bash
npm install
npm run typecheck
npm test
```
Expected: 674 verdes, ni una menos.

- [ ] **Step 3: Escribir las pruebas del endpoint**

`apps/mailer/tests/send.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createSendHandler } from '../src/send.js';

function fakeRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
  };
  return res as unknown as VercelResponse & { statusCode: number; body: any };
}

function req(overrides: Partial<VercelRequest> = {}): VercelRequest {
  return {
    method: 'POST',
    headers: { 'x-api-key': 'clave-buena' },
    body: { to: 'interno@ejemplo.cl', subject: 's', html: '<p>h</p>', text: 't' },
    ...overrides,
  } as VercelRequest;
}

const deps = (send = vi.fn(async () => ({ id: '<abc>' }))) => ({
  mailer: { send },
  apiKey: 'clave-buena',
  allowedRecipients: ['interno@ejemplo.cl'],
});

describe('POST /api/send', () => {
  it('envia y devuelve el id', async () => {
    const send = vi.fn(async () => ({ id: '<abc>' }));
    const res = fakeRes();
    await createSendHandler(deps(send))(req(), res);
    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual({ ok: true, id: '<abc>' });
    expect(send).toHaveBeenCalledOnce();
  });

  it('rechaza sin clave', async () => {
    const send = vi.fn();
    const res = fakeRes();
    await createSendHandler(deps(send))(req({ headers: {} }), res);
    expect(res.statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('rechaza con clave incorrecta', async () => {
    const send = vi.fn();
    const res = fakeRes();
    await createSendHandler(deps(send))(req({ headers: { 'x-api-key': 'otra' } }), res);
    expect(res.statusCode).toBe(401);
    expect(send).not.toHaveBeenCalled();
  });

  it('rechaza un destinatario fuera de la lista SIN llamar al transporte', async () => {
    const send = vi.fn();
    const res = fakeRes();
    await createSendHandler(deps(send))(
      req({ body: { to: 'ajeno@spam.cl', subject: 's', html: 'h', text: 't' } }),
      res,
    );
    expect(res.statusCode).toBe(403);
    expect(res.body).toEqual({ ok: false, error: 'destinatario_no_permitido' });
    // Lo que importa: la lista blanca corta ANTES de enviar, no despues.
    expect(send).not.toHaveBeenCalled();
  });

  it('rechaza un cuerpo incompleto', async () => {
    const send = vi.fn();
    const res = fakeRes();
    await createSendHandler(deps(send))(
      req({ body: { to: 'interno@ejemplo.cl', subject: 's' } }),
      res,
    );
    expect(res.statusCode).toBe(400);
    expect(send).not.toHaveBeenCalled();
  });

  it('rechaza metodos que no son POST', async () => {
    const res = fakeRes();
    await createSendHandler(deps())(req({ method: 'GET' }), res);
    expect(res.statusCode).toBe(405);
  });

  it('traduce el fallo del transporte a 502 sin filtrar la credencial', async () => {
    const send = vi.fn(async () => {
      throw new Error('535 rechazado para user=x pass=SECRETO123');
    });
    const res = fakeRes();
    await createSendHandler(deps(send))(req(), res);
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('SECRETO123');
  });
});
```

- [ ] **Step 4: Correr y verificar que fallan**

Run: `npx vitest run apps/mailer/tests/send.test.ts`
Expected: FAIL — no existe `../src/send.js`.

- [ ] **Step 5: Escribir la app**

`apps/mailer/package.json` — el nombre lleva sufijo porque `@rr/mailer` ya lo ocupa el paquete, y npm exige nombres únicos dentro del workspace:

```json
{
  "name": "@rr/mailer-app",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "dependencies": {
    "@rr/mailer": "*",
    "@rr/http": "*"
  }
}
```

`apps/mailer/vercel.json`:

```json
{
  "functions": {
    "api/**/*.ts": {
      "maxDuration": 30
    }
  }
}
```

`apps/mailer/src/send.ts`:

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '@rr/http/auth';
import type { Mailer } from '@rr/mailer';

export interface SendDeps {
  mailer: Mailer;
  apiKey: string;
  allowedRecipients: string[];
}

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function readMessage(body: unknown): { to: string; subject: string; html: string; text: string } | null {
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;
  const fields = ['to', 'subject', 'html', 'text'] as const;
  for (const field of fields) {
    if (typeof raw[field] !== 'string' || raw[field] === '') return null;
  }
  return {
    to: raw.to as string,
    subject: raw.subject as string,
    html: raw.html as string,
    text: raw.text as string,
  };
}

export function createSendHandler(deps: SendDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'metodo_no_permitido' });
      return;
    }

    if (!isAuthorized(firstString(req.headers['x-api-key']), deps.apiKey)) {
      res.status(401).json({ ok: false, error: 'no_autorizado' });
      return;
    }

    const message = readMessage(req.body);
    if (!message) {
      res.status(400).json({ ok: false, error: 'cuerpo_invalido' });
      return;
    }

    // La lista blanca corta antes de enviar. Un endpoint de envio autenticado
    // solo por una clave es, si esa clave se filtra, un rele de spam a nombre
    // de nuestra cuenta.
    if (!deps.allowedRecipients.includes(message.to)) {
      res.status(403).json({ ok: false, error: 'destinatario_no_permitido' });
      return;
    }

    try {
      const result = await deps.mailer.send(message);
      res.status(200).json({ ok: true, id: result.id });
    } catch (_error) {
      // El error del transporte puede traer la credencial. No se propaga.
      res.status(502).json({ ok: false, error: 'el_envio_fallo' });
    }
  };
}
```

`apps/mailer/api/send.ts`:

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createMailer, createGmailTransport } from '@rr/mailer';
import { createSendHandler } from '../src/send.js';

const REQUIRED = ['MAILER_API_KEY', 'GMAIL_USER', 'GMAIL_APP_PASSWORD', 'MAILER_FROM', 'MAILER_ALLOWED_RECIPIENTS'];

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const missing = REQUIRED.filter((name) => !process.env[name]);
  if (missing.length > 0) {
    // Se nombran las que faltan; nunca sus valores.
    res.status(500).json({ ok: false, error: 'falta_configuracion', faltan: missing });
    return;
  }

  const transport = createGmailTransport({
    user: process.env.GMAIL_USER as string,
    appPassword: process.env.GMAIL_APP_PASSWORD as string,
  });

  return createSendHandler({
    mailer: createMailer(transport, process.env.MAILER_FROM as string),
    apiKey: process.env.MAILER_API_KEY as string,
    allowedRecipients: (process.env.MAILER_ALLOWED_RECIPIENTS as string)
      .split(',')
      .map((address) => address.trim())
      .filter(Boolean),
  })(req, res);
}
```

- [ ] **Step 6: Correr y verificar que pasan**

Run: `npx vitest run apps/mailer/tests/send.test.ts`
Expected: PASS, 7 pruebas.

- [ ] **Step 7: Verificar todo**

```bash
npm run typecheck
npm test
```
Expected: 681 verdes (674 + 7).

- [ ] **Step 8: Commit**

```bash
git add packages/http apps/mailer apps/pricing-api package.json package-lock.json
git commit -m "feat(mailer): endpoint de envio con lista blanca; auth compartido en @rr/http"
```

---

### Task 3: Desplegar y probar que Vercel deja abrir SMTP

**Files:** ninguno de código. Esta tarea despliega y verifica.

**Interfaces:**
- Consumes: `apps/mailer` (Task 2).
- Produces: la URL del endpoint desplegado, que la Task 4 usa como `MAILER_URL`.

Esta es la tarea que el diseño pone primero en importancia: **todo el enfoque cuelga de que una función de Vercel pueda abrir SMTP hacia `smtp.gmail.com`**. La documentación de límites de Vercel no lista puertos de salida bloqueados y declara cobertura completa de Node, pero eso es una señal, no una prueba.

Y es también el criterio de aceptación del MVP: que llegue un correo.

- [ ] **Step 1: Confirmar los prerrequisitos humanos**

Antes de seguir necesitas, del humano: la contraseña de aplicación de Gmail, la cuenta que envía, la dirección interna de destino, y el proyecto de Vercel ya creado con Root Directory `apps/mailer` y el interruptor de incluir archivos fuera del root activado.

Si falta alguno, **para y pídelo**. No inventes credenciales ni despliegues a un proyecto que no es.

- [ ] **Step 2: Cargar las variables de entorno en Vercel**

En el proyecto de Vercel, Settings → Environment Variables, para Production y Preview:

| Variable | Valor |
|---|---|
| `MAILER_API_KEY` | una clave larga generada al azar (`openssl rand -hex 32`) |
| `GMAIL_USER` | la cuenta que envía |
| `GMAIL_APP_PASSWORD` | la contraseña de aplicación, sin espacios |
| `MAILER_FROM` | el remitente, normalmente igual a `GMAIL_USER` |
| `MAILER_ALLOWED_RECIPIENTS` | la dirección interna de destino |

Anota la `MAILER_API_KEY` para la Task 4. **No la escribas en el reporte ni en ningún archivo del repositorio.**

- [ ] **Step 3: Desplegar**

Run: `npx vercel --prod --cwd apps/mailer`
Expected: una URL de producción. Anótala.

- [ ] **Step 4: La prueba que responde la pregunta**

```bash
curl -s -X POST "https://<url>/api/send" \
  -H "x-api-key: $MAILER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"to":"<direccion interna>","subject":"Prueba del relé","html":"<p>Funciona.</p>","text":"Funciona."}' \
  -w "\nHTTP %{http_code}\n"
```

Expected: `HTTP 200` y `{"ok":true,"id":"<...>"}`, **y el correo en la bandeja de entrada**. Revisa también spam: si llegó ahí, el envío funciona y lo que falla es la reputación del remitente, que es un problema distinto y de la fase 2.

- [ ] **Step 5: Comprobar que la lista blanca funciona en producción**

```bash
curl -s -X POST "https://<url>/api/send" \
  -H "x-api-key: $MAILER_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"to":"ajeno@example.com","subject":"x","html":"x","text":"x"}' \
  -w "\nHTTP %{http_code}\n"
```

Expected: `HTTP 403` y `destinatario_no_permitido`. Si esto envía algo, para todo: el endpoint es un relé abierto.

- [ ] **Step 6: Si el SMTP falla**

Si el paso 4 devuelve 502 y los logs (`npx vercel logs <url>`) muestran un timeout o una conexión rechazada hacia `smtp.gmail.com`, **el supuesto era falso**. Para y repórtalo con el error exacto. La salida documentada es cambiar `createGmailTransport` por una implementación sobre la API de Gmail por HTTPS, sin tocar `createMailer` ni el endpoint — pero esa decisión es del controlador, no tuya.

- [ ] **Step 7: Dejar registro**

Sin commit de código. En el reporte: la URL, el resultado de los pasos 4 y 5, y si el correo llegó a bandeja de entrada o a spam.

---

### Task 4: El Worker deja de usar Resend

**Files:**
- Modify: `apps/kapso-agent/functions/emitir-ordenes-compra.js`
- Modify: `apps/kapso-agent/tests/emitir-ordenes-compra.test.ts`
- Modify: `apps/kapso-agent/scripts/deploy-functions.ts` (la lista de secretos de esa function)

**Interfaces:**
- Consumes: la URL desplegada y la `MAILER_API_KEY` de la Task 3.
- Produces: la function desplegada llamando al relé.

- [ ] **Step 1: Ajustar las pruebas al nuevo destino**

En `apps/kapso-agent/tests/emitir-ordenes-compra.test.ts`, el entorno falso cambia:

```ts
const env = () => ({
  MARGEN: '0.13',
  MAILER_URL: 'https://mailer.test/api/send',
  MAILER_API_KEY: 'clave',
  OC_EMAIL_DESTINO: 'pyxis.latam@gmail.com',
  DB: faseD1().db,
});
```

Y agrega una prueba que fija el contrato con el relé:

```ts
it('llama al rele con la clave y el cuerpo esperado', async () => {
  const spy = resendOk();   // el stub de fetch que ya existe
  await handler(peticion({ execution_context: { vars: vars() } }), env());
  const [url, init] = spy.mock.calls[0] as [string, RequestInit];
  expect(url).toBe('https://mailer.test/api/send');
  expect((init.headers as Record<string, string>)['x-api-key']).toBe('clave');
  const cuerpo = JSON.parse(String(init.body));
  expect(Object.keys(cuerpo).sort()).toEqual(['html', 'subject', 'text', 'to']);
});
```

Los demás casos —agrupación por mayorista, idempotencia, fallo parcial, reintento, vigencia, `quote_confirmed`— **no cambian**: ninguno depende de quién sea el transporte. Si alguno se rompe, es señal de que tocaste algo que no debías.

- [ ] **Step 2: Correr y verificar que fallan**

Run: `npx vitest run apps/kapso-agent/tests/emitir-ordenes-compra.test.ts`
Expected: FAIL — el código sigue apuntando a Resend.

- [ ] **Step 3: Cambiar el bloque del envío**

En `emitir-ordenes-compra.js`, las lecturas de configuración pasan de:

```js
const apiKey = env.RESEND_API_KEY;
const from = env.RESEND_FROM_EMAIL;
```

a:

```js
const mailerUrl = env.MAILER_URL;
const mailerKey = env.MAILER_API_KEY;
```

El guard correspondiente cambia su mensaje a `"Faltan MAILER_URL o MAILER_API_KEY."`, y la llamada:

```js
const response = await fetch(mailerUrl, {
  method: "POST",
  headers: { "x-api-key": mailerKey, "Content-Type": "application/json" },
  body: JSON.stringify({ to: destino, subject, html, text })
});
```

`subject`, `html` y `text` son los mismos que ya construye. **No toques nada más**: ni la agrupación, ni el `INSERT` idempotente, ni la reconstrucción del costo, ni el manejo de fallo parcial, ni el guard de vigencia.

- [ ] **Step 4: Correr y verificar que pasan**

```bash
npx vitest run apps/kapso-agent/tests/emitir-ordenes-compra.test.ts
npm run typecheck
npm test
```
Expected: 682 verdes (681 + 1).

- [ ] **Step 5: Actualizar el script de despliegue**

En `apps/kapso-agent/scripts/deploy-functions.ts`, la entrada de `emitir-ordenes-compra` cambia sus secretos de `RESEND_API_KEY`, `RESEND_FROM_EMAIL` a `MAILER_URL`, `MAILER_API_KEY`, y `VALUES` los toma de `process.env`.

- [ ] **Step 6: Commit**

```bash
git add apps/kapso-agent
git commit -m "feat(kapso-v2): emitir ordenes por el rele propio en vez de Resend"
```

- [ ] **Step 7: Desplegar y cargar los secretos**

```bash
MAILER_URL="https://<url>/api/send" MAILER_API_KEY="<la clave>" npm run kapso:functions
```

Expected: las seis functions actualizadas y los dos secretos nuevos cargados en `emitir-ordenes-compra`, sin pendientes.

Límites: no toques functions de v1, no actives ni borres nada.

- [ ] **Step 8: La verificación real**

Invoca `emitir-ordenes-compra` con la cotización de prueba de dos mayoristas que documenta `apps/kapso-agent/README.md`. Expected: `purchase_orders_count: 2`, ambas `sent`, y **dos correos** en la casilla interna — uno con los SKU de Ingram, otro con los de Tecnoglobal.

Repite la misma invocación: no debe llegar ningún correo y las dos órdenes vuelven como `duplicate`.

---

### Task 5: Documentación y limpieza

**Files:**
- Create: `apps/mailer/README.md`
- Modify: `apps/kapso-agent/README.md`, `README.md`, `CONTRIBUTING.md`

- [ ] **Step 1: `apps/mailer/README.md`**

Qué es, las cinco variables de entorno y de dónde sale cada una, cómo se despliega, y —lo que un operador necesita a las 3 de la mañana— qué significa cada código de respuesta y qué hacer con él. Incluye que la lista blanca es deliberada y por qué, para que nadie la "arregle".

- [ ] **Step 2: Sacar Resend de la documentación**

Run: `grep -rniI "resend" --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=.superpowers . | grep -v "docs/superpowers/"`

Cada resultado fuera de los registros históricos de `docs/superpowers/` se actualiza al relé. Los planes y specs viejos **no se tocan**: son registros de lo que se decidió entonces.

- [ ] **Step 3: Anotar el paquete nuevo en `CONTRIBUTING.md`**

`packages/mailer` se creó con un solo consumidor, contra la regla del propio documento. Deja escrito por qué —el segundo consumidor es la fase 2— y qué hacer si esa fase se cancela: fundirlo dentro de `apps/mailer`. Una regla con una excepción sin explicar es una regla que se erosiona.

- [ ] **Step 4: Verificar y commitear**

```bash
npm test
git add apps/mailer/README.md apps/kapso-agent/README.md README.md CONTRIBUTING.md
git commit -m "docs(mailer): operacion del rele y salida de Resend"
```

---

## Verificación final

```bash
npm test          # 682, ni una menos
npm run typecheck
```

Y contra los servicios:

- `POST /api/send` con destinatario permitido → 200 y correo recibido.
- `POST /api/send` con destinatario ajeno → 403 y **nada enviado**.
- `emitir-ordenes-compra` con dos mayoristas → dos correos; segunda invocación → ninguno.
