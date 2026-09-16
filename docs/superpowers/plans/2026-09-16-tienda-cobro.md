# La tienda cobra con Mercado Pago — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que la tienda web deje de emitir órdenes de compra al confirmar y, en su lugar, mande al cliente a pagar con Mercado Pago; la emisión ocurre en el webhook del relé cuando el pago se acredita, y la página del pedido muestra el estado real del pago.

**Architecture:** `apps/tienda` sigue cotizando en vivo vía Kapso, pero el paso 3 de `/api/confirmar` pasa de `emitir-ordenes-compra` a `POST <relé>/api/pago/crear` con `origen: 'tienda'`. El relé (`apps/mailer`) aprende ese origen para devolver al cliente a `/pedido/{quote_id}` en la tienda y gana `GET /api/pago/estado/{quote_id}`, público por URL de capacidad, que la página del pedido consulta. El webhook no cambia.

**Tech Stack:** TypeScript, Vercel Functions (`@vercel/node`) en el relé, Next.js App Router en la tienda, PostgREST (Supabase), vitest (config raíz), `fetch` nativo con `AbortSignal.timeout`.

**Spec:** `docs/superpowers/specs/2026-09-16-tienda-cobro-design.md`

## Global Constraints

- **Ninguna credencial viaja al navegador ni a los logs.** `MAILER_API_KEY` solo se usa server-side en la tienda; los logs registran etapa y tipo de fallo, nunca cuerpos ni claves (patrón de `apps/tienda/src/lib/kapso.ts`).
- **El webhook (`apps/mailer/src/pago/webhook.ts`) no se toca.** Los avisos por WhatsApp a un pago sin `phone_number_id` ya son no-op en `apps/mailer/src/pago/kapso.ts:111`; no "arreglarlo".
- **`GET /api/pago/estado` es una lista blanca de campos:** `estado`, `monto_clp`, `intentos_rechazados`, `expira_at` y `init_point` (solo pendiente y vigente). Nunca `telefono`, `datos`, `preference_id`, `mp_payment_id`.
- **Textos al cliente:** ninguno afirma algo que el estado no haya verificado. Copiar los textos de este plan tal cual.
- **Todas las rutas bajo `apps/mailer/api/pago/` declaran `export const maxDuration = 300`** (lo verifica `apps/mailer/tests/pago-webhook.test.ts`, «techo de ejecucion de las rutas de pago»).
- **En la tienda, `maxDuration` va como segment config de Next en cada route, nunca en `vercel.json`.**
- Identificadores en inglés o español según el archivo vecino; comentarios y textos en español. **Nunca `git add -A`** (hay directorios sin trackear del usuario: `contexto Ingram/`, `contexto tecnoglobal/`, `idea pdf/`).
- Comandos: `npm test -- apps/mailer` / `npm test -- apps/tienda` para una app, `npm test` para todo, `npm run typecheck` al final de cada tarea que toque TypeScript de la tienda (su `tsconfig` es aparte).
- Rama de trabajo: `feat/tienda-cobro` (ya existe, con el spec commiteado).
- Formato de commit: `tipo(ámbito): resumen en español`, cuerpo opcional, y al final:
  ```
  Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_01J7y5Gwq3TLS15XPxYuiPCs
  ```

---

## Mapa de archivos

| Archivo | Responsabilidad | Tarea |
|---|---|---|
| `apps/mailer/src/pago/mercadopago.ts` | `construirPreferencia` acepta `retornoUrl` opcional | 1 |
| `apps/mailer/src/pago/crear.ts` | Lee `origen`, exige `TIENDA_BASE_URL` con `tienda`, guarda `datos.origen` | 2 |
| `apps/mailer/src/pago/estado.ts` (nuevo) | `proyectarEstado` + `createEstadoHandler` | 3 |
| `apps/mailer/api/pago/estado/[id].ts` (nuevo) | Envoltorio fino de Vercel | 3 |
| `apps/mailer/tests/pago-webhook.test.ts` | El test del techo recorre subdirectorios | 3 |
| `apps/mailer/README.md` | Ruta y variable nuevas | 3 |
| `apps/tienda/src/lib/pedido.ts` | `armarCuerpoCrearPago` reemplaza `armarPayloadEmision` | 4 |
| `apps/tienda/src/lib/relay.ts` (nuevo) | `crearPago` contra el relé | 5 |
| `apps/tienda/app/api/confirmar/route.ts` | Paso 3: crear pago; `maxDuration = 60` | 6 |
| `apps/tienda/app/carro/Checkout.tsx` | Redirige a `initPoint`; sin `bloqueado` | 7 |
| `apps/tienda/src/lib/pago.ts` (nuevo) | `describirPago`: estado → texto | 8 |
| `apps/tienda/app/pedido/[id]/Resumen.tsx` | Consulta el estado y lo dibuja | 9 |
| `apps/tienda/README.md` | Variables y flujo | 9 |

---

### Task 1: `construirPreferencia` acepta la URL de retorno

**Files:**
- Modify: `apps/mailer/src/pago/mercadopago.ts:9-17` (interfaz) y `:48-51` (cuerpo de `construirPreferencia`)
- Test: `apps/mailer/tests/pago-mercadopago.test.ts`

**Interfaces:**
- Consumes: nada nuevo.
- Produces: `DatosPreferencia.retornoUrl?: string`. Si viene, las tres `back_urls` la usan tal cual; si no, se deriva `${baseUrl}/api/pago/retorno` como hoy. `notification_url` sigue saliendo de `baseUrl` siempre.

- [ ] **Step 1: Escribir la prueba que falla**

En `apps/mailer/tests/pago-mercadopago.test.ts`, dentro de `describe('construirPreferencia', …)`, después del test `'apunta el webhook y el retorno a nuestra base'`:

```ts
  it('con retornoUrl, las tres back_urls la usan y el webhook sigue siendo nuestro', () => {
    const retorno = `https://drcomputacion.cl/pedido/${BASE.quoteId}`;
    const p: any = construirPreferencia({ ...BASE, retornoUrl: retorno });
    expect(p.back_urls).toEqual({ success: retorno, failure: retorno, pending: retorno });
    expect(p.notification_url).toBe('https://rr-mailing.vercel.app/api/pago/webhook');
  });
```

- [ ] **Step 2: Correr la prueba y verla fallar**

Run: `npm test -- apps/mailer/tests/pago-mercadopago.test.ts`
Expected: FAIL en el test nuevo: `back_urls.success` es `https://rr-mailing.vercel.app/api/pago/retorno`, no la URL de la tienda.

- [ ] **Step 3: Implementar**

En `apps/mailer/src/pago/mercadopago.ts`, la interfaz queda:

```ts
export interface DatosPreferencia {
  quoteId: string;
  numero: number | null;
  montoClp: number;
  nombre: string;
  email: string;
  baseUrl: string;
  validUntil: string;
  // A donde vuelve el cliente al salir del checkout. El bot no la manda y cae
  // a la pagina "vuelve a WhatsApp" del rele; la tienda manda su pagina del
  // pedido. El webhook NO depende de esto: siempre es el nuestro.
  retornoUrl?: string;
}
```

Y en `construirPreferencia`, reemplazar la línea `const retorno = \`${base}/api/pago/retorno\`;` por:

```ts
  const retorno = p.retornoUrl ?? `${base}/api/pago/retorno`;
```

- [ ] **Step 4: Correr las pruebas y verlas pasar**

Run: `npm test -- apps/mailer/tests/pago-mercadopago.test.ts`
Expected: PASS, todos (los existentes siguen derivando el retorno de `baseUrl`).

- [ ] **Step 5: Commit**

```bash
git add apps/mailer/src/pago/mercadopago.ts apps/mailer/tests/pago-mercadopago.test.ts
git commit -m "feat(pagos): la preferencia acepta la URL de retorno del llamador"
```

---

### Task 2: `POST /api/pago/crear` distingue el origen `tienda`

**Files:**
- Modify: `apps/mailer/src/pago/crear.ts` (`REQUERIDAS`, `CrearEnv`, `Entrada`, `leerEntrada`, handler)
- Test: `apps/mailer/tests/pago-crear.test.ts`

**Interfaces:**
- Consumes: `DatosPreferencia.retornoUrl` (Task 1).
- Produces: el cuerpo de `crear` acepta `origen?: 'bot' | 'tienda'`. Con `'tienda'`: exige `env.TIENDA_BASE_URL` (503 `falta_configuracion` con `faltan: ['TIENDA_BASE_URL']` si falta), la preferencia vuelve a `${TIENDA_BASE_URL}/pedido/${quote_id}`, y la fila lleva `datos.origen = 'tienda'`. Cualquier `origen` que no sea `bot` ni `tienda` responde 400 `cuerpo_invalido`. Sin `origen`, comportamiento idéntico al de hoy.

- [ ] **Step 1: Escribir las pruebas que fallan**

En `apps/mailer/tests/pago-crear.test.ts`, después de las constantes `CUERPO`, agregar:

```ts
// El cuerpo que manda la tienda: sin phone_number_id (el cliente no esta en
// WhatsApp) y con origen explicito.
const CUERPO_TIENDA = {
  quote_id: QUOTE, quote_version: '1', quote_confirmed: true, origen: 'tienda',
  phone_number: '56941757584', customer_name: 'Vicente Pareja', billing_email: 'comprador@a.cl',
};
const ENV_TIENDA = { ...ENV, TIENDA_BASE_URL: 'https://drcomputacion.cl/' };
```

Y al final del `describe('POST /api/pago/crear', …)`, antes de su cierre:

```ts
  it('origen tienda: retorno a la pagina del pedido, datos.origen en la fila y ningun WhatsApp', async () => {
    const mensajes: string[] = [];
    const escrituras: unknown[] = [];
    const preferenciaEnviada: unknown[] = [];
    const spy = routeFetch({ mensajes, escrituras, preferenciaEnviada });
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO_TIENDA), res, ENV_TIENDA);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({ ok: true, estado: 'pendiente', init_point: 'https://mp/pagar' });

    const pref = preferenciaEnviada[0] as any;
    const retorno = `https://drcomputacion.cl/pedido/${QUOTE}`; // sin la barra doble
    expect(pref.back_urls).toEqual({ success: retorno, failure: retorno, pending: retorno });
    expect(pref.notification_url).toBe('https://rr-mailing.vercel.app/api/pago/webhook');

    const fila = escrituras[0] as any;
    expect(fila.datos.origen).toBe('tienda');
    expect(fila.datos.billing_email).toBe('comprador@a.cl');
    expect(fila.phone_number_id).toBeNull();
    expect(fila.telefono).toBe('56941757584');

    expect(mensajes).toHaveLength(0);
    expect(spy.mock.calls.some(([u]) => String(u).includes('/meta/whatsapp/'))).toBe(false);
  });

  it('origen tienda sin TIENDA_BASE_URL: 503 nombrandola, sin preferencia ni fila', async () => {
    const escrituras: unknown[] = [];
    const preferenciaEnviada: unknown[] = [];
    routeFetch({ escrituras, preferenciaEnviada });
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO_TIENDA), res, ENV);
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toEqual({ ok: false, error: 'falta_configuracion', faltan: ['TIENDA_BASE_URL'] });
    expect(preferenciaEnviada).toHaveLength(0);
    expect(escrituras).toHaveLength(0);
  });

  it('origen desconocido: 400 cuerpo_invalido sin tocar nada', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = makeRes();
    await createCrearHandler()(makeReq({ ...CUERPO_TIENDA, origen: 'Tienda' }), res, ENV_TIENDA);
    expect(res.statusCode).toBe(400);
    expect(res.jsonBody.error).toBe('cuerpo_invalido');
    expect(spy).not.toHaveBeenCalled();
  });

  it('sin origen todo sigue igual: retorno del rele y la fila sin origen', async () => {
    const escrituras: unknown[] = [];
    const preferenciaEnviada: unknown[] = [];
    const mensajes: string[] = [];
    routeFetch({ escrituras, preferenciaEnviada, mensajes });
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO), res, ENV); // ENV no tiene TIENDA_BASE_URL y no hace falta
    expect(res.statusCode).toBe(200);
    expect((preferenciaEnviada[0] as any).back_urls.success).toBe('https://rr-mailing.vercel.app/api/pago/retorno');
    expect((escrituras[0] as any).datos.origen).toBeUndefined();
    expect(mensajes).toHaveLength(1);
  });
```

- [ ] **Step 2: Correr las pruebas y verlas fallar**

Run: `npm test -- apps/mailer/tests/pago-crear.test.ts`
Expected: fallan los tres primeros tests nuevos (retorno apunta al relé, no hay 503 por `TIENDA_BASE_URL`, el origen desconocido pasa). El cuarto pasa ya.

- [ ] **Step 3: Implementar**

En `apps/mailer/src/pago/crear.ts`:

1. `CrearEnv` gana la variable:

```ts
export interface CrearEnv extends PagoEnv {
  MAILER_API_KEY?: string;
  MP_ACCESS_TOKEN?: string;
  PAGO_BASE_URL?: string;
  KAPSO_API_KEY?: string;
  // Solo la exige un cuerpo con origen 'tienda': es a donde vuelve el cliente
  // web despues de pagar. El bot no la necesita y no debe fallar por ella.
  TIENDA_BASE_URL?: string;
}
```

2. Después de `interface Entrada { … }` agregar el tipo y el campo:

```ts
// De donde viene el cobro. Decide a donde vuelve el cliente al salir del
// checkout y queda anotado en la fila para que el backoffice o una alerta lo
// puedan decir sin adivinar. NO decide si se manda WhatsApp: eso lo decide
// `phone_number_id`, que la tienda simplemente no manda.
type Origen = 'bot' | 'tienda';
const ORIGENES: readonly Origen[] = ['bot', 'tienda'];
```

y en `interface Entrada` agregar `origen: Origen;` después de `nombre: string;`.

3. En `leerEntrada`, después de `const quoteId = leerTexto(b.quote_id); if (!quoteId) return null;`:

```ts
  const origen = leerTexto(b.origen, 'bot');
  if (!(ORIGENES as readonly string[]).includes(origen)) return null;
```

Y en el `return` de `leerEntrada`, después de `nombre: nombre || 'Cliente',` agregar `origen: origen as Origen,`. En la construcción de `datos` (antes del `for (const campo of BILLING)`), agregar `if (origen === 'tienda') datos.origen = 'tienda';`.

4. En el handler, justo después del bloque que chequea `REQUERIDAS` (`const faltan = …; if (faltan.length > 0) { … }`), agregar:

```ts
    if (entrada.origen === 'tienda' && !env.TIENDA_BASE_URL) {
      res.status(503).json({ ok: false, error: 'falta_configuracion', faltan: ['TIENDA_BASE_URL'] });
      return;
    }
```

5. En la llamada a `construirPreferencia({...})`, después de `validUntil: cotizacion.valida_hasta,` agregar:

```ts
        ...(entrada.origen === 'tienda'
          ? { retornoUrl: `${(env.TIENDA_BASE_URL as string).replace(/\/+$/, '')}/pedido/${entrada.quoteId}` }
          : {}),
```

- [ ] **Step 4: Correr las pruebas y verlas pasar**

Run: `npm test -- apps/mailer/tests/pago-crear.test.ts`
Expected: PASS, todos.

- [ ] **Step 5: Commit**

```bash
git add apps/mailer/src/pago/crear.ts apps/mailer/tests/pago-crear.test.ts
git commit -m "feat(pagos): crear distingue el origen tienda y devuelve al cliente a su pedido"
```

---

### Task 3: `GET /api/pago/estado/{quote_id}` en el relé

**Files:**
- Create: `apps/mailer/src/pago/estado.ts`
- Create: `apps/mailer/api/pago/estado/[id].ts`
- Create: `apps/mailer/tests/pago-estado.test.ts`
- Modify: `apps/mailer/tests/pago-webhook.test.ts:630-643` (el test del techo recorre subdirectorios)
- Modify: `apps/mailer/README.md` (tabla de rutas y variables del cobro)

**Interfaces:**
- Consumes: `leerPago(env, quoteId): Promise<PagoRow | null | undefined>` de `apps/mailer/src/pago/datos.ts` (tri-estado: `undefined` = Supabase no respondió); `vigenciaUtil(validaHasta, ahoraMs): boolean` de `apps/mailer/src/pago/quote.ts` (true si quedan más de 15 min); `firstString` de `@rr/http/http`.
- Produces: `GET /api/pago/estado/{id}` → 200 `{ ok: true, estado, monto_clp, intentos_rechazados, expira_at, init_point? }`; 404 `{ ok: false, error: 'no_encontrado' }` con id mal formado o fila inexistente; 503 `upstream` / `falta_configuracion`; 405 en otros métodos. Siempre `Cache-Control: no-store`. `init_point` presente **solo** si `estado === 'pendiente'` y `vigenciaUtil(expira_at, ahora)`. Exportado: `proyectarEstado(fila: PagoRow, ahoraMs: number): EstadoPago` y `createEstadoHandler(ahora?: () => number)`.

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `apps/mailer/tests/pago-estado.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createEstadoHandler, proyectarEstado } from '../src/pago/estado.js';
import type { PagoRow } from '../src/pago/datos.js';

const ENV = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_KEY: 'clave' };
const QUOTE = 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4';
const AHORA = Date.parse('2026-09-16T12:00:00Z');
const enHoras = (h: number) => new Date(AHORA + h * 3600_000).toISOString();

function fila(extra: Partial<PagoRow> = {}): PagoRow {
  return {
    quote_id: QUOTE, quote_version: '1', numero: 1600006, telefono: '56941757584',
    phone_number_id: null, preference_id: 'pref-1', init_point: 'https://mp/pagar',
    monto_clp: 1058793, expira_at: enHoras(3), estado: 'pendiente', mp_payment_id: null,
    intentos_rechazados: 0, datos: { origen: 'tienda', billing_email: 'comprador@a.cl' },
    ...extra,
  };
}

function makeRes() {
  const res = {
    statusCode: 0, jsonBody: undefined as any, headers: {} as Record<string, string>,
    status(c: number) { res.statusCode = c; return res; },
    json(p: unknown) { res.jsonBody = p; return res; },
    setHeader(k: string, v: string) { res.headers[k.toLowerCase()] = v; return res; },
    send() { return res; }, end() { return res; },
  };
  return res as unknown as VercelResponse & typeof res;
}

function makeReq(id: unknown, method = 'GET'): VercelRequest {
  return { method, query: { id }, headers: {}, body: undefined } as unknown as VercelRequest;
}

function stubSupabase(filas: unknown[] | 'caido') {
  const spy = vi.fn(async () => {
    if (filas === 'caido') throw new Error('red caida');
    return new Response(JSON.stringify(filas), { status: 200 });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe('proyectarEstado', () => {
  it('pendiente y vigente: lleva init_point', () => {
    const p = proyectarEstado(fila(), AHORA);
    expect(p).toEqual({
      estado: 'pendiente', monto_clp: 1058793, intentos_rechazados: 0,
      expira_at: enHoras(3), init_point: 'https://mp/pagar',
    });
  });

  it('pendiente con menos de 15 minutos de vigencia: sin init_point (el link ya murio)', () => {
    const p = proyectarEstado(fila({ expira_at: new Date(AHORA + 10 * 60_000).toISOString() }), AHORA);
    expect(p.estado).toBe('pendiente');
    expect(p.init_point).toBeUndefined();
  });

  it.each(['aprobado', 'emitido', 'aprobado_sin_emitir'] as const)('%s: sin init_point aunque haya vigencia', (estado) => {
    expect(proyectarEstado(fila({ estado }), AHORA).init_point).toBeUndefined();
  });

  it('es una lista blanca: nunca viajan telefono, datos, preference_id ni mp_payment_id', () => {
    const p = proyectarEstado(fila({ mp_payment_id: '179145675492', estado: 'emitido' }), AHORA) as Record<string, unknown>;
    expect(Object.keys(p).sort()).toEqual(['estado', 'expira_at', 'intentos_rechazados', 'monto_clp']);
  });

  it('intentos_rechazados ausente en la fila se lee como 0', () => {
    expect(proyectarEstado(fila({ intentos_rechazados: undefined }), AHORA).intentos_rechazados).toBe(0);
  });
});

describe('GET /api/pago/estado/{id}', () => {
  it('fila existente: 200 con la proyeccion y no-store', async () => {
    stubSupabase([fila({ intentos_rechazados: 1 })]);
    const res = makeRes();
    await createEstadoHandler(() => AHORA)(makeReq(QUOTE), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody).toEqual({
      ok: true, estado: 'pendiente', monto_clp: 1058793, intentos_rechazados: 1,
      expira_at: enHoras(3), init_point: 'https://mp/pagar',
    });
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('id mal formado: 404 sin tocar Supabase', async () => {
    const spy = stubSupabase([fila()]);
    for (const id of ['abc', '', undefined, `${QUOTE}'--`, [QUOTE, QUOTE]]) {
      const res = makeRes();
      await createEstadoHandler(() => AHORA)(makeReq(id), res, ENV);
      // Un array con un UUID valido en [0] SI pasa (firstString): solo los otros son 404.
      if (Array.isArray(id)) { expect(res.statusCode).toBe(200); continue; }
      expect(res.statusCode).toBe(404);
      expect(res.jsonBody).toEqual({ ok: false, error: 'no_encontrado' });
    }
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('fila inexistente: 404 con el mismo cuerpo que un id mal formado', async () => {
    stubSupabase([]);
    const res = makeRes();
    await createEstadoHandler(() => AHORA)(makeReq(QUOTE), res, ENV);
    expect(res.statusCode).toBe(404);
    expect(res.jsonBody).toEqual({ ok: false, error: 'no_encontrado' });
  });

  it('Supabase caido: 503 upstream', async () => {
    stubSupabase('caido');
    const res = makeRes();
    await createEstadoHandler(() => AHORA)(makeReq(QUOTE), res, ENV);
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toEqual({ ok: false, error: 'upstream' });
  });

  it('falta configuracion: 503 nombrando las variables', async () => {
    stubSupabase([fila()]);
    const res = makeRes();
    await createEstadoHandler(() => AHORA)(makeReq(QUOTE), res, { SUPABASE_URL: 'https://supabase.test' });
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody).toEqual({ ok: false, error: 'falta_configuracion', faltan: ['SUPABASE_SERVICE_KEY'] });
  });

  it('metodo distinto de GET: 405', async () => {
    stubSupabase([fila()]);
    const res = makeRes();
    await createEstadoHandler(() => AHORA)(makeReq(QUOTE, 'POST'), res, ENV);
    expect(res.statusCode).toBe(405);
  });
});
```

- [ ] **Step 2: Correr la prueba y verla fallar**

Run: `npm test -- apps/mailer/tests/pago-estado.test.ts`
Expected: FAIL, `Cannot find module '../src/pago/estado.js'`.

- [ ] **Step 3: Implementar el handler**

Crear `apps/mailer/src/pago/estado.ts`:

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { firstString } from '@rr/http/http';
import { leerPago, type PagoEnv, type PagoRow } from './datos.js';
import { vigenciaUtil } from './quote.js';

// Publico por URL de capacidad, misma politica que GET /api/cotizacion/{id}:
// el quote_id es un UUID v4 y conocerlo es la credencial. Por eso la forma del
// id se valida antes de tocar la base, y un id malo responde lo mismo que una
// fila inexistente: no hay que darle a nadie una sonda para distinguirlos.
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const REQUERIDAS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY'] as const;

export interface EstadoPago {
  estado: PagoRow['estado'];
  monto_clp: number;
  intentos_rechazados: number;
  expira_at: string;
  init_point?: string;
}

/**
 * Lo unico de la fila que sale por este endpoint. Es una lista blanca, no un
 * `omit`: un campo nuevo en `pagos` no viaja hasta que alguien lo agregue aca
 * a proposito. Nunca telefono, datos, preference_id ni mp_payment_id.
 *
 * `init_point` solo mientras se puede pagar: fila pendiente y link vivo. El
 * link muere 15 minutos antes que la cotizacion (MARGEN_VIGENCIA_MS), asi que
 * la vigencia se mide con `vigenciaUtil`, no contra `expira_at` a secas. Una
 * fila pendiente sin init_point es, para la pagina, "el link vencio".
 */
export function proyectarEstado(fila: PagoRow, ahoraMs: number): EstadoPago {
  const sePuedePagar = fila.estado === 'pendiente' && vigenciaUtil(String(fila.expira_at), ahoraMs);
  return {
    estado: fila.estado,
    monto_clp: Number(fila.monto_clp),
    intentos_rechazados: Number(fila.intentos_rechazados ?? 0),
    expira_at: String(fila.expira_at),
    ...(sePuedePagar ? { init_point: fila.init_point } : {}),
  };
}

export function createEstadoHandler(ahora: () => number = Date.now) {
  return async function handler(
    req: VercelRequest,
    res: VercelResponse,
    env: PagoEnv = process.env as PagoEnv,
  ): Promise<void> {
    if (req.method !== 'GET') {
      res.status(405).json({ ok: false, error: 'metodo_no_permitido' });
      return;
    }
    // La pagina del pedido lo consulta en bucle mientras espera el webhook:
    // una respuesta cacheada le mentiria justo cuando cambia.
    res.setHeader('Cache-Control', 'no-store');

    const id = firstString(req.query.id as string | string[] | undefined) ?? '';
    if (!UUID_RE.test(id)) {
      res.status(404).json({ ok: false, error: 'no_encontrado' });
      return;
    }

    const faltan = REQUERIDAS.filter((n) => !env[n]);
    if (faltan.length > 0) {
      res.status(503).json({ ok: false, error: 'falta_configuracion', faltan });
      return;
    }

    const fila = await leerPago(env, id);
    if (fila === undefined) {
      res.status(503).json({ ok: false, error: 'upstream' });
      return;
    }
    if (fila === null) {
      res.status(404).json({ ok: false, error: 'no_encontrado' });
      return;
    }
    res.status(200).json({ ok: true, ...proyectarEstado(fila, ahora()) });
  };
}
```

Crear `apps/mailer/api/pago/estado/[id].ts`:

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createEstadoHandler } from '../../../src/pago/estado.js';

// Mismo techo que el resto de api/pago/: lo exige la prueba «techo de
// ejecucion de las rutas de pago». Este handler no lo necesita (un GET con
// un timeout de 8s), pero una excepcion en la regla es peor que 300s sin usar.
export const maxDuration = 300;

// Envoltorio fino, patron de api/cotizacion/[id].ts: el id llega en
// req.query.id por la ruta dinamica de Vercel.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return createEstadoHandler()(req, res);
}
```

- [ ] **Step 4: Correr la prueba y verla pasar**

Run: `npm test -- apps/mailer/tests/pago-estado.test.ts`
Expected: PASS.

- [ ] **Step 5: Hacer que el test del techo vea el subdirectorio**

En `apps/mailer/tests/pago-webhook.test.ts`, el `describe('techo de ejecucion de las rutas de pago', …)` lista con `readdirSync('apps/mailer/api/pago').filter((f) => f.endsWith('.ts'))`, que no entra a `estado/`. Primero confirmar el hueco:

Run: `npm test -- apps/mailer/tests/pago-webhook.test.ts -t "techo"`
Expected: PASS con 3 rutas (`crear.ts`, `retorno.ts`, `webhook.ts`); `estado/[id].ts` no aparece.

Reemplazar las dos líneas de arriba del `describe` (`const config = …` y `const rutasDePago = …`) por:

```ts
  const config = JSON.parse(readFileSync('apps/mailer/vercel.json', 'utf8'));
  // Recorre subdirectorios: api/pago/estado/[id].ts tambien es una ruta de
  // pago y tambien tiene que declarar su techo.
  const listarRutas = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
    e.isDirectory() ? listarRutas(join(dir, e.name)) : e.name.endsWith('.ts') ? [join(dir, e.name)] : []);
  const rutasDePago = listarRutas('apps/mailer/api/pago')
    .map((p) => relative('apps/mailer/api/pago', p).replace(/\\/g, '/'));
```

Y donde el `it.each` lee `readFileSync(\`apps/mailer/api/pago/${archivo}\`, 'utf8')` no cambia nada (el path relativo ya incluye `estado/`). Agregar al import de `node:path` (o crearlo si no existe) `join` y `relative`:

```ts
import { join, relative } from 'node:path';
```

Agregar además, dentro del mismo `describe`, un test que fije que la ruta nueva está en la lista:

```ts
  it('la ruta de estado esta en la lista (el recorrido entra a subdirectorios)', () => {
    expect(rutasDePago).toContain('estado/[id].ts');
  });
```

Run: `npm test -- apps/mailer/tests/pago-webhook.test.ts -t "techo"`
Expected: PASS con 4 rutas, incluida `estado/[id].ts`.

- [ ] **Step 6: Documentar en el README del relé**

En `apps/mailer/README.md`, en la tabla de rutas de la sección «Cobro con Mercado Pago» (la que empieza con `| Ruta | Qué hace |`), agregar una fila al final:

```markdown
| `GET /api/pago/estado/<quote_id>` | Pública por URL de capacidad (como el PDF). Estado, monto, rechazos y vencimiento del pago; el link de pago solo mientras está pendiente y vigente. Nunca teléfono, `datos` ni ids de Mercado Pago. La consulta la página del pedido de la tienda |
```

En la tabla de variables de esa misma sección (la que empieza con `| Variable | Qué es |` bajo «Variables nuevas en el proyecto `rr-mailing`»), agregar al final:

```markdown
| `TIENDA_BASE_URL` | Base de la tienda web sin barra final (p. ej. `https://drcomputacion.cl`). Solo la exige un `crear` con `origen: "tienda"`: es a donde Mercado Pago devuelve al cliente web. Tras cargarla hay que **redesplegar**: Vercel no aplica variables a un despliegue ya construido |
```

Y después del párrafo que empieza con «**`quote_confirmed` es obligatorio en `/api/pago/crear`**» agregar:

```markdown
**`origen` en `/api/pago/crear`.** Opcional, `bot` (default) o `tienda`. La
tienda web (`apps/tienda`) llama a este mismo endpoint desde
`/api/confirmar` con `origen: "tienda"` y sin `phone_number_id`: no hay
WhatsApp que mandar (el envío en `src/pago/kapso.ts` ya es no-op sin ese id) y
las `back_urls` de la preferencia apuntan a `<TIENDA_BASE_URL>/pedido/<quote_id>`
en vez de a `/api/pago/retorno`. El origen queda en `datos.origen` de la fila.
El webhook no distingue orígenes. Diseño en
`docs/superpowers/specs/2026-09-16-tienda-cobro-design.md`.
```

- [ ] **Step 7: Suite del relé completa y commit**

Run: `npm test -- apps/mailer`
Expected: PASS, todo.

```bash
git add apps/mailer/src/pago/estado.ts "apps/mailer/api/pago/estado/[id].ts" apps/mailer/tests/pago-estado.test.ts apps/mailer/tests/pago-webhook.test.ts apps/mailer/README.md
git commit -m "feat(pagos): GET /api/pago/estado expone el estado del pago por URL de capacidad"
```

---

### Task 4: La tienda arma el cuerpo para `crear` en vez del payload de emisión

**Files:**
- Modify: `apps/tienda/src/lib/pedido.ts:66-99` (reemplazar `armarPayloadEmision`)
- Test: `apps/tienda/tests/pedido.test.ts:59-83`

**Interfaces:**
- Consumes: `Comprador`, `Facturacion` (mismo archivo).
- Produces: `armarCuerpoCrearPago(quote: { quote_id: string; quote_version?: string | number }, comprador: Comprador, facturacion: Facturacion | null): Record<string, unknown>` — el cuerpo plano que `POST /api/pago/crear` espera: `quote_id`, `quote_version` (string, `'1'` si la quote no lo trae), `quote_confirmed: true`, `origen: 'tienda'`, `phone_number`, `customer_name`, `billing_email` (siempre) y los seis `billing_*` restantes solo con facturación completa. `armarPayloadEmision` desaparece (la tienda ya no emite).

- [ ] **Step 1: Reescribir las pruebas**

En `apps/tienda/tests/pedido.test.ts`, cambiar el import a:

```ts
import { armarCuerpoCrearPago, armarPayloadCotizacion, validarPedido } from '../src/lib/pedido.js';
```

Y reemplazar los dos tests que usan `armarPayloadEmision` (`'emision: quote_confirmed true; billing_* solo con facturacion'` y `'billing_email SIEMPRE viaja …'`) por:

```ts
  it('cuerpo para crear pago: confirmacion booleana, origen tienda y sin facturacion solo billing_email', () => {
    const quote = { quote_id: 'q-1', lineas: [], total_clp: 2000 };
    const sin = armarCuerpoCrearPago(quote, { nombre: 'Vicente', telefono: '56941757584', email: 'comprador@a.cl' }, null);
    expect(sin).toEqual({
      quote_id: 'q-1',
      quote_version: '1',
      quote_confirmed: true,
      origen: 'tienda',
      phone_number: '56941757584',
      customer_name: 'Vicente',
      billing_email: 'comprador@a.cl',
    });
    // Ni phone_number_id (no hay WhatsApp) ni execution_context (no es Kapso).
    expect(sin).not.toHaveProperty('phone_number_id');
    expect(sin).not.toHaveProperty('execution_context');
  });

  it('con facturacion completa viajan los siete billing_*, y billing_email es el de factura', () => {
    const quote = { quote_id: 'q-1', quote_version: 2 };
    const conF = armarCuerpoCrearPago(quote, { nombre: 'V', telefono: '569', email: 'comprador@a.cl' },
      { rut: '1-9', razonSocial: 'Acme', giro: 'G', direccion: 'D', comuna: 'C', ciudad: 'S', emailFactura: 'f@a.cl' });
    expect(conF.quote_version).toBe('2');
    expect(conF.billing_rut).toBe('1-9');
    expect(conF.billing_razon_social).toBe('Acme');
    expect(conF.billing_giro).toBe('G');
    expect(conF.billing_direccion).toBe('D');
    expect(conF.billing_comuna).toBe('C');
    expect(conF.billing_ciudad).toBe('S');
    expect(conF.billing_email).toBe('f@a.cl');
  });
```

- [ ] **Step 2: Correr las pruebas y verlas fallar**

Run: `npm test -- apps/tienda/tests/pedido.test.ts`
Expected: FAIL, `armarCuerpoCrearPago` no existe.

- [ ] **Step 3: Implementar**

En `apps/tienda/src/lib/pedido.ts`, reemplazar completa la función `armarPayloadEmision` (desde su `export function` hasta su `}` final) por:

```ts
/**
 * El cuerpo que `POST <rele>/api/pago/crear` espera. Es plano (no es una
 * function de Kapso, no lleva execution_context) y va sin `phone_number_id`
 * a proposito: el cliente web no esta en WhatsApp, y sin ese id el rele no
 * intenta mandar nada. `origen: 'tienda'` es lo que hace que Mercado Pago lo
 * devuelva a /pedido/{quote_id} en vez de a la pagina "vuelve a WhatsApp".
 */
export function armarCuerpoCrearPago(
  quote: { quote_id: string; quote_version?: string | number },
  comprador: Comprador,
  facturacion: Facturacion | null,
): Record<string, unknown> {
  return {
    quote_id: quote.quote_id,
    quote_version: String(quote.quote_version ?? '1'),
    quote_confirmed: true,
    origen: 'tienda',
    phone_number: comprador.telefono,
    customer_name: comprador.nombre,
    // El email SIEMPRE viaja: sin el, un pedido sin facturacion llegaba al
    // backoffice sin ninguna direccion a la que mandar la cotizacion.
    // Los otros 6 billing_* siguen atados a la facturacion COMPLETA: a
    // medias gatillarian el upsert de clientes con datos incompletos.
    billing_email: facturacion?.emailFactura ?? comprador.email,
    ...(facturacion
      ? {
          billing_rut: facturacion.rut,
          billing_razon_social: facturacion.razonSocial,
          billing_giro: facturacion.giro,
          billing_direccion: facturacion.direccion,
          billing_comuna: facturacion.comuna,
          billing_ciudad: facturacion.ciudad,
        }
      : {}),
  };
}
```

- [ ] **Step 4: Correr las pruebas y verlas pasar**

Run: `npm test -- apps/tienda/tests/pedido.test.ts`
Expected: PASS. (`confirmar.test.ts` y `route.ts` aún importan `armarPayloadEmision` y fallarán en typecheck hasta la Task 6; es esperado, no correr `typecheck` todavía.)

- [ ] **Step 5: Commit**

```bash
git add apps/tienda/src/lib/pedido.ts apps/tienda/tests/pedido.test.ts
git commit -m "feat(tienda): el pedido arma el cuerpo para crear el pago, no el de emision"
```

---

### Task 5: Cliente del relé en la tienda

**Files:**
- Create: `apps/tienda/src/lib/relay.ts`
- Create: `apps/tienda/tests/relay.test.ts`

**Interfaces:**
- Consumes: `process.env.MAILER_URL`, `process.env.MAILER_API_KEY`.
- Produces: `crearPago(cuerpo: unknown): Promise<{ status: number; data: Record<string, unknown> } | null>`. `null` = no se pudo hablar con el relé (config faltante, red, timeout de 15 s). Cualquier status HTTP se devuelve tal cual: el caller decide.

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `apps/tienda/tests/relay.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { crearPago } from '../src/lib/relay.js';

beforeEach(() => {
  vi.stubEnv('MAILER_URL', 'https://relay.test/');
  vi.stubEnv('MAILER_API_KEY', 'clave-relay');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

const CUERPO = { quote_id: 'q-1', quote_confirmed: true, origen: 'tienda' };

describe('crearPago', () => {
  it('postea el cuerpo a /api/pago/crear con la api key y devuelve status y data', async () => {
    const spy = vi.fn(async (url: any, init?: RequestInit) => {
      expect(String(url)).toBe('https://relay.test/api/pago/crear'); // sin barra doble
      expect(init?.method).toBe('POST');
      const h = init?.headers as Record<string, string>;
      expect(h['x-api-key']).toBe('clave-relay');
      expect(h['content-type']).toBe('application/json');
      expect(JSON.parse(String(init?.body))).toEqual(CUERPO);
      return new Response(JSON.stringify({ ok: true, estado: 'pendiente', init_point: 'https://mp/pagar' }), { status: 200 });
    });
    vi.stubGlobal('fetch', spy);
    const r = await crearPago(CUERPO);
    expect(r).toEqual({ status: 200, data: { ok: true, estado: 'pendiente', init_point: 'https://mp/pagar' } });
    expect(spy).toHaveBeenCalledTimes(1);
  });

  it('un status no-2xx SE DEVUELVE (el caller decide); red caida => null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ok: false, error: 'sin_vigencia' }), { status: 409 })));
    const r = await crearPago(CUERPO);
    expect(r?.status).toBe(409);
    expect(r?.data.error).toBe('sin_vigencia');

    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caida'); }));
    expect(await crearPago(CUERPO)).toBeNull();
  });

  it('cuerpo de respuesta ilegible => data vacia, no excepcion', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('no es json', { status: 502 })));
    expect(await crearPago(CUERPO)).toEqual({ status: 502, data: {} });
  });

  it('sin MAILER_URL o MAILER_API_KEY => null sin llamar a nadie', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    vi.stubEnv('MAILER_API_KEY', '');
    expect(await crearPago(CUERPO)).toBeNull();
    vi.stubEnv('MAILER_API_KEY', 'clave-relay');
    vi.stubEnv('MAILER_URL', '');
    expect(await crearPago(CUERPO)).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it('los logs nunca llevan la key ni el cuerpo', async () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    await crearPago({ ...CUERPO, customer_name: 'Vicente Pareja' });
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caida'); }));
    await crearPago(CUERPO);
    expect(log).toHaveBeenCalled();
    const todo = JSON.stringify(log.mock.calls);
    expect(todo).not.toContain('clave-relay');
    expect(todo).not.toContain('Vicente Pareja');
    expect(todo).not.toContain('q-1');
  });
});
```

- [ ] **Step 2: Correr la prueba y verla fallar**

Run: `npm test -- apps/tienda/tests/relay.test.ts`
Expected: FAIL, `Cannot find module '../src/lib/relay.js'`.

- [ ] **Step 3: Implementar**

Crear `apps/tienda/src/lib/relay.ts`:

```ts
// Puente al servicio de pagos del rele (apps/mailer, rutas api/pago/*). La
// tienda le pide el link de pago con el mismo endpoint que usa el bot; la
// diferencia es `origen: 'tienda'` en el cuerpo (ver pedido.ts).
const TIMEOUT_MS = 15000; // crear = leer cotizacion + preferencia en MP + insertar fila

/**
 * Log de fallos. NUNCA recibe la api key ni el cuerpo: lleva nombre, telefono
 * y email del comprador, y los logs de Vercel los lee cualquiera con acceso
 * al proyecto. Solo etapa + tipo de fallo.
 */
function registrar(etapa: string, detalle: string): void {
  console.error(`[relay] ${etapa} fallo`, { detalle });
}

function tipoDeFallo(error: unknown): string {
  if (error instanceof Error) return error.name === 'TimeoutError' ? 'timeout' : error.name;
  return 'desconocido';
}

export async function crearPago(
  cuerpo: unknown,
): Promise<{ status: number; data: Record<string, unknown> } | null> {
  const base = process.env.MAILER_URL;
  const key = process.env.MAILER_API_KEY;
  if (!base || !key) {
    registrar('config', 'falta MAILER_URL o MAILER_API_KEY');
    return null;
  }
  try {
    const r = await fetch(`${base.replace(/\/+$/, '')}/api/pago/crear`, {
      method: 'POST',
      headers: { 'x-api-key': key, 'content-type': 'application/json' },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const data = (await r.json().catch(() => ({}))) as Record<string, unknown>;
    // El codigo de error del rele (sin_vigencia, falta_configuracion...) es
    // un literal fijo, no un dato del cliente: se puede registrar.
    if (r.status >= 400) registrar('crear', `status ${r.status} ${String(data.error ?? '')}`.trim());
    return { status: r.status, data };
  } catch (error) {
    registrar('crear', tipoDeFallo(error));
    return null;
  }
}
```

- [ ] **Step 4: Correr la prueba y verla pasar**

Run: `npm test -- apps/tienda/tests/relay.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/tienda/src/lib/relay.ts apps/tienda/tests/relay.test.ts
git commit -m "feat(tienda): cliente del servicio de pagos del rele"
```

---

### Task 6: `/api/confirmar` crea el pago en vez de emitir

**Files:**
- Modify: `apps/tienda/app/api/confirmar/route.ts`
- Test: `apps/tienda/tests/confirmar.test.ts`

**Interfaces:**
- Consumes: `armarCuerpoCrearPago` (Task 4), `crearPago` (Task 5), `invocarFunction` y `armarPayloadCotizacion` (existentes).
- Produces: `POST /api/confirmar` → 200 `{ ok: true, quoteId, totalClp, initPoint, avisoAbastecimiento? }`. Errores nuevos: 503 `{ error: 'No pudimos generar el link de pago. Intenta de nuevo.' }` (relé caído, 5xx, 4xx que no sea 409, o respuesta sin `init_point`); 422 `{ error: 'Los precios de tu cotización cambiaron. Vuelve a confirmar el pedido.' }` si el relé responde 409 (`sin_vigencia`). Desaparecen `avisoOc` y `noReintentar`. `maxDuration = 60`.

- [ ] **Step 1: Reescribir las pruebas**

Reemplazar completo `apps/tienda/tests/confirmar.test.ts` por:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../app/api/confirmar/route.js';
import { _limpiarCacheKapso } from '../src/lib/kapso.js';
import { _limpiarRateLimit, permitir } from '../src/lib/rate-limit.js';

beforeEach(() => {
  _limpiarCacheKapso(); _limpiarRateLimit();
  vi.stubEnv('KAPSO_API_KEY', 'k');
  vi.stubEnv('MAILER_URL', 'https://relay.test');
  vi.stubEnv('MAILER_API_KEY', 'clave-relay');
});
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const FUNCTIONS = { data: [{ id: 'id-g', name: 'generar-cotizacion-v2' }, { id: 'id-e', name: 'emitir-ordenes-compra' }] };
const QUOTE = {
  quote_id: 'q-1',
  lineas: [{ sku_proveedor: 'A', abastecimiento: 'stock_inmediato' }],
  neto_clp: 1000, iva_clp: 190, total_clp: 1190, valid_until: '2027-01-01T00:00:00Z',
};

function req(body: unknown, ip = '1.2.3.4'): Request {
  return new Request('http://localhost/api/confirmar', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}
const BODY = {
  items: [{ sku: 'A', mpn: 'M', marca: 'HP', nombre: 'P', cantidad: 1, precioNetoClp: 1000, precioTiendaClp: 1190 }],
  comprador: { nombre: 'Vicente', telefono: '56941757584', email: 'v@a.cl' },
  sitio_web: '',
  totalConfirmadoClp: 1190,
};

// Enruta: listado de functions, generar (cotiza) y el rele (crear pago).
function stubRed(opciones: {
  totalVivo?: number; generarStatus?: number; abastecimiento?: string;
  relayStatus?: number; relayBody?: unknown; relayCaido?: boolean;
} = {}) {
  const llamadas: string[] = [];
  const cuerposRelay: Array<{ headers: Record<string, string>; body: any }> = [];
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/functions')) return new Response(JSON.stringify(FUNCTIONS), { status: 200 });
    if (u.includes('/id-g/invoke')) {
      llamadas.push('generar');
      if (opciones.generarStatus) return new Response(JSON.stringify({ estado: 'error', mensaje: 'sin precio' }), { status: opciones.generarStatus });
      const quote = {
        ...QUOTE,
        total_clp: opciones.totalVivo ?? QUOTE.total_clp,
        lineas: [{ sku_proveedor: 'A', abastecimiento: opciones.abastecimiento ?? 'stock_inmediato' }],
      };
      return new Response(JSON.stringify({ estado: 'ok', quote }), { status: 200 });
    }
    if (u.includes('/id-e/invoke')) {
      llamadas.push('emitir');
      throw new Error('la tienda ya no emite: esta llamada no debe existir');
    }
    if (u.startsWith('https://relay.test/api/pago/crear')) {
      llamadas.push('crear');
      cuerposRelay.push({ headers: init?.headers as Record<string, string>, body: JSON.parse(String(init?.body)) });
      if (opciones.relayCaido) throw new Error('caida');
      const body = opciones.relayBody ?? { ok: true, estado: 'pendiente', init_point: 'https://mp/pagar' };
      return new Response(JSON.stringify(body), { status: opciones.relayStatus ?? 200 });
    }
    throw new Error(`llamada inesperada: ${u}`);
  }));
  return { llamadas, cuerposRelay };
}

describe('POST /api/confirmar', () => {
  it('flujo feliz: cotiza, crea el pago y responde con el link', async () => {
    const { llamadas } = stubRed();
    const res = await POST(req(BODY));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data).toEqual({ ok: true, quoteId: 'q-1', totalClp: 1190, initPoint: 'https://mp/pagar' });
    expect(llamadas).toEqual(['generar', 'crear']);
  });
  it('el cuerpo al rele lleva la confirmacion, el origen tienda, los datos del comprador y la api key', async () => {
    const { cuerposRelay } = stubRed();
    await POST(req({ ...BODY, facturacion: { rut: '1-9', razonSocial: 'Acme', giro: 'G', direccion: 'D', comuna: 'C', ciudad: 'S', emailFactura: 'f@a.cl' } }));
    expect(cuerposRelay).toHaveLength(1);
    expect(cuerposRelay[0].headers['x-api-key']).toBe('clave-relay');
    expect(cuerposRelay[0].body).toEqual({
      quote_id: 'q-1', quote_version: '1', quote_confirmed: true, origen: 'tienda',
      phone_number: '56941757584', customer_name: 'Vicente',
      billing_email: 'f@a.cl', billing_rut: '1-9', billing_razon_social: 'Acme', billing_giro: 'G',
      billing_direccion: 'D', billing_comuna: 'C', billing_ciudad: 'S',
    });
  });
  it('total distinto al confirmado: 409 recotizado y NO crea pago', async () => {
    const { llamadas } = stubRed({ totalVivo: 1500 });
    const res = await POST(req(BODY));
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.recotizado).toBe(true);
    expect(data.totalClp).toBe(1500);
    expect(llamadas).toEqual(['generar']);
  });
  it('error de negocio de generar (409/400 de la function) => 422 con el mensaje', async () => {
    stubRed({ generarStatus: 409 });
    const res = await POST(req(BODY));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('sin precio');
  });
  it('validacion mala => 400; red caida => 503', async () => {
    stubRed();
    expect((await POST(req({ ...BODY, comprador: { nombre: 'V', telefono: '1', email: 'x' } }))).status).toBe(400);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caida'); }));
    _limpiarCacheKapso();
    expect((await POST(req(BODY))).status).toBe(503);
  });
  it('sexta confirmacion de la misma IP en la ventana => 429', async () => {
    stubRed();
    for (let i = 0; i < 5; i++) expect((await POST(req(BODY, '9.9.9.9'))).status).toBe(200);
    expect((await POST(req(BODY, '9.9.9.9'))).status).toBe(429);
    expect((await POST(req(BODY, '8.8.8.8'))).status).toBe(200); // otra IP sigue pasando
  });
  it('un body invalido no gasta cupo: tras 5 intentos invalidos, el sexto (valido) responde 200', async () => {
    stubRed();
    const bodyInvalido = { ...BODY, comprador: { nombre: 'V', telefono: '1', email: 'x' } };
    for (let i = 0; i < 5; i++) expect((await POST(req(bodyInvalido, '7.7.7.7'))).status).toBe(400);
    expect((await POST(req(BODY, '7.7.7.7'))).status).toBe(200);
  });
  it('generar-cotizacion-v2 responde 500 => 503 y no llama al rele', async () => {
    const { llamadas } = stubRed({ generarStatus: 500 });
    const res = await POST(req(BODY));
    expect(res.status).toBe(503);
    expect(String((await res.json()).error)).toMatch(/intenta de nuevo/i);
    expect(llamadas).toEqual(['generar']);
  });
  it('total no cotizable (0 o no numerico) => 422, y NO se compara contra el confirmado', async () => {
    const { llamadas } = stubRed({ totalVivo: 0 });
    const res = await POST(req({ ...BODY, totalConfirmadoClp: 0 }));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('No pudimos cotizar tu pedido');
    expect(llamadas).toEqual(['generar']);
  });
  it('una linea por encargo => avisoAbastecimiento en el 200', async () => {
    stubRed({ abastecimiento: 'por_comprar_importar' });
    const data = await (await POST(req(BODY))).json();
    expect(data.ok).toBe(true);
    expect(data.avisoAbastecimiento).toBe(true);
  });
  it('todo con stock inmediato => sin avisoAbastecimiento', async () => {
    stubRed();
    const data = await (await POST(req(BODY))).json();
    expect(data.avisoAbastecimiento).toBeUndefined();
  });
  it('rele caido o 5xx => 503 que SI invita a reintentar (nada se emitio)', async () => {
    for (const opciones of [{ relayCaido: true }, { relayStatus: 502, relayBody: { ok: false, error: 'mercadopago_no_responde' } }]) {
      _limpiarRateLimit();
      stubRed(opciones);
      const res = await POST(req(BODY));
      expect(res.status).toBe(503);
      const data = await res.json();
      expect(data.error).toBe('No pudimos generar el link de pago. Intenta de nuevo.');
      expect(data.noReintentar).toBeUndefined();
    }
  });
  it('rele 409 sin_vigencia => 422 pidiendo confirmar de nuevo', async () => {
    stubRed({ relayStatus: 409, relayBody: { ok: false, error: 'sin_vigencia' } });
    const res = await POST(req(BODY));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toBe('Los precios de tu cotización cambiaron. Vuelve a confirmar el pedido.');
  });
  it('rele 200 sin init_point => 503 (no hay a donde mandar al cliente)', async () => {
    stubRed({ relayBody: { ok: true, estado: 'pendiente' } });
    const res = await POST(req(BODY));
    expect(res.status).toBe(503);
  });
  it('rele 401/400 (nuestra configuracion) => 503 generico, no el codigo interno', async () => {
    stubRed({ relayStatus: 401, relayBody: { ok: false, error: 'no_autorizado' } });
    const res = await POST(req(BODY));
    expect(res.status).toBe(503);
    expect(String((await res.json()).error)).not.toContain('no_autorizado');
  });
});

describe('permitir (rate limit)', () => {
  it('expira la ventana a los 10 minutos', () => {
    _limpiarRateLimit();
    const t0 = 1_000_000;
    for (let i = 0; i < 5; i++) expect(permitir('ip', t0)).toBe(true);
    expect(permitir('ip', t0)).toBe(false);
    expect(permitir('ip', t0 + 10 * 60_000 + 1)).toBe(true);
  });
});
```

- [ ] **Step 2: Correr las pruebas y verlas fallar**

Run: `npm test -- apps/tienda/tests/confirmar.test.ts`
Expected: FAIL. El módulo no compila (`armarPayloadEmision` ya no existe) o, si vitest lo carga igual, el flujo feliz llama a `emitir` y el stub lanza.

- [ ] **Step 3: Implementar**

Reemplazar completo `apps/tienda/app/api/confirmar/route.ts` por:

```ts
import { invocarFunction } from '../../../src/lib/kapso.js';
import { armarCuerpoCrearPago, armarPayloadCotizacion, validarPedido } from '../../../src/lib/pedido.js';
import { crearPago } from '../../../src/lib/relay.js';
import { permitir } from '../../../src/lib/rate-limit.js';

// Esta ruta cotiza en vivo en Kapso (30s de timeout propio) y despues le pide
// el link de pago al rele (15s), en serie: el techo tiene que dar para los dos
// en el peor caso. Va como segment config de Next y no en vercel.json — en
// App Router las functions las emite el framework, y un glob que no calza
// rompe el build.
export const maxDuration = 60;

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

// Desde que la tienda cobra, un fallo despues de cotizar SI se puede
// reintentar: nada se emite hasta que Mercado Pago aprueba, y una cotizacion
// huerfana con su fila `pendiente` en `pagos` vence sola.
const MENSAJE_SIN_LINK = 'No pudimos generar el link de pago. Intenta de nuevo.';
const MENSAJE_SIN_VIGENCIA = 'Los precios de tu cotización cambiaron. Vuelve a confirmar el pedido.';

interface LineaQuote { abastecimiento?: string }
interface Quote { quote_id?: string; quote_version?: string | number; total_clp?: number; lineas?: LineaQuote[] }

export async function POST(req: Request): Promise<Response> {
  const ip = (req.headers.get('x-forwarded-for') ?? 'sin-ip').split(',')[0].trim();

  const body = await req.json().catch(() => null);
  const pedido = validarPedido(body);
  if ('error' in pedido) return json({ error: pedido.error }, 400);

  // El cupo se gasta solo cuando el pedido ya paso validacion y va a
  // disparar trabajo real contra Kapso: un 400 de validacion no cuesta cupo.
  if (!permitir(ip, Date.now())) {
    return json({ error: 'Demasiados intentos. Espera unos minutos.' }, 429);
  }

  // 1) Recotizar en vivo: el precio del carro es indicativo; la verdad la
  // pone generar-cotizacion-v2 (mismo motor que el bot). NUNCA se acepta una
  // quote del navegador — seria adulterable.
  const cotizacion = await invocarFunction(
    'generar-cotizacion-v2',
    armarPayloadCotizacion(pedido.items, pedido.comprador.telefono),
  );
  if (cotizacion === null) return json({ error: 'No pudimos procesar tu pedido. Intenta de nuevo.' }, 503);
  if (cotizacion.status >= 500) {
    return json({ error: 'No pudimos procesar tu pedido. Intenta de nuevo.' }, 503);
  }
  const quote = (cotizacion.data as { quote?: Quote }).quote;
  if (cotizacion.status !== 200 || !quote?.quote_id) {
    const mensaje = String((cotizacion.data as { mensaje?: string }).mensaje ?? 'Un producto ya no está disponible.');
    return json({ error: mensaje }, 422);
  }

  // 2) El cliente confirmo un total: si el vivo difiere, se le muestra ANTES
  // de cobrar nada. La cotizacion recien creada queda huerfana en Supabase —
  // inocua: las cotizaciones son inmutables y sin pedido asociado.
  const totalClp = Number(quote.total_clp ?? 0);
  // Un total no numerico o en 0 no se compara: si el cliente mandara
  // totalConfirmadoClp 0, la igualdad pasaria y cobrariamos un pedido que no
  // vale nada.
  if (!Number.isFinite(totalClp) || totalClp <= 0) {
    return json({ error: 'No pudimos cotizar tu pedido. Escríbenos por WhatsApp y lo vemos.' }, 422);
  }
  if (totalClp !== pedido.totalConfirmadoClp) {
    return json({ recotizado: true, totalClp, totalAnteriorClp: pedido.totalConfirmadoClp }, 409);
  }

  // 3) Crear el pago en el rele. La emision de las ordenes de compra ya no
  // ocurre aca: la hace el webhook del rele cuando Mercado Pago aprueba, por
  // el mismo camino que el bot. Lo que vuelve es el link al que hay que
  // mandar al cliente.
  const pago = await crearPago(armarCuerpoCrearPago(
    { quote_id: quote.quote_id, quote_version: quote.quote_version },
    pedido.comprador,
    pedido.facturacion,
  ));
  if (pago === null) return json({ error: MENSAJE_SIN_LINK }, 503);
  // 409 = sin_vigencia: la cotizacion nacio con menos de 15 minutos. No
  // deberia pasar (tiene segundos de vida), pero si pasa, recotizar es la
  // salida correcta y el cliente la conoce.
  if (pago.status === 409) return json({ error: MENSAJE_SIN_VIGENCIA }, 422);
  // Cualquier otro fallo (401 por nuestra configuracion, 5xx del rele o de
  // Mercado Pago) es nuestro, no del cliente: mensaje generico, sin filtrar
  // el codigo interno.
  if (pago.status !== 200) return json({ error: MENSAJE_SIN_LINK }, 503);
  const initPoint = String(pago.data.init_point ?? '');
  if (!initPoint) return json({ error: MENSAJE_SIN_LINK }, 503);

  // Honestidad del abastecimiento: si alguna linea no sale de stock inmediato,
  // el plazo de entrega no es el de siempre y el cliente tiene que saberlo
  // antes de pagar.
  const lineas = quote.lineas ?? [];
  const porEncargo = lineas.some((l) => l?.abastecimiento !== 'stock_inmediato');
  return json({
    ok: true,
    quoteId: quote.quote_id,
    totalClp,
    initPoint,
    ...(porEncargo ? { avisoAbastecimiento: true } : {}),
  });
}
```

- [ ] **Step 4: Correr las pruebas y verlas pasar, y el typecheck**

Run: `npm test -- apps/tienda`
Expected: PASS, todo (incluidos `pedido`, `relay`, `kapso`).

Run: `npm run typecheck`
Expected: limpio. Si `Checkout.tsx` reclama por `data.noReintentar` no es error de tipos (es `any`), así que debería pasar; el cambio de UI viene en la Task 7.

- [ ] **Step 5: Commit**

```bash
git add apps/tienda/app/api/confirmar/route.ts apps/tienda/tests/confirmar.test.ts
git commit -m "feat(tienda): confirmar crea el pago en el rele en vez de emitir"
```

---

### Task 7: El checkout manda al cliente a Mercado Pago

**Files:**
- Modify: `apps/tienda/app/carro/Checkout.tsx:29-36` (estados), `:69-83` (resultado del POST), `:98` (`trabajando`), `:186-196` (botón y nota)

**Interfaces:**
- Consumes: la respuesta 200 de `/api/confirmar` de la Task 6 (`initPoint`, `totalClp`, `avisoAbastecimiento?`).
- Produces: al confirmar, `window.location.href = data.initPoint`. Guarda en `sessionStorage` `drc-pedido-{quoteId}` = `{ totalClp, avisoAbastecimiento }` (sin `avisoOc`). Desaparecen `bloqueado`, `setBloqueado` y el manejo de `noReintentar`.

No hay prueba unitaria de este componente (es cliente y el repo no monta React en vitest); la verificación es `npm run typecheck` y la de punta a punta de la Task 10.

- [ ] **Step 1: Quitar el bloqueo**

En `apps/tienda/app/carro/Checkout.tsx`, borrar el comentario de tres líneas que empieza con `// Un fallo POSTERIOR a la emision …` y la línea `const [bloqueado, setBloqueado] = useState(false);`. Reemplazar `const trabajando = estado === 'enviando' || bloqueado;` por `const trabajando = estado === 'enviando';`.

- [ ] **Step 2: Redirigir al link de pago**

Reemplazar el bloque desde `if (!res.ok) {` hasta `window.location.href = \`/pedido/${data.quoteId}\`;` (inclusive) por:

```ts
    if (!res.ok) {
      setError(String(data.error ?? 'No pudimos procesar tu pedido.'));
      return;
    }
    if (typeof data.initPoint !== 'string' || !data.initPoint) {
      setError('No pudimos generar el link de pago. Intenta de nuevo.');
      return;
    }
    guardarCarro([]);
    try {
      sessionStorage.setItem(`drc-pedido-${data.quoteId}`, JSON.stringify({
        totalClp: data.totalClp,
        avisoAbastecimiento: data.avisoAbastecimiento === true,
      }));
    } catch { /* opcional */ }
    // Directo a Mercado Pago. Al terminar (o al cerrar), vuelve a
    // /pedido/{quoteId}, que le cuenta el estado real del pago.
    window.location.href = data.initPoint;
```

- [ ] **Step 3: Botón y nota**

Reemplazar el texto del botón mientras envía: `'Consultando precios…'` → `'Preparando el pago…'`. Reemplazar el párrafo `<p className="nota">…</p>` completo por:

```tsx
          <p className="nota">
            Al confirmar te llevamos a Mercado Pago para pagar con tarjeta. Las órdenes a los
            proveedores se cursan solo cuando el pago se acredita, y la entrega la coordinamos
            por WhatsApp.
          </p>
```

- [ ] **Step 4: Typecheck y commit**

Run: `npm run typecheck`
Expected: limpio (ya no se usa `setBloqueado`; si reclama una variable sin usar, borrarla).

```bash
git add apps/tienda/app/carro/Checkout.tsx
git commit -m "feat(tienda): el checkout manda al cliente a Mercado Pago al confirmar"
```

---

### Task 8: `describirPago`: del estado del relé al texto de la página

**Files:**
- Create: `apps/tienda/src/lib/pago.ts`
- Create: `apps/tienda/tests/pago.test.ts`

**Interfaces:**
- Consumes: la respuesta de `GET /api/pago/estado/{id}` (Task 3), tipada acá como `EstadoPago`.
- Produces:
  ```ts
  export interface EstadoPago { estado: 'pendiente' | 'aprobado' | 'emitido' | 'aprobado_sin_emitir'; monto_clp: number; intentos_rechazados: number; expira_at: string; init_point?: string }
  export interface Descripcion { sello: string; titulo: string; texto: string; accion: 'pagar' | 'volver' | 'ninguna'; seguirConsultando: boolean; comprobante: boolean }
  export function describirPago(r: EstadoPago | null): Descripcion
  ```
  `null` = el relé dijo 404. `accion: 'pagar'` implica que `r.init_point` existe. `comprobante` = mostrar la leyenda "guarda el PDF: es el comprobante de tu pedido".

- [ ] **Step 1: Escribir las pruebas que fallan**

Crear `apps/tienda/tests/pago.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { describirPago, type EstadoPago } from '../src/lib/pago.js';

const base: EstadoPago = {
  estado: 'pendiente', monto_clp: 1058793, intentos_rechazados: 0,
  expira_at: '2026-09-16T18:00:00Z', init_point: 'https://mp/pagar',
};

describe('describirPago', () => {
  it('pendiente y vigente: falta pagar, con boton, sigue consultando, sin comprobante', () => {
    const d = describirPago(base);
    expect(d.sello).toBe('Falta pagar');
    expect(d.titulo).toBe('Tu pedido está listo para pagar.');
    expect(d.accion).toBe('pagar');
    expect(d.seguirConsultando).toBe(true);
    expect(d.comprobante).toBe(false);
  });
  it('pendiente con rechazos: lo dice y ofrece reintentar con el mismo link', () => {
    const d = describirPago({ ...base, intentos_rechazados: 1 });
    expect(d.sello).toBe('Pago rechazado');
    expect(d.texto).toContain('reintentar');
    expect(d.accion).toBe('pagar');
    expect(d.seguirConsultando).toBe(true);
  });
  it('pendiente sin init_point: el link vencio, volver a la tienda, no sigue consultando', () => {
    const { init_point: _sinLink, ...vencida } = base;
    const d = describirPago(vencida);
    expect(d.sello).toBe('Link vencido');
    expect(d.texto).toContain('Vuelve a armar el pedido');
    expect(d.accion).toBe('volver');
    expect(d.seguirConsultando).toBe(false);
  });
  it('aprobado: recibimos tu pago, estamos cursando, sigue consultando', () => {
    const d = describirPago({ ...base, estado: 'aprobado', init_point: undefined });
    expect(d.sello).toBe('Pago recibido');
    expect(d.texto).toContain('Estamos cursando el pedido');
    expect(d.accion).toBe('ninguna');
    expect(d.seguirConsultando).toBe(true);
    expect(d.comprobante).toBe(false);
  });
  it('emitido: pedido cursado, comprobante, deja de consultar', () => {
    const d = describirPago({ ...base, estado: 'emitido', init_point: undefined });
    expect(d.sello).toBe('Pedido cursado');
    expect(d.titulo).toBe('Pago recibido ✅ Tu pedido quedó cursado.');
    expect(d.accion).toBe('ninguna');
    expect(d.seguirConsultando).toBe(false);
    expect(d.comprobante).toBe(true);
  });
  it('aprobado_sin_emitir: honesto, no promete que el pedido quedo cursado', () => {
    const d = describirPago({ ...base, estado: 'aprobado_sin_emitir', init_point: undefined });
    expect(d.sello).toBe('Pago recibido');
    expect(d.texto).toContain('te contactamos');
    expect(d.texto).not.toMatch(/cursado/i);
    expect(d.seguirConsultando).toBe(false);
    expect(d.comprobante).toBe(true);
  });
  it('null (404 del rele): no encontramos ese pedido, volver', () => {
    const d = describirPago(null);
    expect(d.titulo).toBe('No encontramos ese pedido.');
    expect(d.accion).toBe('volver');
    expect(d.seguirConsultando).toBe(false);
    expect(d.comprobante).toBe(false);
  });
  it('nunca dice "pagar" sin init_point, ni afirma cursado fuera de emitido', () => {
    for (const estado of ['aprobado', 'emitido', 'aprobado_sin_emitir'] as const) {
      const d = describirPago({ ...base, estado, init_point: undefined });
      expect(d.accion).not.toBe('pagar');
      if (estado !== 'emitido') expect(`${d.titulo} ${d.texto}`).not.toMatch(/quedó cursado/);
    }
  });
});
```

- [ ] **Step 2: Correr la prueba y verla fallar**

Run: `npm test -- apps/tienda/tests/pago.test.ts`
Expected: FAIL, `Cannot find module '../src/lib/pago.js'`.

- [ ] **Step 3: Implementar**

Crear `apps/tienda/src/lib/pago.ts`:

```ts
// Lo que devuelve GET <rele>/api/pago/estado/{quote_id}. El rele es la
// autoridad sobre la vigencia: si la fila esta pendiente y el link sigue
// vivo, manda `init_point`; si no, no. La pagina no calcula fechas.
export interface EstadoPago {
  estado: 'pendiente' | 'aprobado' | 'emitido' | 'aprobado_sin_emitir';
  monto_clp: number;
  intentos_rechazados: number;
  expira_at: string;
  init_point?: string;
}

export interface Descripcion {
  sello: string;
  titulo: string;
  texto: string;
  accion: 'pagar' | 'volver' | 'ninguna';
  // Mientras el desenlace puede cambiar solo (esperando el pago o el
  // webhook), la pagina vuelve a preguntar.
  seguirConsultando: boolean;
  // "Guarda el PDF: es el comprobante de tu pedido" solo cuando hay pedido.
  comprobante: boolean;
}

/**
 * La misma regla que gobierna los mensajes del bot: ninguno afirma algo que
 * el estado no haya verificado. `aprobado_sin_emitir` en particular NO dice
 * que el pedido quedo cursado, porque justamente no lo sabemos.
 */
export function describirPago(r: EstadoPago | null): Descripcion {
  if (r === null) {
    return {
      sello: 'Sin pedido', titulo: 'No encontramos ese pedido.',
      texto: 'Puede que el link esté incompleto. Vuelve a la tienda y arma tu pedido de nuevo.',
      accion: 'volver', seguirConsultando: false, comprobante: false,
    };
  }
  switch (r.estado) {
    case 'pendiente':
      if (!r.init_point) {
        return {
          sello: 'Link vencido', titulo: 'El link de pago venció.',
          texto: 'Los precios se actualizan a diario. Vuelve a armar el pedido para pagarlo con los valores vigentes.',
          accion: 'volver', seguirConsultando: false, comprobante: false,
        };
      }
      if (r.intentos_rechazados > 0) {
        return {
          sello: 'Pago rechazado', titulo: 'El pago fue rechazado.',
          texto: 'Puedes reintentar con el mismo link, con otra tarjeta si prefieres. Las órdenes se cursan solo cuando el pago se acredita.',
          accion: 'pagar', seguirConsultando: true, comprobante: false,
        };
      }
      return {
        sello: 'Falta pagar', titulo: 'Tu pedido está listo para pagar.',
        texto: 'Paga con Mercado Pago y apenas se acredite cursamos las órdenes. Esta página se actualiza sola.',
        accion: 'pagar', seguirConsultando: true, comprobante: false,
      };
    case 'aprobado':
      return {
        sello: 'Pago recibido', titulo: 'Recibimos tu pago.',
        texto: 'Estamos cursando el pedido con los proveedores. Esta página se actualiza sola en unos segundos.',
        accion: 'ninguna', seguirConsultando: true, comprobante: false,
      };
    case 'emitido':
      return {
        sello: 'Pedido cursado', titulo: 'Pago recibido ✅ Tu pedido quedó cursado.',
        texto: 'Te escribimos por WhatsApp para coordinar la entrega. Tu cotización formal queda a tu nombre.',
        accion: 'ninguna', seguirConsultando: false, comprobante: true,
      };
    case 'aprobado_sin_emitir':
      return {
        sello: 'Pago recibido', titulo: 'Recibimos tu pago.',
        texto: 'Estamos terminando de confirmar el pedido y te contactamos por WhatsApp en un rato.',
        accion: 'ninguna', seguirConsultando: false, comprobante: true,
      };
  }
}
```

- [ ] **Step 4: Correr la prueba y verla pasar**

Run: `npm test -- apps/tienda/tests/pago.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/tienda/src/lib/pago.ts apps/tienda/tests/pago.test.ts
git commit -m "feat(tienda): describirPago traduce el estado del pago a lo que ve el cliente"
```

---

### Task 9: La página del pedido consulta y muestra el estado

**Files:**
- Modify: `apps/tienda/app/pedido/[id]/Resumen.tsx` (reescritura completa)
- Modify: `apps/tienda/README.md` (variables, techo y flujo)

**Interfaces:**
- Consumes: `describirPago`, `EstadoPago` (Task 8); `GET ${NEXT_PUBLIC_MAILER_URL}/api/pago/estado/${quoteId}` (Task 3); `formatCLP` (existente).
- Produces: la página. `NEXT_PUBLIC_MAILER_URL` con fallback `https://rr-mailing.vercel.app` (el valor que hoy está hardcodeado como `RELAY`), para que un despliegue sin la variable no rompa el PDF.

No hay prueba unitaria del componente; la lógica ya está probada en `describirPago`. Verificación: `npm run typecheck` y la de punta a punta de la Task 10.

- [ ] **Step 1: Reescribir el componente**

Reemplazar completo `apps/tienda/app/pedido/[id]/Resumen.tsx` por:

```tsx
'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { describirPago, type EstadoPago } from '../../../src/lib/pago.js';
import { formatCLP } from '../../../src/lib/precios.js';

// La URL publica del rele ya viajaba al navegador para el PDF; la api key no
// viaja nunca (el endpoint de estado es publico por URL de capacidad).
const RELAY = process.env.NEXT_PUBLIC_MAILER_URL ?? 'https://rr-mailing.vercel.app';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mientras el desenlace puede cambiar solo, se pregunta cada 3 s durante 2
// minutos (el webhook tarda segundos; 2 minutos cubre un Mercado Pago lento).
// Despues queda el boton "Actualizar": una pestaña olvidada no debe pegarle
// al rele para siempre.
const INTERVALO_MS = 3000;
const MAX_CONSULTAS = 40;

type Consulta =
  | { fase: 'cargando' }
  | { fase: 'ok'; estado: EstadoPago | null }   // null = 404 del rele
  | { fase: 'error' };                           // red, 5xx: no se sabe

export function Resumen({ quoteId }: { quoteId: string }) {
  const [detalle, setDetalle] = useState<{ totalClp: number; avisoAbastecimiento?: boolean } | null>(null);
  const [consulta, setConsulta] = useState<Consulta>({ fase: 'cargando' });
  const [agotado, setAgotado] = useState(false);
  const consultas = useRef(0);

  useEffect(() => {
    try {
      const crudo = sessionStorage.getItem(`drc-pedido-${quoteId}`);
      if (crudo) setDetalle(JSON.parse(crudo));
    } catch { /* sin detalle igual mostramos el estado */ }
  }, [quoteId]);

  const consultar = useCallback(async () => {
    consultas.current += 1;
    try {
      const r = await fetch(`${RELAY}/api/pago/estado/${quoteId}`, { cache: 'no-store' });
      if (r.status === 404) { setConsulta({ fase: 'ok', estado: null }); return; }
      if (!r.ok) { setConsulta({ fase: 'error' }); return; }
      const data = (await r.json()) as EstadoPago;
      setConsulta({ fase: 'ok', estado: data });
    } catch {
      setConsulta({ fase: 'error' });
    }
  }, [quoteId]);

  useEffect(() => {
    if (!UUID_RE.test(quoteId)) return;
    void consultar();
  }, [quoteId, consultar]);

  // Repregunta mientras `describirPago` diga que el desenlace puede cambiar.
  useEffect(() => {
    if (consulta.fase !== 'ok' || consulta.estado === null) return;
    if (!describirPago(consulta.estado).seguirConsultando) return;
    if (consultas.current >= MAX_CONSULTAS) { setAgotado(true); return; }
    const t = setTimeout(() => { void consultar(); }, INTERVALO_MS);
    return () => clearTimeout(t);
  }, [consulta, consultar]);

  if (!UUID_RE.test(quoteId)) {
    return <div className="vacio">No encontramos ese pedido. <a href="/">Volver a la tienda</a></div>;
  }
  if (consulta.fase === 'cargando') {
    return <div className="recibo"><span className="sello">Pedido</span><h1>Consultando el estado del pago…</h1></div>;
  }
  if (consulta.fase === 'error') {
    return (
      <div className="recibo">
        <span className="sello">Pedido</span>
        <h1>No pudimos consultar el estado del pago.</h1>
        <p style={{ marginTop: 16 }}>Puede ser momentáneo. Si ya pagaste, tu pago está registrado en Mercado Pago igual.</p>
        <div className="acciones">
          <button className="boton-compra" type="button" onClick={() => { consultas.current = 0; setAgotado(false); void consultar(); }}>
            Actualizar
          </button>
          <a className="boton-secundario" href="/">Volver a la tienda</a>
        </div>
      </div>
    );
  }

  const d = describirPago(consulta.estado);
  const monto = consulta.estado?.monto_clp ?? detalle?.totalClp;
  return (
    <div className="recibo">
      <span className="sello">{d.sello}</span>
      <h1>{d.titulo}</h1>
      {monto ? (
        <>
          <div className="monto">{formatCLP(monto)}</div>
          <div className="leyenda-iva">IVA incluido</div>
        </>
      ) : null}
      <p style={{ marginTop: 16 }}>{d.texto}</p>
      {/* Honestidad del abastecimiento: alguna linea no salio de stock
          inmediato, asi que el plazo no es el de siempre. */}
      {detalle?.avisoAbastecimiento && consulta.estado !== null ? (
        <div className="aviso" style={{ textAlign: 'left' }}>
          Algún producto de tu pedido viene por encargo. Te confirmamos el plazo cuando
          te escribamos.
        </div>
      ) : null}
      <div className="acciones">
        {d.accion === 'pagar' && consulta.estado?.init_point ? (
          <a className="boton-compra" href={consulta.estado.init_point}>Pagar con Mercado Pago</a>
        ) : null}
        {agotado && d.seguirConsultando ? (
          <button className="boton-compra" type="button" onClick={() => { consultas.current = 0; setAgotado(false); void consultar(); }}>
            Actualizar
          </button>
        ) : null}
        {consulta.estado !== null ? (
          <a className="boton-secundario" href={`${RELAY}/api/cotizacion/${quoteId}`} target="_blank" rel="noreferrer">
            Descargar cotización en PDF
          </a>
        ) : null}
        <a className="boton-secundario" href="/">{d.accion === 'volver' ? 'Volver a la tienda' : 'Seguir buscando'}</a>
      </div>
      {d.comprobante ? (
        <p className="leyenda-iva" style={{ marginTop: 18 }}>Guarda el PDF: es el comprobante de tu pedido.</p>
      ) : null}
    </div>
  );
}
```

- [ ] **Step 2: Typecheck**

Run: `npm run typecheck`
Expected: limpio. Si `boton-compra` como `<a>` no tiene estilo en `apps/tienda/app/globals.css`, revisar que la clase aplique a `a` además de `button` (buscar `.boton-compra` en el css y, si el selector es `button.boton-compra`, cambiarlo a `.boton-compra`).

- [ ] **Step 3: README de la tienda**

En `apps/tienda/README.md`:

1. En la tabla de variables, agregar tres filas al final:

```markdown
| `MAILER_URL` | `https://rr-mailing.vercel.app` — el relé, para pedirle el link de pago (server-side) |
| `MAILER_API_KEY` | la misma `MAILER_API_KEY` del proyecto `rr-mailing`, cargada como **Sensitive** |
| `NEXT_PUBLIC_MAILER_URL` | `https://rr-mailing.vercel.app` — la URL pública del relé que usa el navegador para el PDF y el estado del pago (sin key). Si falta, cae a ese mismo valor |
```

2. Reemplazar en la fila de `NEXT_PUBLIC_RAYO_WA` el paréntesis final `(la tienda no cobra online)` por `(la entrega se coordina por WhatsApp)`.

3. Reemplazar el párrafo que empieza con «Todas son requeridas. El techo de ejecución…» por:

```markdown
Todas son requeridas. El techo de ejecución se fija con `export const
maxDuration` en cada entrypoint: `60` en `/api/confirmar` (cotiza en Kapso, 30s,
y después le pide el link de pago al relé, 15s, en serie) y `30` en el resto
(la búsqueda espera hasta 21s a la pricing-api). Va como segment config de
Next, no en `vercel.json`: en App Router las functions las emite el framework,
y un glob que no calza ninguna hace fallar el build.
```

4. Después de ese párrafo, agregar la sección:

```markdown
## Cómo cobra

Desde el 2026-09-16 la tienda cobra con Mercado Pago a través del servicio de
pagos del relé (`apps/mailer`, `api/pago/*`). Diseño en
`docs/superpowers/specs/2026-09-16-tienda-cobro-design.md`.

1. `/api/confirmar` recotiza en vivo (Kapso) y compara el total, como siempre.
2. En vez de emitir, llama a `POST <MAILER_URL>/api/pago/crear` con
   `origen: "tienda"`, la confirmación y los datos del comprador. El relé crea
   la preferencia, guarda la fila en `pagos` y devuelve el `init_point`.
3. El checkout redirige el navegador a Mercado Pago. Al terminar, Mercado
   Pago vuelve a `/pedido/{quote_id}` (lo decide `TIENDA_BASE_URL` en el relé).
4. La emisión de las órdenes de compra la hace el webhook del relé cuando el
   pago se acredita: el pedido aparece en el backoffice ya en `pagado`.
5. `/pedido/{quote_id}` consulta `GET <NEXT_PUBLIC_MAILER_URL>/api/pago/estado/{quote_id}`
   cada 3 s mientras el desenlace puede cambiar, y muestra el estado con los
   textos de `src/lib/pago.ts`. Ninguno afirma algo que el estado no haya
   verificado.

Una confirmación abandonada deja una cotización huérfana y una fila `pendiente`
en `pagos`; ambas vencen solas. Reintentar `/api/confirmar` es seguro: nada se
emite hasta que hay plata.
```

- [ ] **Step 4: Suite completa y commit**

Run: `npm test` y `npm run typecheck`
Expected: PASS y limpio.

```bash
git add "apps/tienda/app/pedido/[id]/Resumen.tsx" apps/tienda/README.md
git commit -m "feat(tienda): la pagina del pedido muestra el estado real del pago"
```

Si el Step 2 obligó a tocar `apps/tienda/app/globals.css`, incluirlo en el `git add`.

---

### Task 10: Despliegue y verificación de punta a punta

Nada de lo anterior cobra un peso hasta este paso. Va con credenciales de **prueba** de Mercado Pago (las que hoy tiene `rr-mailing`), la cuenta compradora de prueba (`testuser889944460143634460@testuser.com`) y la tarjeta Mastercard `5416 7526 0258 2580`, 11/30, CVV 123, RUT `11111111-1`, titular `APRO` (aprueba) u `OTHE` (rechaza).

**Files:** ninguno. Es operación.

**Interfaces:**
- Consumes: todo lo anterior, mezclado a `main`.
- Produces: la tienda cobrando en el entorno de prueba.

- [ ] **Step 1: Abrir el PR y mezclar**

```bash
git push -u origin feat/tienda-cobro
gh pr create --base main --head feat/tienda-cobro --title "feat(tienda): la tienda cobra con Mercado Pago" --body "<resumen del spec + esta lista de verificación>"
```

Tras el review, mezclar. Los merges a `main` despliegan solos el relé (`rr-mailing`) y la tienda (`dr-computacion`).

- [ ] **Step 2: Variables, en este orden**

1. En Vercel, proyecto `rr-mailing`: `TIENDA_BASE_URL` = la URL de producción de la tienda sin barra final. **Redesplegar** el relé (Deployments → último → Redeploy): Vercel no aplica una variable a un despliegue ya construido.
2. En Vercel, proyecto `dr-computacion`: `MAILER_URL` = `https://rr-mailing.vercel.app`, `MAILER_API_KEY` = la misma del relé (Sensitive), `NEXT_PUBLIC_MAILER_URL` = `https://rr-mailing.vercel.app`. **Redesplegar** la tienda.

- [ ] **Step 3: Humo del relé**

```bash
curl -s https://rr-mailing.vercel.app/api/pago/estado/00000000-0000-4000-8000-000000000000
```

Expected: `404 {"ok":false,"error":"no_encontrado"}` con header `cache-control: no-store` (`curl -si` para verlo). Con el `quote_id` del pago de prueba del 2026-09-15 (`783f3870-4a68-4201-bc37-f780f6a30db4`): 200 con `estado: "emitido"` y **sin** `init_point`.

- [ ] **Step 4: Camino feliz**

1. En la tienda, armar un carro con un producto con stock. En "con quién coordinamos", usar como correo el de la cuenta compradora de prueba. Confirmar.
2. Expected: el navegador va a Mercado Pago. En Supabase, `pagos` tiene una fila `pendiente` con `datos.origen = 'tienda'` y `phone_number_id` nulo; en `pedidos` **no hay nada** para ese `quote_id`.
3. Pagar con `APRO` (en incógnito, logueado como la compradora de prueba o como invitado con ese correo).
4. Expected, en orden: Mercado Pago vuelve a `/pedido/{quote_id}`; la página pasa por "Recibimos tu pago" y en menos de 10 s dice "Pago recibido ✅ Tu pedido quedó cursado" con la leyenda del comprobante; la fila queda `emitido`; el pedido aparece en el backoffice en `pagado`; llega el correo de la orden de compra con su PDF. Si la página se queda en "Recibimos tu pago", mirar el log de `api/pago/webhook` en Vercel: distingue firma, Mercado Pago sin responder y fallo de emisión.

- [ ] **Step 5: Abandono y reintento**

Repetir 1 y 2, cerrar la pestaña de Mercado Pago sin pagar y abrir `/pedido/{quote_id}` a mano. Expected: "Tu pedido está listo para pagar" con el botón "Pagar con Mercado Pago". Pagar desde ahí con `APRO`: el desenlace del Step 4.

- [ ] **Step 6: Rechazo**

Repetir 1 y 2, pagar con `OTHE`. Expected: la página muestra "El pago fue rechazado" con el botón; la fila sigue `pendiente` con `intentos_rechazados = 1`; no hay pedido. Pagar después con `APRO`: cursa.

- [ ] **Step 7: El bot sigue igual**

Una cotización por WhatsApp hasta el sí. Expected: el link llega por WhatsApp, la preferencia vuelve a `/api/pago/retorno` ("vuelve a WhatsApp") y los mensajes de siempre. La fila no lleva `datos.origen`.

- [ ] **Step 8: Cerrar**

Actualizar `apps/tienda/README.md` si algo del flujo real difirió de lo escrito, y anotar en la memoria del proyecto (`pagos-mercado-pago-estado`) que la tienda cobra en prueba y qué quedó pendiente para producción.

---

## Notas de cierre

**Lo que queda pendiente y es deliberado** (del spec, sección «Fuera de alcance»):

- Correo de confirmación al cliente web.
- Vista de `pagos` en el backoffice.
- Colapsar `invocarFunction` (tienda y relé) en un paquete.
- El barrido periódico de filas atascadas en `aprobado`, que el spec anterior marcó como lo primero a hacer. Con la tienda cobrando, la tabla `pagos` recibe más tráfico y ese hueco pesa más: conviene hacerlo antes de pasar a producción.

**El paso a producción** es el mismo del bot: cambiar `MP_ACCESS_TOKEN` y `MP_WEBHOOK_SECRET` en `rr-mailing`, redesplegar, y apuntar el webhook en el panel de Mercado Pago. La tienda no tiene nada propio que cambiar.
