# Pagos con Mercado Pago en el Rayo — plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el bot de WhatsApp cobre con Mercado Pago antes de emitir las órdenes de compra a los mayoristas, en vez de emitirlas contra una promesa de pago.

**Architecture:** El workflow de Kapso pierde el nodo que emite y gana un nodo `webhook` que le pide el link de pago a un servicio nuevo dentro del relé `apps/mailer`. Ese servicio crea la preferencia en Mercado Pago, guarda una fila `pagos` en Supabase y manda el link por WhatsApp. Cuando Mercado Pago avisa que el pago quedó aprobado, el mismo servicio valida la firma, re-consulta el pago, toma la fila con una transición atómica, invoca `emitir-ordenes-compra` por la Platform API y le avisa al cliente.

**Tech Stack:** TypeScript sobre funciones serverless de Vercel (`@vercel/node`), `fetch` pelado sin SDK, Supabase REST, vitest con `fetch` stubbeado, `node:crypto` para HMAC y comparación en tiempo constante.

**Spec:** `docs/superpowers/specs/2026-09-10-pagos-mercado-pago-design.md`

## Global Constraints

- **Kapso está en 5 de 5 Cloudflare Workers.** Ninguna tarea puede crear una function nueva de Kapso. El cobro entra por un nodo `webhook`, que no consume cupo.
- **`emitir-ordenes-compra` no se modifica.** Su guard de vigencia (409 si la cotización venció) y su idempotencia D1 son la red de seguridad; el plan se apoya en ellos.
- **La única function de Kapso que se toca es `generar-cotizacion-v2`**, y solo para persistir un campo más.
- **Holgura de vigencia: 15 minutos.** Constante `MARGEN_VIGENCIA_MS = 15 * 60 * 1000`. El link expira a `valid_until − 15 min`, y por debajo de esa holgura no se crea link.
- **Medios excluidos:** `ticket` y `atm`.
- **Moneda:** `CLP`, sin decimales. Los montos viajan como enteros.
- **Nunca se loguea el cuerpo de un webhook, ni un payload de pago, ni una credencial.** Solo etapa y tipo de fallo, siguiendo `apps/tienda/src/lib/kapso.ts`.
- **Ningún dato del cuerpo del webhook decide nada.** El monto y la referencia salen siempre de `GET /v1/payments/{id}`.
- **Estados de `pagos`:** `pendiente → aprobado → {emitido | aprobado_sin_emitir}`. Un pago rechazado **no** cambia el estado; incrementa `intentos_rechazados`.
- **Nombres de variables de entorno nuevas:** `MP_ACCESS_TOKEN`, `MP_WEBHOOK_SECRET`, `PAGO_BASE_URL`, `KAPSO_API_KEY`.
- **Todo test corre con `npm test` desde la raíz** (vitest ya incluye `apps/**/tests/**/*.test.ts`).
- **Commits en español**, con el prefijo del repositorio (`feat(pagos):`, `fix(pagos):`, `docs:`).

## Estructura de archivos

| Archivo | Responsabilidad |
|---|---|
| `docs/sql/2026-09-10-pagos.sql` | Tabla `pagos` y columna `cotizaciones.proveedores_incompletos` |
| `apps/kapso-agent/functions/generar-cotizacion-v2.js` | (modificar) persistir `proveedores_incompletos` |
| `apps/mailer/src/pago/firma.ts` | Parseo de `x-signature` y validación HMAC. Puro |
| `apps/mailer/src/pago/mercadopago.ts` | Armado del cuerpo de la preferencia y las dos llamadas HTTP a Mercado Pago |
| `apps/mailer/src/pago/quote.ts` | Reconstrucción del `quote_result` y armado del payload de emisión. Puro |
| `apps/mailer/src/pago/datos.ts` | Todo el acceso a Supabase de esta feature |
| `apps/mailer/src/pago/kapso.ts` | Invocar functions por Platform API y mandar mensajes de WhatsApp |
| `apps/mailer/src/pago/mensajes.ts` | Los seis textos al cliente. Puro |
| `apps/mailer/src/pago/crear.ts` | Handler de `POST /api/pago/crear` |
| `apps/mailer/src/pago/webhook.ts` | Handler de `POST /api/pago/webhook` (la máquina de estados) |
| `apps/mailer/api/pago/crear.ts` · `webhook.ts` · `retorno.ts` | Envoltorios finos, patrón de `api/send.ts` |
| `apps/kapso-agent/scripts/deploy-workflow.ts` | (modificar) cirugía del grafo |
| `apps/kapso-agent/prompts/agente-cierre/v-03.md` | El cierre anuncia el link de pago |

---

### Task 1: Esquema y persistencia de `proveedores_incompletos`

El servicio reconstruye el `quote_result` desde la fila de `cotizaciones`. `emitir-ordenes-compra` lee cinco campos de la cotización y `proveedores_incompletos` es el único que hoy no se persiste; sin él, el correo de la orden pierde en silencio el aviso de qué mayorista no respondió.

**Files:**
- Create: `docs/sql/2026-09-10-pagos.sql`
- Modify: `apps/kapso-agent/functions/generar-cotizacion-v2.js` (el `POST /cotizaciones`)
- Test: `apps/kapso-agent/tests/generar-cotizacion-v2.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: la tabla `pagos` y la columna `cotizaciones.proveedores_incompletos jsonb`, que la Task 4 lee.

- [ ] **Step 1: Escribir el SQL**

Crear `docs/sql/2026-09-10-pagos.sql`:

```sql
-- Pagos con Mercado Pago (spec 2026-09-10). Se ejecuta UNA vez en el SQL
-- Editor de Supabase. Idempotente.

-- `quote_id` es la llave: un intento de cobro por cotizacion. Eso da la
-- idempotencia de `POST /api/pago/crear` -- una segunda llamada por la misma
-- cotizacion devuelve el link que ya existe en vez de crear otra preferencia.
create table if not exists pagos (
  quote_id            text primary key,
  quote_version       text not null,
  numero              bigint,
  telefono            text,
  phone_number_id     text,
  preference_id       text not null,
  init_point          text not null,
  monto_clp           bigint not null,
  expira_at           timestamptz not null,
  -- Un pago rechazado NO es un estado: una tarjeta rechazada seguida de un
  -- segundo intento exitoso es comun, y un estado terminal haria fallar la
  -- transicion condicional a 'aprobado' justo en el intento bueno.
  estado              text not null default 'pendiente'
    check (estado in ('pendiente','aprobado','emitido','aprobado_sin_emitir')),
  mp_payment_id       text,
  intentos_rechazados int not null default 0,
  -- quote_customer_name y los siete billing_*: lo que emitir-ordenes-compra
  -- espera en `vars` y no vive en ninguna otra tabla.
  datos               jsonb not null,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  aprobado_at         timestamptz,
  emitido_at          timestamptz
);

-- RLS sin policies, igual que las otras tres tablas: el unico acceso legitimo
-- es la service_role, que bypasea RLS por definicion.
alter table pagos enable row level security;

-- El quinto campo que emitir-ordenes-compra lee de la cotizacion y que hasta
-- hoy no se guardaba. Sin el, el correo de la orden pierde el aviso "al
-- cotizar no respondieron X".
alter table cotizaciones add column if not exists proveedores_incompletos jsonb;
```

- [ ] **Step 2: Escribir el test que falla**

En `apps/kapso-agent/tests/generar-cotizacion-v2.test.ts`, dentro del `describe` que ya cubre la persistencia, agregar:

```ts
it('persiste proveedores_incompletos en la fila de cotizaciones', async () => {
  const cuerpos: any[] = [];
  routeFetch({
    supabase: (url, init) => {
      if (url.includes('/cotizaciones')) cuerpos.push(JSON.parse(String(init?.body)));
      return url.includes('/clientes') ? [] : {};
    },
  });
  await handler(request({ execution_context: { vars: CART_VARS, ...CTX } }), ENV_SB);
  expect(cuerpos).toHaveLength(1);
  // La clave tiene que existir aunque no falte ningun proveedor: una columna
  // que a veces no se escribe deja filas viejas indistinguibles de "no se
  // supo", y el aviso del correo de la orden depende de esa diferencia.
  expect(cuerpos[0]).toHaveProperty('proveedores_incompletos');
  expect(Array.isArray(cuerpos[0].proveedores_incompletos)).toBe(true);
});
```

- [ ] **Step 3: Correr el test y verificar que falla**

Run: `npx vitest run apps/kapso-agent/tests/generar-cotizacion-v2.test.ts -t "proveedores_incompletos"`
Expected: FAIL — `expect(received).toHaveProperty("proveedores_incompletos")`.

- [ ] **Step 4: Agregar el campo al POST**

En `apps/kapso-agent/functions/generar-cotizacion-v2.js`, en el objeto del `supabase(env, "POST", "/cotizaciones?select=numero", {...})`, agregar una línea después de `lineas: quote.lineas`:

```js
        lineas: quote.lineas,
        proveedores_incompletos: quote.proveedores_incompletos
```

- [ ] **Step 5: Correr los tests de la function completos**

Run: `npx vitest run apps/kapso-agent/tests/generar-cotizacion-v2.test.ts`
Expected: PASS, todos.

- [ ] **Step 6: Commit**

```bash
git add docs/sql/2026-09-10-pagos.sql apps/kapso-agent/functions/generar-cotizacion-v2.js apps/kapso-agent/tests/generar-cotizacion-v2.test.ts
git commit -m "feat(pagos): tabla pagos y proveedores_incompletos en cotizaciones"
```

- [ ] **Step 7: Ejecutar el SQL en Supabase**

Pegar `docs/sql/2026-09-10-pagos.sql` en el SQL Editor de Supabase y ejecutarlo. Es idempotente. Verificar que `pagos` aparece en el Table Editor y que `cotizaciones` tiene la columna nueva.

---

### Task 2: Validación de la firma del webhook

Mercado Pago firma cada notificación con HMAC-SHA256. Es lo único que separa el endpoint público de cualquiera que sepa la URL, así que va primero y con pruebas propias.

**Files:**
- Create: `apps/mailer/src/pago/firma.ts`
- Test: `apps/mailer/tests/pago-firma.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `parseSignature(header: string | undefined): { ts: string; v1: string } | null`
  - `construirManifiesto(dataId: string, requestId: string | undefined, ts: string): string`
  - `firmaValida(params: { dataId: string; requestId?: string; header?: string; secret: string }): boolean`

- [ ] **Step 1: Escribir el test que falla**

Crear `apps/mailer/tests/pago-firma.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { construirManifiesto, firmaValida, parseSignature } from '../src/pago/firma.js';

const SECRET = 'secreto-de-prueba';
const DATA_ID = '123456789';
const REQUEST_ID = 'bb56a2f1-6aae-46ac-982e-9dcd3581d08e';
const TS = '1742505638683';

function firmar(manifiesto: string, secret = SECRET): string {
  return createHmac('sha256', secret).update(manifiesto).digest('hex');
}

describe('parseSignature', () => {
  it('extrae ts y v1 del header', () => {
    expect(parseSignature(`ts=${TS},v1=abc123`)).toEqual({ ts: TS, v1: 'abc123' });
  });

  it('tolera espacios y orden invertido', () => {
    expect(parseSignature(` v1=abc123 , ts=${TS} `)).toEqual({ ts: TS, v1: 'abc123' });
  });

  it('sin header, sin ts o sin v1 devuelve null', () => {
    expect(parseSignature(undefined)).toBeNull();
    expect(parseSignature('ts=1')).toBeNull();
    expect(parseSignature('v1=abc')).toBeNull();
    expect(parseSignature('basura')).toBeNull();
  });
});

describe('construirManifiesto', () => {
  it('arma el template completo con el id en minusculas', () => {
    expect(construirManifiesto('ABC123', REQUEST_ID, TS))
      .toBe(`id:abc123;request-id:${REQUEST_ID};ts:${TS};`);
  });

  it('omite request-id cuando no llego en la notificacion', () => {
    expect(construirManifiesto(DATA_ID, undefined, TS)).toBe(`id:${DATA_ID};ts:${TS};`);
  });
});

describe('firmaValida', () => {
  it('acepta una firma legitima', () => {
    const header = `ts=${TS},v1=${firmar(construirManifiesto(DATA_ID, REQUEST_ID, TS))}`;
    expect(firmaValida({ dataId: DATA_ID, requestId: REQUEST_ID, header, secret: SECRET })).toBe(true);
  });

  it('rechaza una firma de otro secreto', () => {
    const header = `ts=${TS},v1=${firmar(construirManifiesto(DATA_ID, REQUEST_ID, TS), 'otro')}`;
    expect(firmaValida({ dataId: DATA_ID, requestId: REQUEST_ID, header, secret: SECRET })).toBe(false);
  });

  it('rechaza cuando el dataId no es el firmado (replay contra otro pago)', () => {
    const header = `ts=${TS},v1=${firmar(construirManifiesto(DATA_ID, REQUEST_ID, TS))}`;
    expect(firmaValida({ dataId: '999', requestId: REQUEST_ID, header, secret: SECRET })).toBe(false);
  });

  it('rechaza header ausente, malformado o secreto vacio', () => {
    const header = `ts=${TS},v1=${firmar(construirManifiesto(DATA_ID, REQUEST_ID, TS))}`;
    expect(firmaValida({ dataId: DATA_ID, requestId: REQUEST_ID, header: undefined, secret: SECRET })).toBe(false);
    expect(firmaValida({ dataId: DATA_ID, requestId: REQUEST_ID, header: 'basura', secret: SECRET })).toBe(false);
    expect(firmaValida({ dataId: DATA_ID, requestId: REQUEST_ID, header, secret: '' })).toBe(false);
  });

  it('una v1 de largo distinto no revienta, devuelve false', () => {
    expect(firmaValida({ dataId: DATA_ID, requestId: REQUEST_ID, header: `ts=${TS},v1=ab`, secret: SECRET })).toBe(false);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run apps/mailer/tests/pago-firma.test.ts`
Expected: FAIL — no existe `../src/pago/firma.js`.

- [ ] **Step 3: Implementar**

Crear `apps/mailer/src/pago/firma.ts`:

```ts
import { createHmac, timingSafeEqual } from 'node:crypto';

/**
 * Valida la firma HMAC-SHA256 con que Mercado Pago firma cada notificacion.
 * Es lo unico que separa este endpoint publico de cualquiera que sepa la URL,
 * asi que ante la menor duda se devuelve false.
 */

// El header llega como `ts=1742505638683,v1=<hex>`.
export function parseSignature(header: string | undefined): { ts: string; v1: string } | null {
  if (!header) return null;
  const partes: Record<string, string> = {};
  for (const trozo of header.split(',')) {
    const i = trozo.indexOf('=');
    if (i < 0) continue;
    partes[trozo.slice(0, i).trim()] = trozo.slice(i + 1).trim();
  }
  return partes.ts && partes.v1 ? { ts: partes.ts, v1: partes.v1 } : null;
}

// El template de Mercado Pago. Un valor que no vino en la notificacion se
// omite entero, no se deja vacio: firmar `request-id:;` daria distinto.
export function construirManifiesto(dataId: string, requestId: string | undefined, ts: string): string {
  let manifiesto = `id:${dataId.toLowerCase()};`;
  if (requestId) manifiesto += `request-id:${requestId};`;
  manifiesto += `ts:${ts};`;
  return manifiesto;
}

export function firmaValida(params: {
  dataId: string;
  requestId?: string;
  header?: string;
  secret: string;
}): boolean {
  if (!params.secret || !params.dataId) return false;
  const firma = parseSignature(params.header);
  if (!firma) return false;

  const esperada = createHmac('sha256', params.secret)
    .update(construirManifiesto(params.dataId, params.requestId, firma.ts))
    .digest('hex');

  // timingSafeEqual revienta si los largos difieren, y el largo de un hex de
  // sha256 es publico: compararlo antes no filtra nada.
  const recibida = Buffer.from(firma.v1);
  const buffer = Buffer.from(esperada);
  return recibida.length === buffer.length && timingSafeEqual(recibida, buffer);
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run apps/mailer/tests/pago-firma.test.ts`
Expected: PASS, 10 casos.

- [ ] **Step 5: Commit**

```bash
git add apps/mailer/src/pago/firma.ts apps/mailer/tests/pago-firma.test.ts
git commit -m "feat(pagos): validacion de la firma del webhook de Mercado Pago"
```

---

### Task 3: Cliente de Mercado Pago

Dos llamadas HTTP y un armador de cuerpo. Sin SDK: el repositorio ya integra cinco servicios con `fetch` pelado y se prueba igual.

**Files:**
- Create: `apps/mailer/src/pago/mercadopago.ts`
- Test: `apps/mailer/tests/pago-mercadopago.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `MARGEN_VIGENCIA_MS: number`
  - `construirPreferencia(p: DatosPreferencia): Record<string, unknown>`
  - `crearPreferencia(cuerpo, token, quoteId): Promise<{ id: string; init_point: string } | null>`
  - `consultarPago(paymentId, token): Promise<PagoMP | null>`
  - tipos `DatosPreferencia` y `PagoMP`

- [ ] **Step 1: Escribir el test que falla**

Crear `apps/mailer/tests/pago-mercadopago.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  MARGEN_VIGENCIA_MS,
  construirPreferencia,
  consultarPago,
  crearPreferencia,
} from '../src/pago/mercadopago.js';

afterEach(() => vi.unstubAllGlobals());

const BASE = {
  quoteId: 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4',
  numero: 1600001,
  montoClp: 219725,
  nombre: 'Acme SpA',
  email: 'contacto@acme.cl',
  baseUrl: 'https://rr-mailing.vercel.app',
  validUntil: '2026-09-10T18:00:00.000Z',
};

describe('construirPreferencia', () => {
  it('cobra el total como un solo item en CLP', () => {
    const p: any = construirPreferencia(BASE);
    expect(p.items).toHaveLength(1);
    expect(p.items[0].unit_price).toBe(219725);
    expect(p.items[0].quantity).toBe(1);
    expect(p.items[0].currency_id).toBe('CLP');
    expect(p.items[0].title).toBe('Pedido N° 1600001');
  });

  it('external_reference es el quote_id: es como el webhook encuentra la fila', () => {
    expect((construirPreferencia(BASE) as any).external_reference).toBe(BASE.quoteId);
  });

  it('el link expira 15 minutos antes que la cotizacion', () => {
    const p: any = construirPreferencia(BASE);
    expect(p.expires).toBe(true);
    expect(Date.parse(p.expiration_date_to))
      .toBe(Date.parse(BASE.validUntil) - MARGEN_VIGENCIA_MS);
  });

  it('excluye los medios que no aprueban en el acto', () => {
    const p: any = construirPreferencia(BASE);
    const excluidos = p.payment_methods.excluded_payment_types.map((t: any) => t.id).sort();
    expect(excluidos).toEqual(['atm', 'ticket']);
  });

  it('apunta el webhook y el retorno a nuestra base', () => {
    const p: any = construirPreferencia(BASE);
    expect(p.notification_url).toBe('https://rr-mailing.vercel.app/api/pago/webhook');
    expect(p.back_urls.success).toBe('https://rr-mailing.vercel.app/api/pago/retorno');
  });
});

describe('crearPreferencia', () => {
  it('postea con bearer e idempotencia y devuelve id e init_point', async () => {
    const spy = vi.fn(async (url: any, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.mercadopago.com/checkout/preferences');
      const headers = init?.headers as Record<string, string>;
      expect(headers.Authorization).toBe('Bearer token-de-prueba');
      expect(headers['X-Idempotency-Key']).toBe(BASE.quoteId);
      return new Response(JSON.stringify({ id: 'pref-1', init_point: 'https://mp/pagar' }), { status: 201 });
    });
    vi.stubGlobal('fetch', spy);
    const r = await crearPreferencia({ hola: 1 }, 'token-de-prueba', BASE.quoteId);
    expect(r).toEqual({ id: 'pref-1', init_point: 'https://mp/pagar' });
  });

  it('un status de error o una respuesta sin init_point devuelven null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
    expect(await crearPreferencia({}, 't', BASE.quoteId)).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ id: 'x' }), { status: 201 })));
    expect(await crearPreferencia({}, 't', BASE.quoteId)).toBeNull();
  });

  it('la red caida devuelve null, no revienta', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(await crearPreferencia({}, 't', BASE.quoteId)).toBeNull();
  });
});

describe('consultarPago', () => {
  it('trae status, monto y referencia del pago', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.mercadopago.com/v1/payments/9999');
      expect((init?.headers as Record<string, string>).Authorization).toBe('Bearer t');
      return new Response(JSON.stringify({
        id: 9999, status: 'approved', status_detail: 'accredited',
        external_reference: BASE.quoteId, transaction_amount: 219725,
      }), { status: 200 });
    }));
    const pago = await consultarPago('9999', 't');
    expect(pago?.status).toBe('approved');
    expect(pago?.transaction_amount).toBe(219725);
    expect(pago?.external_reference).toBe(BASE.quoteId);
  });

  it('404 o red caida devuelven null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 404 })));
    expect(await consultarPago('1', 't')).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('timeout'); }));
    expect(await consultarPago('1', 't')).toBeNull();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run apps/mailer/tests/pago-mercadopago.test.ts`
Expected: FAIL — no existe `../src/pago/mercadopago.js`.

- [ ] **Step 3: Implementar**

Crear `apps/mailer/src/pago/mercadopago.ts`:

```ts
const API = 'https://api.mercadopago.com';
const TIMEOUT_MS = 10000;

// El link de pago muere 15 minutos antes que la cotizacion, para que un pago
// iniciado justo antes del cierre alcance a completarse dentro de la vigencia:
// emitir-ordenes-compra rechaza con 409 cualquier cotizacion vencida.
export const MARGEN_VIGENCIA_MS = 15 * 60 * 1000;

export interface DatosPreferencia {
  quoteId: string;
  numero: number | null;
  montoClp: number;
  nombre: string;
  email: string;
  baseUrl: string;
  validUntil: string;
}

export interface PagoMP {
  id: number | string;
  status: string;
  status_detail?: string;
  external_reference?: string;
  transaction_amount?: number;
}

// Solo registra etapa y tipo de fallo. Nunca el cuerpo ni el token.
function registrar(etapa: string, detalle: string): void {
  console.error(`[pago] ${etapa} fallo`, { detalle });
}

function tipoDeFallo(error: unknown): string {
  if (error instanceof Error) return error.name === 'TimeoutError' ? 'timeout' : error.name;
  return 'desconocido';
}

export function construirPreferencia(p: DatosPreferencia): Record<string, unknown> {
  const base = p.baseUrl.replace(/\/+$/, '');
  const retorno = `${base}/api/pago/retorno`;
  return {
    items: [{
      id: p.quoteId,
      title: p.numero != null ? `Pedido N° ${p.numero}` : 'Pedido',
      quantity: 1,
      unit_price: p.montoClp,
      currency_id: 'CLP',
    }],
    payer: { name: p.nombre, email: p.email },
    // La llave con que el webhook encuentra la fila de `pagos`.
    external_reference: p.quoteId,
    notification_url: `${base}/api/pago/webhook`,
    back_urls: { success: retorno, failure: retorno, pending: retorno },
    auto_return: 'approved',
    expires: true,
    expiration_date_to: new Date(Date.parse(p.validUntil) - MARGEN_VIGENCIA_MS).toISOString(),
    // Efectivo y cajero quedan `pending` por dias: dejarian pedidos en limbo
    // con la cotizacion vencida hace rato. Las cuotas se dejan como vengan
    // por defecto (fuera de alcance de esta fase).
    payment_methods: { excluded_payment_types: [{ id: 'ticket' }, { id: 'atm' }] },
  };
}

export async function crearPreferencia(
  cuerpo: unknown,
  token: string,
  quoteId: string,
): Promise<{ id: string; init_point: string } | null> {
  try {
    const r = await fetch(`${API}/checkout/preferences`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        // Un reintento por la misma cotizacion no crea una segunda preferencia.
        'X-Idempotency-Key': quoteId,
      },
      body: JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) {
      registrar('crear-preferencia', `status ${r.status}`);
      return null;
    }
    const data = (await r.json().catch(() => ({}))) as { id?: string; init_point?: string };
    if (!data.id || !data.init_point) {
      registrar('crear-preferencia', 'respuesta sin id o init_point');
      return null;
    }
    return { id: String(data.id), init_point: String(data.init_point) };
  } catch (error) {
    registrar('crear-preferencia', tipoDeFallo(error));
    return null;
  }
}

export async function consultarPago(paymentId: string, token: string): Promise<PagoMP | null> {
  try {
    const r = await fetch(`${API}/v1/payments/${encodeURIComponent(paymentId)}`, {
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) {
      registrar('consultar-pago', `status ${r.status}`);
      return null;
    }
    return (await r.json()) as PagoMP;
  } catch (error) {
    registrar('consultar-pago', tipoDeFallo(error));
    return null;
  }
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run apps/mailer/tests/pago-mercadopago.test.ts`
Expected: PASS, 9 casos.

- [ ] **Step 5: Commit**

```bash
git add apps/mailer/src/pago/mercadopago.ts apps/mailer/tests/pago-mercadopago.test.ts
git commit -m "feat(pagos): cliente de Mercado Pago (preferencia y consulta de pago)"
```

---

### Task 4: Acceso a Supabase de la feature

Todo el SQL-por-REST en un archivo. Lo importante acá es `reclamarAprobado`: la transición condicional que hace que un reintento de Mercado Pago no emita una segunda orden de compra.

**Files:**
- Create: `apps/mailer/src/pago/datos.ts`
- Test: `apps/mailer/tests/pago-datos.test.ts`

**Interfaces:**
- Consumes: la tabla `pagos` y la columna nueva (Task 1).
- Produces:
  - tipos `PagoEnv`, `CotizacionRow`, `PagoRow`
  - `leerCotizacion(env, quoteId): Promise<CotizacionRow | null | undefined>` — `null` = no existe, `undefined` = no se pudo preguntar
  - `leerPago(env, quoteId): Promise<PagoRow | null | undefined>`
  - `crearPago(env, fila): Promise<boolean>`
  - `reclamarAprobado(env, quoteId, mpPaymentId): Promise<boolean>`
  - `marcarEstado(env, quoteId, estado, extra?): Promise<boolean>`
  - `sumarRechazo(env, quoteId, mpPaymentId): Promise<boolean>`
  - `marcarPedidosPagados(env, quoteId): Promise<boolean>`

- [ ] **Step 1: Escribir el test que falla**

Crear `apps/mailer/tests/pago-datos.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  crearPago, leerCotizacion, leerPago, marcarEstado,
  marcarPedidosPagados, reclamarAprobado, sumarRechazo,
} from '../src/pago/datos.js';

const ENV = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_KEY: 'clave' };
const QUOTE = 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4';

afterEach(() => vi.unstubAllGlobals());

function stub(responder: (url: string, init?: RequestInit) => Response) {
  const spy = vi.fn(async (url: any, init?: RequestInit) => responder(String(url), init));
  vi.stubGlobal('fetch', spy);
  return spy;
}

describe('leerCotizacion', () => {
  it('devuelve la fila', async () => {
    stub(() => new Response(JSON.stringify([{ quote_id: QUOTE, total_clp: 1190 }]), { status: 200 }));
    expect((await leerCotizacion(ENV, QUOTE))?.total_clp).toBe(1190);
  });

  it('distingue "no existe" (null) de "no se pudo preguntar" (undefined)', async () => {
    stub(() => new Response('[]', { status: 200 }));
    expect(await leerCotizacion(ENV, QUOTE)).toBeNull();
    stub(() => new Response('{}', { status: 500 }));
    expect(await leerCotizacion(ENV, QUOTE)).toBeUndefined();
  });
});

describe('reclamarAprobado', () => {
  it('condiciona el PATCH a estado=pendiente y devuelve true si tomo la fila', async () => {
    const spy = stub((url) => {
      expect(url).toContain('quote_id=eq.' + QUOTE);
      expect(url).toContain('estado=eq.pendiente');
      return new Response(JSON.stringify([{ quote_id: QUOTE }]), { status: 200 });
    });
    expect(await reclamarAprobado(ENV, QUOTE, '999')).toBe(true);
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe('PATCH');
  });

  it('cero filas significa que otra entrega del webhook ya la tomo', async () => {
    stub(() => new Response('[]', { status: 200 }));
    expect(await reclamarAprobado(ENV, QUOTE, '999')).toBe(false);
  });

  it('un fallo de Supabase devuelve false: no se emite a ciegas', async () => {
    stub(() => new Response('{}', { status: 500 }));
    expect(await reclamarAprobado(ENV, QUOTE, '999')).toBe(false);
  });
});

describe('marcarPedidosPagados', () => {
  it('solo toca los pedidos que siguen en nuevo', async () => {
    const spy = stub((url) => {
      expect(url).toContain('estado_negocio=eq.nuevo');
      return new Response('[]', { status: 200 });
    });
    expect(await marcarPedidosPagados(ENV, QUOTE)).toBe(true);
    const body = JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body));
    expect(body.estado_negocio).toBe('pagado');
    expect(body.pagado_at).toBeTruthy();
  });
});

describe('sumarRechazo', () => {
  it('no cambia el estado, solo el contador y el ultimo payment id', async () => {
    const spy = stub(() => new Response(JSON.stringify([{ intentos_rechazados: 1 }]), { status: 200 }));
    await sumarRechazo(ENV, QUOTE, '999');
    const body = JSON.parse(String((spy.mock.calls.at(-1)![1] as RequestInit).body));
    expect(body).not.toHaveProperty('estado');
    expect(body.mp_payment_id).toBe('999');
  });
});

describe('crearPago, leerPago y marcarEstado', () => {
  it('crearPago postea la fila y devuelve true', async () => {
    const spy = stub(() => new Response('[]', { status: 201 }));
    expect(await crearPago(ENV, { quote_id: QUOTE } as any)).toBe(true);
    expect((spy.mock.calls[0][1] as RequestInit).method).toBe('POST');
  });

  it('leerPago devuelve null cuando no hay fila', async () => {
    stub(() => new Response('[]', { status: 200 }));
    expect(await leerPago(ENV, QUOTE)).toBeNull();
  });

  it('marcarEstado escribe el estado y los extras', async () => {
    const spy = stub(() => new Response('[]', { status: 200 }));
    expect(await marcarEstado(ENV, QUOTE, 'emitido', { emitido_at: '2026-09-10T00:00:00.000Z' })).toBe(true);
    const body = JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body));
    expect(body.estado).toBe('emitido');
    expect(body.emitido_at).toBe('2026-09-10T00:00:00.000Z');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run apps/mailer/tests/pago-datos.test.ts`
Expected: FAIL — no existe `../src/pago/datos.js`.

- [ ] **Step 3: Implementar**

Crear `apps/mailer/src/pago/datos.ts`:

```ts
const TIMEOUT_MS = 8000;

export interface PagoEnv {
  SUPABASE_URL?: string;
  SUPABASE_SERVICE_KEY?: string;
}

export interface CotizacionRow {
  quote_id: string;
  version: string;
  numero?: number | null;
  telefono?: string | null;
  total_clp: number;
  valida_hasta: string;
  lineas: unknown[];
  proveedores_incompletos?: unknown[] | null;
}

export interface PagoRow {
  quote_id: string;
  quote_version: string;
  numero?: number | null;
  telefono?: string | null;
  phone_number_id?: string | null;
  preference_id: string;
  init_point: string;
  monto_clp: number;
  expira_at: string;
  estado: 'pendiente' | 'aprobado' | 'emitido' | 'aprobado_sin_emitir';
  mp_payment_id?: string | null;
  intentos_rechazados?: number;
  datos: Record<string, unknown>;
}

function registrar(etapa: string, detalle: string): void {
  console.error(`[pago/datos] ${etapa} fallo`, { detalle });
}

// Devuelve null cuando la llamada fallo, para que el caller distinga "no se
// pudo preguntar" de "la respuesta vino vacia".
async function pedir(
  env: PagoEnv,
  metodo: string,
  path: string,
  cuerpo?: unknown,
  prefer?: string,
): Promise<unknown[] | null> {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;
  const base = env.SUPABASE_URL.replace(/\/+$/, '');
  try {
    const r = await fetch(`${base}/rest/v1${path}`, {
      method: metodo,
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        'Content-Type': 'application/json',
        Prefer: prefer ?? 'return=representation',
      },
      body: cuerpo === undefined ? undefined : JSON.stringify(cuerpo),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) {
      registrar(`${metodo} ${path.split('?')[0]}`, `status ${r.status}`);
      return null;
    }
    const texto = await r.text();
    if (!texto) return [];
    try {
      const data = JSON.parse(texto);
      return Array.isArray(data) ? data : [data];
    } catch {
      return [];
    }
  } catch (error) {
    registrar(`${metodo} ${path.split('?')[0]}`, error instanceof Error ? error.name : 'desconocido');
    return null;
  }
}

const ahora = () => new Date().toISOString();

// null = no existe · undefined = no se pudo preguntar.
export async function leerCotizacion(env: PagoEnv, quoteId: string): Promise<CotizacionRow | null | undefined> {
  const filas = await pedir(env, 'GET', `/cotizaciones?quote_id=eq.${encodeURIComponent(quoteId)}&limit=1`);
  if (filas === null) return undefined;
  return (filas[0] as CotizacionRow | undefined) ?? null;
}

export async function leerPago(env: PagoEnv, quoteId: string): Promise<PagoRow | null | undefined> {
  const filas = await pedir(env, 'GET', `/pagos?quote_id=eq.${encodeURIComponent(quoteId)}&limit=1`);
  if (filas === null) return undefined;
  return (filas[0] as PagoRow | undefined) ?? null;
}

export async function crearPago(env: PagoEnv, fila: PagoRow): Promise<boolean> {
  return (await pedir(env, 'POST', '/pagos', fila)) !== null;
}

/**
 * La transicion que sostiene toda la idempotencia del webhook: el PATCH va
 * condicionado a `estado=eq.pendiente`, asi que la segunda entrega de la misma
 * notificacion devuelve cero filas y no emite nada. Mismo patron condicional
 * que apps/backoffice/app/api/pedidos/transicion/route.ts.
 */
export async function reclamarAprobado(env: PagoEnv, quoteId: string, mpPaymentId: string): Promise<boolean> {
  const filas = await pedir(
    env,
    'PATCH',
    `/pagos?quote_id=eq.${encodeURIComponent(quoteId)}&estado=eq.pendiente`,
    { estado: 'aprobado', mp_payment_id: mpPaymentId, aprobado_at: ahora(), updated_at: ahora() },
  );
  return filas !== null && filas.length > 0;
}

export async function marcarEstado(
  env: PagoEnv,
  quoteId: string,
  estado: PagoRow['estado'],
  extra: Record<string, unknown> = {},
): Promise<boolean> {
  const filas = await pedir(env, 'PATCH', `/pagos?quote_id=eq.${encodeURIComponent(quoteId)}`, {
    estado, updated_at: ahora(), ...extra,
  });
  return filas !== null;
}

/**
 * Un rechazo NO cambia el estado: la fila sigue `pendiente` para que el
 * siguiente intento con el mismo link pueda reclamarla.
 */
export async function sumarRechazo(env: PagoEnv, quoteId: string, mpPaymentId: string): Promise<boolean> {
  const actual = await leerPago(env, quoteId);
  if (!actual) return false;
  const filas = await pedir(env, 'PATCH', `/pagos?quote_id=eq.${encodeURIComponent(quoteId)}`, {
    intentos_rechazados: Number(actual.intentos_rechazados ?? 0) + 1,
    mp_payment_id: mpPaymentId,
    updated_at: ahora(),
  });
  return filas !== null;
}

// Solo los que siguen en `nuevo`: si un humano ya los movio a entregado o
// anulado desde el backoffice, esta escritura no lo pisa.
export async function marcarPedidosPagados(env: PagoEnv, quoteId: string): Promise<boolean> {
  const filas = await pedir(
    env,
    'PATCH',
    `/pedidos?quote_id=eq.${encodeURIComponent(quoteId)}&estado_negocio=eq.nuevo`,
    { estado_negocio: 'pagado', pagado_at: ahora() },
  );
  return filas !== null;
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run apps/mailer/tests/pago-datos.test.ts`
Expected: PASS, 10 casos.

- [ ] **Step 5: Commit**

```bash
git add apps/mailer/src/pago/datos.ts apps/mailer/tests/pago-datos.test.ts
git commit -m "feat(pagos): acceso a Supabase con transicion atomica a aprobado"
```

---

### Task 5: Reconstrucción del quote y payload de emisión

`emitir-ordenes-compra` lee cinco campos de la cotización. Esta tarea los reconstruye desde la fila guardada, campo por campo, y arma el `execution_context` sintético.

**Files:**
- Create: `apps/mailer/src/pago/quote.ts`
- Test: `apps/mailer/tests/pago-quote.test.ts`

**Interfaces:**
- Consumes: `CotizacionRow` de `./datos.js` (Task 4).
- Produces:
  - `reconstruirQuote(row: CotizacionRow): Record<string, unknown>`
  - `armarPayloadEmision(quote, datos: Record<string, unknown>, telefono: string | null): unknown`
  - `vigenciaUtil(validaHasta: string, ahoraMs: number): boolean`

- [ ] **Step 1: Escribir el test que falla**

Crear `apps/mailer/tests/pago-quote.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { armarPayloadEmision, reconstruirQuote, vigenciaUtil } from '../src/pago/quote.js';
import { MARGEN_VIGENCIA_MS } from '../src/pago/mercadopago.js';

const ROW: any = {
  quote_id: 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4',
  version: '1',
  numero: 1600001,
  telefono: '56941757584',
  total_clp: 1190,
  valida_hasta: '2026-09-10T18:00:00.000Z',
  lineas: [{ proveedor: 'intcomex', cantidad: 1, precio_unitario_usd: 10, subtotal_neto_clp: 1000 }],
  proveedores_incompletos: ['ingram'],
};

describe('reconstruirQuote', () => {
  it('produce los cinco campos que emitir-ordenes-compra lee', () => {
    const q: any = reconstruirQuote(ROW);
    expect(q.quote_id).toBe(ROW.quote_id);
    expect(q.version).toBe('1');
    expect(q.lineas).toEqual(ROW.lineas);
    expect(q.valid_until).toBe(ROW.valida_hasta);
    expect(q.proveedores_incompletos).toEqual(['ingram']);
  });

  it('una fila vieja sin proveedores_incompletos degrada a lista vacia, no a undefined', () => {
    const q: any = reconstruirQuote({ ...ROW, proveedores_incompletos: null });
    expect(q.proveedores_incompletos).toEqual([]);
  });
});

describe('armarPayloadEmision', () => {
  it('manda quote_confirmed true y el telefono en el contexto', () => {
    const p: any = armarPayloadEmision(reconstruirQuote(ROW), {
      quote_customer_name: 'Acme SpA', billing_rut: '76.123.456-7',
    }, '56941757584');
    expect(p.execution_context.vars.quote_confirmed).toBe(true);
    expect(p.execution_context.vars.quote_customer_name).toBe('Acme SpA');
    expect(p.execution_context.vars.billing_rut).toBe('76.123.456-7');
    expect(p.execution_context.vars.quote_result.quote_id).toBe(ROW.quote_id);
    expect(p.execution_context.context.phone_number).toBe('56941757584');
  });
});

describe('vigenciaUtil', () => {
  const venceEn = Date.parse(ROW.valida_hasta);

  it('con mas de 15 minutos por delante, hay ventana para pagar', () => {
    expect(vigenciaUtil(ROW.valida_hasta, venceEn - MARGEN_VIGENCIA_MS - 1000)).toBe(true);
  });

  it('justo en el umbral y por debajo, no se crea link', () => {
    expect(vigenciaUtil(ROW.valida_hasta, venceEn - MARGEN_VIGENCIA_MS)).toBe(false);
    expect(vigenciaUtil(ROW.valida_hasta, venceEn)).toBe(false);
    expect(vigenciaUtil(ROW.valida_hasta, venceEn + 1000)).toBe(false);
  });

  it('una fecha ilegible se trata como sin vigencia', () => {
    expect(vigenciaUtil('no-es-fecha', Date.now())).toBe(false);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run apps/mailer/tests/pago-quote.test.ts`
Expected: FAIL — no existe `../src/pago/quote.js`.

- [ ] **Step 3: Implementar**

Crear `apps/mailer/src/pago/quote.ts`:

```ts
import type { CotizacionRow } from './datos.js';
import { MARGEN_VIGENCIA_MS } from './mercadopago.js';

/**
 * emitir-ordenes-compra lee exactamente cinco campos de la cotizacion:
 * quote_id, version, lineas, valid_until y proveedores_incompletos. Esta
 * funcion los reconstruye desde la fila guardada. Si alguna vez la function
 * empieza a leer un sexto campo, este es el lugar que hay que acompañar.
 */
export function reconstruirQuote(row: CotizacionRow): Record<string, unknown> {
  return {
    quote_id: row.quote_id,
    version: String(row.version ?? '1'),
    lineas: Array.isArray(row.lineas) ? row.lineas : [],
    valid_until: row.valida_hasta,
    // Las filas anteriores a la columna nueva traen null: lista vacia, que es
    // como la function ya se defiende (`Array.isArray(...) ? ... : []`).
    proveedores_incompletos: Array.isArray(row.proveedores_incompletos) ? row.proveedores_incompletos : [],
  };
}

/**
 * El mismo execution_context sintetico que arma apps/tienda/src/lib/pedido.ts.
 * `datos` viene de la fila `pagos`: quote_customer_name y los billing_*.
 */
export function armarPayloadEmision(
  quote: Record<string, unknown>,
  datos: Record<string, unknown>,
  telefono: string | null,
): unknown {
  return {
    execution_context: {
      vars: { quote_result: quote, quote_confirmed: true, ...datos },
      context: { phone_number: telefono ?? '' },
    },
  };
}

/**
 * ¿Le queda a la cotizacion ventana suficiente para pagar dentro de su
 * vigencia? Por debajo del margen, un link nace condenado: se aprobaria el
 * pago y emitir-ordenes-compra lo rechazaria con 409.
 */
export function vigenciaUtil(validaHasta: string, ahoraMs: number): boolean {
  const vence = Date.parse(String(validaHasta));
  if (!Number.isFinite(vence)) return false;
  return vence - ahoraMs > MARGEN_VIGENCIA_MS;
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run apps/mailer/tests/pago-quote.test.ts`
Expected: PASS, 6 casos.

- [ ] **Step 5: Commit**

```bash
git add apps/mailer/src/pago/quote.ts apps/mailer/tests/pago-quote.test.ts
git commit -m "feat(pagos): reconstruccion del quote y payload de emision"
```

---

### Task 6: Puente a Kapso y textos al cliente

Invocar `emitir-ordenes-compra` por la Platform API y mandar los mensajes de WhatsApp por el proxy Meta de Kapso, el mismo que ya usa `generar-cotizacion-v2` para el PDF.

`invocarFunction` es una copia adaptada de `apps/tienda/src/lib/kapso.ts`. Se duplica a propósito: extraerla a un paquete obligaría a tocar `build:packages`, los `tsconfig` y la tienda en una tarea que no va de eso. Cuando la tienda cobre (fase siguiente), las dos copias colapsan en una.

**Files:**
- Create: `apps/mailer/src/pago/kapso.ts`, `apps/mailer/src/pago/mensajes.ts`
- Test: `apps/mailer/tests/pago-kapso.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `invocarFunction(nombre, payload, key): Promise<{ status: number; data: Record<string, unknown> } | null>`
  - `_limpiarCacheKapso(): void`
  - `enviarTexto(p: { telefono, phoneNumberId, key, texto }): Promise<boolean>`
  - `enviarBotonPago(p: { telefono, phoneNumberId, key, texto, url, boton }): Promise<boolean>`
  - `MENSAJES` con las claves `linkCreado(montoFmt)`, `sinLink`, `sinVigencia`, `rechazado`, `emitido`, `aprobadoSinEmitir`
  - `formatearClp(n: number): string`

- [ ] **Step 1: Escribir el test que falla**

Crear `apps/mailer/tests/pago-kapso.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { _limpiarCacheKapso, enviarBotonPago, enviarTexto, invocarFunction } from '../src/pago/kapso.js';
import { MENSAJES, formatearClp } from '../src/pago/mensajes.js';

const FUNCTIONS = { data: [{ id: 'id-emitir', name: 'emitir-ordenes-compra' }] };

beforeEach(() => _limpiarCacheKapso());
afterEach(() => vi.unstubAllGlobals());

describe('invocarFunction', () => {
  it('resuelve el id por nombre, cachea el listado y postea el payload', async () => {
    const spy = vi.fn(async (url: any, init?: RequestInit) => {
      if (String(url).endsWith('/functions')) return new Response(JSON.stringify(FUNCTIONS), { status: 200 });
      expect(String(url)).toContain('/functions/id-emitir/invoke');
      expect((init?.headers as Record<string, string>)['X-API-Key']).toBe('kapso-key');
      return new Response(JSON.stringify({ ok: true }), { status: 200 });
    });
    vi.stubGlobal('fetch', spy);
    const r1 = await invocarFunction('emitir-ordenes-compra', {}, 'kapso-key');
    const r2 = await invocarFunction('emitir-ordenes-compra', {}, 'kapso-key');
    expect(r1?.status).toBe(200);
    expect(r2?.status).toBe(200);
    expect(spy).toHaveBeenCalledTimes(3); // 1 listado + 2 invokes
  });

  it('sin key, function inexistente o red caida devuelven null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(FUNCTIONS), { status: 200 })));
    expect(await invocarFunction('emitir-ordenes-compra', {}, '')).toBeNull();
    expect(await invocarFunction('no-existe', {}, 'k')).toBeNull();
    _limpiarCacheKapso();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('ECONNRESET'); }));
    expect(await invocarFunction('emitir-ordenes-compra', {}, 'k')).toBeNull();
  });

  it('un status no-2xx se devuelve para que el caller decida', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: any) =>
      String(url).endsWith('/functions')
        ? new Response(JSON.stringify(FUNCTIONS), { status: 200 })
        : new Response(JSON.stringify({ ok: false, error: 'La cotización expiró' }), { status: 409 })));
    const r = await invocarFunction('emitir-ordenes-compra', {}, 'k');
    expect(r?.status).toBe(409);
  });
});

describe('mensajes de WhatsApp', () => {
  it('enviarTexto postea al proxy Meta con el phone_number_id', async () => {
    const spy = vi.fn(async (url: any, init?: RequestInit) => {
      expect(String(url)).toBe('https://api.kapso.ai/meta/whatsapp/v24.0/PNID/messages');
      const body = JSON.parse(String(init?.body));
      expect(body.messaging_product).toBe('whatsapp');
      expect(body.to).toBe('56941757584');
      expect(body.text.body).toBe('hola');
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', spy);
    expect(await enviarTexto({ telefono: '56941757584', phoneNumberId: 'PNID', key: 'k', texto: 'hola' })).toBe(true);
  });

  it('enviarBotonPago manda un interactivo cta_url con la URL del pago', async () => {
    const spy = vi.fn(async (_url: any, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body));
      expect(body.type).toBe('interactive');
      expect(body.interactive.type).toBe('cta_url');
      expect(body.interactive.action.parameters.url).toBe('https://mp/pagar');
      expect(body.interactive.action.parameters.display_text).toBe('Pagar');
      return new Response('{}', { status: 200 });
    });
    vi.stubGlobal('fetch', spy);
    expect(await enviarBotonPago({
      telefono: '569', phoneNumberId: 'PNID', key: 'k',
      texto: 'Listo', url: 'https://mp/pagar', boton: 'Pagar',
    })).toBe(true);
  });

  it('sin telefono o sin phone_number_id no se llama a la red', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    expect(await enviarTexto({ telefono: '', phoneNumberId: 'PNID', key: 'k', texto: 'x' })).toBe(false);
    expect(await enviarTexto({ telefono: '569', phoneNumberId: '', key: 'k', texto: 'x' })).toBe(false);
    expect(spy).not.toHaveBeenCalled();
  });

  it('un status de error devuelve false sin reventar', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
    expect(await enviarTexto({ telefono: '569', phoneNumberId: 'P', key: 'k', texto: 'x' })).toBe(false);
  });
});

describe('textos', () => {
  it('formatea pesos chilenos sin decimales', () => {
    expect(formatearClp(219725)).toBe('$219.725');
  });

  it('el texto del link lleva el monto y ninguno promete lo que no ocurrio', () => {
    expect(MENSAJES.linkCreado('$219.725')).toContain('$219.725');
    expect(MENSAJES.emitido).toContain('cursado');
    expect(MENSAJES.aprobadoSinEmitir).not.toContain('cursado');
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run apps/mailer/tests/pago-kapso.test.ts`
Expected: FAIL — no existen los módulos.

- [ ] **Step 3: Implementar los textos**

Crear `apps/mailer/src/pago/mensajes.ts`:

```ts
export function formatearClp(n: number): string {
  return `$${Math.round(n).toLocaleString('es-CL')}`;
}

/**
 * Los seis textos al cliente. Viven juntos y aparte de los handlers porque la
 * regla que los gobierna es una sola: ninguno afirma algo que el paso que lo
 * dispara no haya verificado. `aprobadoSinEmitir` en particular NO dice que el
 * pedido quedo cursado -- justamente no lo sabemos.
 */
export const MENSAJES = {
  linkCreado: (montoFmt: string) =>
    `Listo 🙌 El total es ${montoFmt}. Paga con el botón de acá abajo y apenas se acredite te confirmo el pedido.`,
  sinLink:
    'Tuvimos un problema generando el link de pago. No lo intentes de nuevo: te contactamos por acá para resolverlo.',
  sinVigencia:
    'Los precios de tu cotización hay que refrescarlos antes de cobrar. Dame un momento y te confirmo el total.',
  rechazado:
    'El pago fue rechazado 😕 Puedes reintentar con el mismo link, o escribirme si prefieres otra forma de pago.',
  emitido:
    'Pago recibido ✅ Tu pedido quedó cursado. Te avisamos por acá cuando esté listo para entrega.',
  aprobadoSinEmitir:
    'Recibimos tu pago ✅ Estamos terminando de confirmar el pedido y te escribimos por acá en un rato.',
};
```

- [ ] **Step 4: Implementar el puente a Kapso**

Crear `apps/mailer/src/pago/kapso.ts`:

```ts
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
```

- [ ] **Step 5: Correr el test y verificar que pasa**

Run: `npx vitest run apps/mailer/tests/pago-kapso.test.ts`
Expected: PASS, 8 casos.

- [ ] **Step 6: Commit**

```bash
git add apps/mailer/src/pago/kapso.ts apps/mailer/src/pago/mensajes.ts apps/mailer/tests/pago-kapso.test.ts
git commit -m "feat(pagos): puente a Kapso (invoke y mensajes) y textos al cliente"
```

---

### Task 7: Handler de `POST /api/pago/crear`

Lo que llama el nodo `webhook` del workflow. Cablea las tareas 3 a 6.

**Files:**
- Create: `apps/mailer/src/pago/crear.ts`
- Test: `apps/mailer/tests/pago-crear.test.ts`

**Interfaces:**
- Consumes: `leerCotizacion`, `leerPago`, `crearPago`, `PagoEnv` (Task 4); `construirPreferencia`, `crearPreferencia` (Task 3); `vigenciaUtil` (Task 5); `enviarBotonPago`, `enviarTexto` (Task 6); `MENSAJES`, `formatearClp` (Task 6).
- Produces: `createCrearHandler(): (req, res, env?) => Promise<void>`, con `CrearEnv = PagoEnv & { MAILER_API_KEY?; MP_ACCESS_TOKEN?; PAGO_BASE_URL?; KAPSO_API_KEY? }`.

- [ ] **Step 1: Escribir el test que falla**

Crear `apps/mailer/tests/pago-crear.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createCrearHandler } from '../src/pago/crear.js';
import { _limpiarCacheKapso } from '../src/pago/kapso.js';

const ENV = {
  SUPABASE_URL: 'https://supabase.test',
  SUPABASE_SERVICE_KEY: 'clave',
  MAILER_API_KEY: 'clave-kapso',
  MP_ACCESS_TOKEN: 'token-mp',
  PAGO_BASE_URL: 'https://rr-mailing.vercel.app',
  KAPSO_API_KEY: 'kapso-key',
};

const QUOTE = 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4';

const COTIZACION = {
  quote_id: QUOTE, version: '1', numero: 1600001, telefono: '56941757584',
  total_clp: 219725, valida_hasta: new Date(Date.now() + 3 * 3600_000).toISOString(),
  lineas: [{ proveedor: 'intcomex', cantidad: 1, precio_unitario_usd: 10, subtotal_neto_clp: 184643 }],
  proveedores_incompletos: [],
};

const CUERPO = {
  quote_id: QUOTE, quote_version: '1',
  phone_number: '56941757584', phone_number_id: 'PNID',
  customer_name: 'Acme SpA', billing_email: 'contacto@acme.cl',
};

function makeRes() {
  const res = {
    statusCode: 0, jsonBody: undefined as any,
    status(c: number) { res.statusCode = c; return res; },
    json(p: unknown) { res.jsonBody = p; return res; },
    setHeader() { return res; }, send() { return res; }, end() { return res; },
  };
  return res as unknown as VercelResponse & typeof res;
}

function makeReq(body: unknown, key = 'clave-kapso'): VercelRequest {
  return { method: 'POST', body, headers: { 'x-api-key': key }, query: {} } as unknown as VercelRequest;
}

/** Enruta fetch por URL: supabase, mercadopago y kapso, cada uno con su guion. */
function routeFetch(h: {
  cotizacion?: unknown[]; pago?: unknown[]; crearPago?: number;
  preferencia?: { status: number; body: unknown };
  mensajes?: string[];
}) {
  const spy = vi.fn(async (url: any, init?: RequestInit) => {
    const href = String(url);
    if (href.includes('supabase.test')) {
      if (href.includes('/cotizaciones')) return new Response(JSON.stringify(h.cotizacion ?? [COTIZACION]), { status: 200 });
      if (href.includes('/pagos') && (init?.method ?? 'GET') === 'GET') {
        return new Response(JSON.stringify(h.pago ?? []), { status: 200 });
      }
      return new Response('[]', { status: h.crearPago ?? 201 });
    }
    if (href.includes('api.mercadopago.com')) {
      const p = h.preferencia ?? { status: 201, body: { id: 'pref-1', init_point: 'https://mp/pagar' } };
      return new Response(JSON.stringify(p.body), { status: p.status });
    }
    if (href.includes('/meta/whatsapp/')) {
      h.mensajes?.push(String(init?.body));
      return new Response('{}', { status: 200 });
    }
    throw new Error(`llamada inesperada: ${href}`);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => _limpiarCacheKapso());
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/pago/crear', () => {
  it('crea la preferencia, guarda la fila y manda el boton de pago', async () => {
    const mensajes: string[] = [];
    routeFetch({ mensajes });
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.ok).toBe(true);
    expect(res.jsonBody.init_point).toBe('https://mp/pagar');
    const enviado = JSON.parse(mensajes[0]);
    expect(enviado.interactive.action.parameters.url).toBe('https://mp/pagar');
    expect(enviado.interactive.body.text).toContain('$219.725');
  });

  it('sin la api key correcta responde 401 sin tocar nada', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO, 'otra'), res, ENV);
    expect(res.statusCode).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('es idempotente: una segunda llamada devuelve el link que ya existe', async () => {
    const spy = routeFetch({
      pago: [{ quote_id: QUOTE, init_point: 'https://mp/ya-existe', estado: 'pendiente' }],
    });
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(res.jsonBody.init_point).toBe('https://mp/ya-existe');
    expect(spy.mock.calls.every(([u]) => !String(u).includes('mercadopago'))).toBe(true);
  });

  it('cotizacion con menos de 15 minutos de vigencia: 409 y aviso, sin preferencia', async () => {
    const mensajes: string[] = [];
    const spy = routeFetch({
      cotizacion: [{ ...COTIZACION, valida_hasta: new Date(Date.now() + 5 * 60_000).toISOString() }],
      mensajes,
    });
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO), res, ENV);
    expect(res.statusCode).toBe(409);
    expect(spy.mock.calls.every(([u]) => !String(u).includes('mercadopago'))).toBe(true);
    expect(JSON.parse(mensajes[0]).text.body).toContain('refrescar');
  });

  it('Mercado Pago caido: 502, aviso honesto y nada persistido', async () => {
    const mensajes: string[] = [];
    const spy = routeFetch({ preferencia: { status: 500, body: {} }, mensajes });
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO), res, ENV);
    expect(res.statusCode).toBe(502);
    expect(JSON.parse(mensajes[0]).text.body).toContain('problema');
    const escrituras = spy.mock.calls.filter(([u, i]) =>
      String(u).includes('/pagos') && (i as RequestInit)?.method === 'POST');
    expect(escrituras).toHaveLength(0);
  });

  it('cotizacion inexistente responde 404', async () => {
    routeFetch({ cotizacion: [] });
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO), res, ENV);
    expect(res.statusCode).toBe(404);
  });

  it('cuerpo sin quote_id responde 400', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = makeRes();
    await createCrearHandler()(makeReq({ ...CUERPO, quote_id: '' }), res, ENV);
    expect(res.statusCode).toBe(400);
    expect(spy).not.toHaveBeenCalled();
  });

  it('falta configuracion: 503 nombrando las variables, nunca sus valores', async () => {
    const res = makeRes();
    await createCrearHandler()(makeReq(CUERPO), res, { ...ENV, MP_ACCESS_TOKEN: undefined } as any);
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody.faltan).toContain('MP_ACCESS_TOKEN');
    expect(JSON.stringify(res.jsonBody)).not.toContain('token-mp');
  });

  it('metodo distinto de POST responde 405', async () => {
    const res = makeRes();
    await createCrearHandler()({ ...makeReq(CUERPO), method: 'GET' } as any, res, ENV);
    expect(res.statusCode).toBe(405);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run apps/mailer/tests/pago-crear.test.ts`
Expected: FAIL — no existe `../src/pago/crear.js`.

- [ ] **Step 3: Implementar**

Crear `apps/mailer/src/pago/crear.ts`:

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '@rr/http/auth';
import { firstString } from '@rr/http/http';
import { crearPago, leerCotizacion, leerPago, type PagoEnv, type PagoRow } from './datos.js';
import { enviarBotonPago, enviarTexto } from './kapso.js';
import { MENSAJES, formatearClp } from './mensajes.js';
import { construirPreferencia, crearPreferencia } from './mercadopago.js';
import { vigenciaUtil } from './quote.js';

const REQUERIDAS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'MAILER_API_KEY', 'MP_ACCESS_TOKEN', 'PAGO_BASE_URL', 'KAPSO_API_KEY'] as const;

export interface CrearEnv extends PagoEnv {
  MAILER_API_KEY?: string;
  MP_ACCESS_TOKEN?: string;
  PAGO_BASE_URL?: string;
  KAPSO_API_KEY?: string;
}

const BILLING = [
  'billing_rut', 'billing_razon_social', 'billing_giro', 'billing_direccion',
  'billing_comuna', 'billing_ciudad', 'billing_email',
] as const;

interface Entrada {
  quoteId: string;
  quoteVersion: string;
  telefono: string;
  phoneNumberId: string;
  datos: Record<string, unknown>;
  email: string;
  nombre: string;
}

function leerEntrada(body: unknown): Entrada | null {
  if (typeof body !== 'object' || body === null) return null;
  const b = body as Record<string, unknown>;
  const quoteId = String(b.quote_id ?? '').trim();
  if (!quoteId) return null;

  const datos: Record<string, unknown> = {};
  const nombre = String(b.customer_name ?? '').trim();
  if (nombre) datos.quote_customer_name = nombre;
  for (const campo of BILLING) {
    const valor = String(b[campo] ?? '').trim();
    if (valor) datos[campo] = valor;
  }

  return {
    quoteId,
    quoteVersion: String(b.quote_version ?? '1'),
    telefono: String(b.phone_number ?? '').replace(/\D/g, ''),
    phoneNumberId: String(b.phone_number_id ?? '').trim(),
    datos,
    email: String(b.billing_email ?? '').trim() || 'sin-email@drcomputacion.cl',
    nombre: nombre || 'Cliente',
  };
}

export function createCrearHandler() {
  return async function handler(
    req: VercelRequest,
    res: VercelResponse,
    env: CrearEnv = process.env as CrearEnv,
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false, error: 'metodo_no_permitido' });
      return;
    }
    if (!isAuthorized(firstString(req.headers['x-api-key']), env.MAILER_API_KEY)) {
      res.status(401).json({ ok: false, error: 'no_autorizado' });
      return;
    }

    const entrada = leerEntrada(req.body);
    if (!entrada) {
      res.status(400).json({ ok: false, error: 'cuerpo_invalido' });
      return;
    }

    // Se nombran las que faltan; nunca sus valores.
    const faltan = REQUERIDAS.filter((n) => !env[n]);
    if (faltan.length > 0) {
      res.status(503).json({ ok: false, error: 'falta_configuracion', faltan });
      return;
    }

    const avisar = (texto: string) => enviarTexto({
      telefono: entrada.telefono,
      phoneNumberId: entrada.phoneNumberId,
      key: env.KAPSO_API_KEY as string,
      texto,
    });

    // Idempotencia: una segunda llamada por la misma cotizacion devuelve el
    // link que ya existe en vez de crear otra preferencia. La llave primaria
    // de `pagos` es el quote_id justamente para esto.
    const yaExiste = await leerPago(env, entrada.quoteId);
    if (yaExiste === undefined) {
      res.status(503).json({ ok: false, error: 'upstream' });
      return;
    }
    if (yaExiste) {
      res.status(200).json({ ok: true, estado: yaExiste.estado, init_point: yaExiste.init_point });
      return;
    }

    const cotizacion = await leerCotizacion(env, entrada.quoteId);
    if (cotizacion === undefined) {
      res.status(503).json({ ok: false, error: 'upstream' });
      return;
    }
    if (cotizacion === null) {
      res.status(404).json({ ok: false, error: 'cotizacion_no_encontrada' });
      return;
    }

    // Por debajo del margen el link nace condenado: se aprobaria el pago y
    // emitir-ordenes-compra lo rechazaria por vigencia. Mejor no mandarlo.
    if (!vigenciaUtil(cotizacion.valida_hasta, Date.now())) {
      await avisar(MENSAJES.sinVigencia);
      res.status(409).json({ ok: false, error: 'sin_vigencia' });
      return;
    }

    const montoClp = Number(cotizacion.total_clp);
    if (!Number.isFinite(montoClp) || montoClp <= 0) {
      await avisar(MENSAJES.sinLink);
      res.status(422).json({ ok: false, error: 'monto_invalido' });
      return;
    }

    const preferencia = await crearPreferencia(
      construirPreferencia({
        quoteId: entrada.quoteId,
        numero: cotizacion.numero ?? null,
        montoClp,
        nombre: entrada.nombre,
        email: entrada.email,
        baseUrl: env.PAGO_BASE_URL as string,
        validUntil: cotizacion.valida_hasta,
      }),
      env.MP_ACCESS_TOKEN as string,
      entrada.quoteId,
    );
    if (!preferencia) {
      await avisar(MENSAJES.sinLink);
      res.status(502).json({ ok: false, error: 'mercadopago_no_responde' });
      return;
    }

    const fila: PagoRow = {
      quote_id: entrada.quoteId,
      quote_version: String(cotizacion.version ?? entrada.quoteVersion),
      numero: cotizacion.numero ?? null,
      telefono: entrada.telefono || cotizacion.telefono || null,
      phone_number_id: entrada.phoneNumberId || null,
      preference_id: preferencia.id,
      init_point: preferencia.init_point,
      monto_clp: montoClp,
      expira_at: cotizacion.valida_hasta,
      estado: 'pendiente',
      datos: entrada.datos,
    };
    if (!(await crearPago(env, fila))) {
      // La preferencia existe en Mercado Pago pero no tenemos donde anotarla:
      // sin fila, el webhook no sabria que emitir. No se manda el link.
      await avisar(MENSAJES.sinLink);
      res.status(503).json({ ok: false, error: 'no_se_pudo_registrar' });
      return;
    }

    await enviarBotonPago({
      telefono: fila.telefono ?? '',
      phoneNumberId: entrada.phoneNumberId,
      key: env.KAPSO_API_KEY as string,
      texto: MENSAJES.linkCreado(formatearClp(montoClp)),
      url: preferencia.init_point,
      boton: 'Pagar',
    });

    res.status(200).json({ ok: true, estado: 'pendiente', init_point: preferencia.init_point });
  };
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run apps/mailer/tests/pago-crear.test.ts`
Expected: PASS, 9 casos.

- [ ] **Step 5: Commit**

```bash
git add apps/mailer/src/pago/crear.ts apps/mailer/tests/pago-crear.test.ts
git commit -m "feat(pagos): handler que crea la preferencia y manda el link"
```

---

### Task 8: Handler de `POST /api/pago/webhook`

La máquina de estados. Es el único endpoint público que mueve dinero, así que el orden de los pasos importa: firma, re-consulta, comparación, transición atómica, emisión.

**Files:**
- Create: `apps/mailer/src/pago/webhook.ts`
- Test: `apps/mailer/tests/pago-webhook.test.ts`

**Interfaces:**
- Consumes: `firmaValida`, `construirManifiesto` (Task 2); `consultarPago` (Task 3); `leerPago`, `leerCotizacion`, `reclamarAprobado`, `marcarEstado`, `sumarRechazo`, `marcarPedidosPagados` (Task 4); `reconstruirQuote`, `armarPayloadEmision` (Task 5); `invocarFunction`, `enviarTexto`, `MENSAJES` (Task 6).
- Produces: `createWebhookHandler(alertar?): (req, res, env?) => Promise<void>`, donde `alertar: (asunto: string, detalle: string) => Promise<void>` se inyecta solo para pruebas.

- [ ] **Step 1: Escribir el test que falla**

Crear `apps/mailer/tests/pago-webhook.test.ts`:

```ts
import { createHmac } from 'node:crypto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { construirManifiesto } from '../src/pago/firma.js';
import { _limpiarCacheKapso } from '../src/pago/kapso.js';
import { createWebhookHandler } from '../src/pago/webhook.js';

const SECRET = 'secreto';
const QUOTE = 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4';
const PAYMENT_ID = '123456789';
const REQUEST_ID = 'bb56a2f1-6aae-46ac-982e-9dcd3581d08e';

const ENV = {
  SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_KEY: 'clave',
  MP_ACCESS_TOKEN: 'token-mp', MP_WEBHOOK_SECRET: SECRET, KAPSO_API_KEY: 'kapso-key',
};

const PAGO = {
  quote_id: QUOTE, quote_version: '1', telefono: '56941757584', phone_number_id: 'PNID',
  monto_clp: 219725, estado: 'pendiente', intentos_rechazados: 0,
  datos: { quote_customer_name: 'Acme SpA', billing_rut: '76.123.456-7' },
};

const COTIZACION = {
  quote_id: QUOTE, version: '1', total_clp: 219725,
  valida_hasta: new Date(Date.now() + 3600_000).toISOString(),
  lineas: [{ proveedor: 'intcomex', cantidad: 1, precio_unitario_usd: 10, subtotal_neto_clp: 184643 }],
  proveedores_incompletos: [],
};

function firmarHeader(dataId = PAYMENT_ID, secret = SECRET) {
  const ts = '1742505638683';
  const v1 = createHmac('sha256', secret).update(construirManifiesto(dataId, REQUEST_ID, ts)).digest('hex');
  return `ts=${ts},v1=${v1}`;
}

function makeRes() {
  const res = {
    statusCode: 0, jsonBody: undefined as any,
    status(c: number) { res.statusCode = c; return res; },
    json(p: unknown) { res.jsonBody = p; return res; },
    setHeader() { return res; }, send() { return res; }, end() { return res; },
  };
  return res as unknown as VercelResponse & typeof res;
}

function makeReq(over: Partial<{ header: string; dataId: string; body: unknown; query: any }> = {}): VercelRequest {
  return {
    method: 'POST',
    headers: { 'x-signature': over.header ?? firmarHeader(), 'x-request-id': REQUEST_ID },
    query: over.query ?? { type: 'payment', 'data.id': over.dataId ?? PAYMENT_ID },
    body: over.body ?? { type: 'payment', action: 'payment.updated', data: { id: over.dataId ?? PAYMENT_ID } },
  } as unknown as VercelRequest;
}

/** Guion completo: supabase + mercadopago + kapso. */
function routeFetch(h: {
  pago?: unknown[]; cotizacion?: unknown[];
  mpPago?: unknown; mpStatus?: number;
  reclamo?: unknown[];
  emitir?: { status: number; body: unknown };
  escrituras?: Array<{ url: string; body: any }>;
  mensajes?: string[];
} = {}) {
  const spy = vi.fn(async (url: any, init?: RequestInit) => {
    const href = String(url);
    const metodo = init?.method ?? 'GET';

    if (href.includes('supabase.test')) {
      if (metodo === 'PATCH' || metodo === 'POST') {
        h.escrituras?.push({ url: href, body: JSON.parse(String(init?.body ?? '{}')) });
        if (href.includes('estado=eq.pendiente')) {
          return new Response(JSON.stringify(h.reclamo ?? [{ quote_id: QUOTE }]), { status: 200 });
        }
        return new Response('[]', { status: 200 });
      }
      if (href.includes('/cotizaciones')) return new Response(JSON.stringify(h.cotizacion ?? [COTIZACION]), { status: 200 });
      return new Response(JSON.stringify(h.pago ?? [PAGO]), { status: 200 });
    }

    if (href.includes('api.mercadopago.com')) {
      return new Response(JSON.stringify(h.mpPago ?? {
        id: PAYMENT_ID, status: 'approved', external_reference: QUOTE, transaction_amount: 219725,
      }), { status: h.mpStatus ?? 200 });
    }

    if (href.endsWith('/functions')) {
      return new Response(JSON.stringify({ data: [{ id: 'id-emitir', name: 'emitir-ordenes-compra' }] }), { status: 200 });
    }
    if (href.includes('/invoke')) {
      const e = h.emitir ?? { status: 200, body: { ok: true, vars: { purchase_orders_ok: true } } };
      return new Response(JSON.stringify(e.body), { status: e.status });
    }
    if (href.includes('/meta/whatsapp/')) {
      h.mensajes?.push(JSON.parse(String(init?.body)).text?.body ?? '');
      return new Response('{}', { status: 200 });
    }
    throw new Error(`llamada inesperada: ${href}`);
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

beforeEach(() => _limpiarCacheKapso());
afterEach(() => vi.unstubAllGlobals());

describe('POST /api/pago/webhook', () => {
  it('pago aprobado: emite, marca pedidos pagados y avisa al cliente', async () => {
    const escrituras: any[] = [];
    const mensajes: string[] = [];
    const spy = routeFetch({ escrituras, mensajes });
    const res = makeRes();
    await createWebhookHandler()(makeReq(), res, ENV);

    expect(res.statusCode).toBe(200);
    expect(spy.mock.calls.some(([u]) => String(u).includes('/invoke'))).toBe(true);
    expect(escrituras.some((e) => e.body.estado === 'emitido')).toBe(true);
    expect(escrituras.some((e) => e.url.includes('/pedidos') && e.body.estado_negocio === 'pagado')).toBe(true);
    expect(mensajes[0]).toContain('cursado');
  });

  it('firma invalida: 401 y no se toca nada', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = makeRes();
    await createWebhookHandler()(makeReq({ header: firmarHeader(PAYMENT_ID, 'otro-secreto') }), res, ENV);
    expect(res.statusCode).toBe(401);
    expect(spy).not.toHaveBeenCalled();
  });

  it('la segunda entrega del mismo webhook no emite de nuevo', async () => {
    const spy = routeFetch({ reclamo: [] }); // el PATCH condicional devuelve cero filas
    const res = makeRes();
    await createWebhookHandler()(makeReq(), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(spy.mock.calls.some(([u]) => String(u).includes('/invoke'))).toBe(false);
  });

  it('monto distinto al cobrado: no emite, marca aprobado_sin_emitir y alerta', async () => {
    const escrituras: any[] = [];
    const alertas: string[] = [];
    const spy = routeFetch({
      escrituras,
      mpPago: { id: PAYMENT_ID, status: 'approved', external_reference: QUOTE, transaction_amount: 1000 },
    });
    const res = makeRes();
    await createWebhookHandler(async (asunto) => { alertas.push(asunto); })(makeReq(), res, ENV);
    expect(spy.mock.calls.some(([u]) => String(u).includes('/invoke'))).toBe(false);
    expect(escrituras.some((e) => e.body.estado === 'aprobado_sin_emitir')).toBe(true);
    expect(alertas).toHaveLength(1);
  });

  it('external_reference que no calza: no emite', async () => {
    const spy = routeFetch({
      mpPago: { id: PAYMENT_ID, status: 'approved', external_reference: 'otra-cotizacion', transaction_amount: 219725 },
    });
    const res = makeRes();
    await createWebhookHandler(async () => {})(makeReq(), res, ENV);
    expect(spy.mock.calls.some(([u]) => String(u).includes('/invoke'))).toBe(false);
  });

  it('emitir caido: aprobado_sin_emitir, alerta interna y mensaje que no promete', async () => {
    const escrituras: any[] = [];
    const mensajes: string[] = [];
    const alertas: string[] = [];
    routeFetch({ escrituras, mensajes, emitir: { status: 500, body: {} } });
    const res = makeRes();
    await createWebhookHandler(async (a) => { alertas.push(a); })(makeReq(), res, ENV);
    expect(escrituras.some((e) => e.body.estado === 'aprobado_sin_emitir')).toBe(true);
    expect(alertas).toHaveLength(1);
    expect(mensajes[0]).not.toContain('cursado');
  });

  it('emitir con ok false (cotizacion expirada) tampoco se da por bueno', async () => {
    const escrituras: any[] = [];
    routeFetch({ escrituras, emitir: { status: 409, body: { ok: false, error: 'La cotización expiró' } } });
    const res = makeRes();
    await createWebhookHandler(async () => {})(makeReq(), res, ENV);
    expect(escrituras.some((e) => e.body.estado === 'aprobado_sin_emitir')).toBe(true);
  });

  it('emision ok con alguna OC en failed igual cuenta como emitido', async () => {
    // El contrato honesto que ya rige hoy: la OC fallida se ve en el
    // backoffice, pero el pago SI se emitio y el cliente no queda en el limbo.
    const escrituras: any[] = [];
    routeFetch({
      escrituras,
      emitir: { status: 200, body: { ok: true, vars: { purchase_orders_ok: false } } },
    });
    const res = makeRes();
    await createWebhookHandler()(makeReq(), res, ENV);
    expect(escrituras.some((e) => e.body.estado === 'emitido')).toBe(true);
    expect(escrituras.some((e) => e.body.estado === 'aprobado_sin_emitir')).toBe(false);
  });

  it('pago rechazado: la fila sigue pendiente y solo sube el contador', async () => {
    const escrituras: any[] = [];
    const mensajes: string[] = [];
    routeFetch({
      escrituras, mensajes,
      mpPago: { id: PAYMENT_ID, status: 'rejected', external_reference: QUOTE, transaction_amount: 219725 },
    });
    const res = makeRes();
    await createWebhookHandler()(makeReq(), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(escrituras.every((e) => e.body.estado === undefined)).toBe(true);
    expect(escrituras.some((e) => e.body.intentos_rechazados === 1)).toBe(true);
    expect(mensajes[0]).toContain('rechazado');
  });

  it('pago aun pending: 200 y nada se escribe', async () => {
    const escrituras: any[] = [];
    routeFetch({
      escrituras,
      mpPago: { id: PAYMENT_ID, status: 'pending', external_reference: QUOTE, transaction_amount: 219725 },
    });
    const res = makeRes();
    await createWebhookHandler()(makeReq(), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(escrituras).toHaveLength(0);
  });

  it('notificacion que no es de pago se ignora con 200', async () => {
    const spy = vi.fn();
    vi.stubGlobal('fetch', spy);
    const res = makeRes();
    await createWebhookHandler()(makeReq({ query: { type: 'plan', 'data.id': PAYMENT_ID } }), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(spy).not.toHaveBeenCalled();
  });

  it('sin fila de pagos: 200 y no se emite (no es nuestro)', async () => {
    const spy = routeFetch({ pago: [] });
    const res = makeRes();
    await createWebhookHandler()(makeReq(), res, ENV);
    expect(res.statusCode).toBe(200);
    expect(spy.mock.calls.some(([u]) => String(u).includes('/invoke'))).toBe(false);
  });

  it('Mercado Pago no responde la consulta: 500 para que reintente', async () => {
    routeFetch({ mpStatus: 500 });
    const res = makeRes();
    await createWebhookHandler()(makeReq(), res, ENV);
    expect(res.statusCode).toBe(500);
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run apps/mailer/tests/pago-webhook.test.ts`
Expected: FAIL — no existe `../src/pago/webhook.js`.

- [ ] **Step 3: Implementar**

Crear `apps/mailer/src/pago/webhook.ts`:

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { firstString } from '@rr/http/http';
import {
  leerCotizacion, leerPago, marcarEstado, marcarPedidosPagados,
  reclamarAprobado, sumarRechazo, type PagoEnv,
} from './datos.js';
import { firmaValida } from './firma.js';
import { enviarTexto, invocarFunction } from './kapso.js';
import { MENSAJES } from './mensajes.js';
import { consultarPago } from './mercadopago.js';
import { armarPayloadEmision, reconstruirQuote } from './quote.js';

const REQUERIDAS = ['SUPABASE_URL', 'SUPABASE_SERVICE_KEY', 'MP_ACCESS_TOKEN', 'MP_WEBHOOK_SECRET', 'KAPSO_API_KEY'] as const;

export interface WebhookEnv extends PagoEnv {
  MP_ACCESS_TOKEN?: string;
  MP_WEBHOOK_SECRET?: string;
  KAPSO_API_KEY?: string;
}

export type Alertar = (asunto: string, detalle: string) => Promise<void>;

// Alerta interna por defecto: al log. La Task 9 la reemplaza por el correo.
const alertarPorDefecto: Alertar = async (asunto, detalle) => {
  console.error(`[pago] ALERTA ${asunto}`, { detalle });
};

/** Tipo y id de la notificacion, que Mercado Pago manda por query o por body. */
function leerNotificacion(req: VercelRequest): { tipo: string; dataId: string } {
  const q = req.query as Record<string, unknown>;
  const b = (typeof req.body === 'object' && req.body !== null ? req.body : {}) as Record<string, any>;
  return {
    tipo: String(firstString(q.type as any) ?? b.type ?? ''),
    dataId: String(firstString(q['data.id'] as any) ?? b?.data?.id ?? ''),
  };
}

export function createWebhookHandler(alertar: Alertar = alertarPorDefecto) {
  return async function handler(
    req: VercelRequest,
    res: VercelResponse,
    env: WebhookEnv = process.env as WebhookEnv,
  ): Promise<void> {
    if (req.method !== 'POST') {
      res.status(405).json({ ok: false });
      return;
    }
    if (REQUERIDAS.some((n) => !env[n])) {
      res.status(500).json({ ok: false, error: 'falta_configuracion' });
      return;
    }

    const { tipo, dataId } = leerNotificacion(req);
    // Solo pagos. Cualquier otro tipo se acusa recibo y se ignora, para que
    // Mercado Pago no lo reintente para siempre.
    if (tipo !== 'payment' || !dataId) {
      res.status(200).json({ ok: true, ignorado: true });
      return;
    }

    // La firma es lo unico que separa este endpoint publico de cualquiera que
    // sepa la URL. Va antes de tocar red o base de datos.
    const valida = firmaValida({
      dataId,
      requestId: firstString(req.headers['x-request-id']),
      header: firstString(req.headers['x-signature']),
      secret: env.MP_WEBHOOK_SECRET as string,
    });
    if (!valida) {
      console.error('[pago] webhook con firma invalida');
      res.status(401).json({ ok: false, error: 'firma_invalida' });
      return;
    }

    // El cuerpo del webhook NO decide nada: el monto y la referencia salen de
    // preguntarle a Mercado Pago.
    const pagoMP = await consultarPago(dataId, env.MP_ACCESS_TOKEN as string);
    if (!pagoMP) {
      res.status(500).json({ ok: false, error: 'mercadopago_no_responde' });
      return;
    }

    const quoteId = String(pagoMP.external_reference ?? '');
    if (!quoteId) {
      res.status(200).json({ ok: true, ignorado: true });
      return;
    }

    const fila = await leerPago(env, quoteId);
    if (fila === undefined) {
      res.status(500).json({ ok: false, error: 'upstream' });
      return;
    }
    if (fila === null) {
      // Un pago que no corresponde a ninguna fila nuestra. No es un error.
      res.status(200).json({ ok: true, ignorado: true });
      return;
    }

    const avisar = (texto: string) => enviarTexto({
      telefono: fila.telefono ?? '',
      phoneNumberId: fila.phone_number_id ?? '',
      key: env.KAPSO_API_KEY as string,
      texto,
    });

    if (pagoMP.status === 'rejected') {
      // No cambia el estado: la fila sigue `pendiente` para que el siguiente
      // intento con el mismo link pueda reclamarla.
      await sumarRechazo(env, quoteId, String(pagoMP.id));
      await avisar(MENSAJES.rechazado);
      res.status(200).json({ ok: true, estado: 'rechazado' });
      return;
    }

    if (pagoMP.status !== 'approved') {
      res.status(200).json({ ok: true, estado: pagoMP.status });
      return;
    }

    // El monto tiene que ser exactamente el que cobramos. Un pago aprobado por
    // otra cifra es plata recibida contra un pedido que no cuadra: se congela.
    if (Number(pagoMP.transaction_amount) !== Number(fila.monto_clp)) {
      await marcarEstado(env, quoteId, 'aprobado_sin_emitir', { mp_payment_id: String(pagoMP.id) });
      await alertar(
        `Pago aprobado con monto que no calza (cotizacion ${quoteId})`,
        `Cobrado: ${fila.monto_clp}. Pagado: ${pagoMP.transaction_amount}. Pago MP: ${pagoMP.id}. No se emitio ninguna orden.`,
      );
      await avisar(MENSAJES.aprobadoSinEmitir);
      res.status(200).json({ ok: true, estado: 'aprobado_sin_emitir' });
      return;
    }

    // La transicion que sostiene la idempotencia: si otra entrega del mismo
    // webhook ya la tomo, aca se devuelven cero filas y no se emite de nuevo.
    if (!(await reclamarAprobado(env, quoteId, String(pagoMP.id)))) {
      res.status(200).json({ ok: true, estado: 'ya_procesado' });
      return;
    }

    const cotizacion = await leerCotizacion(env, quoteId);
    if (!cotizacion) {
      await marcarEstado(env, quoteId, 'aprobado_sin_emitir');
      await alertar(
        `Pago aprobado sin cotizacion legible (cotizacion ${quoteId})`,
        `Pago MP: ${pagoMP.id}. No se emitio ninguna orden.`,
      );
      await avisar(MENSAJES.aprobadoSinEmitir);
      res.status(200).json({ ok: true, estado: 'aprobado_sin_emitir' });
      return;
    }

    const emision = await invocarFunction(
      'emitir-ordenes-compra',
      armarPayloadEmision(reconstruirQuote(cotizacion), fila.datos ?? {}, fila.telefono ?? null),
      env.KAPSO_API_KEY as string,
    );
    const emitido = emision !== null
      && emision.status === 200
      && (emision.data as { ok?: boolean }).ok === true;

    if (!emitido) {
      // Incluye el 409 por vigencia vencida: el pago esta hecho y los precios
      // ya no valen. Lo resuelve una persona, con la plata ya recibida.
      const motivo = emision === null ? 'sin respuesta' : `status ${emision.status}`;
      await marcarEstado(env, quoteId, 'aprobado_sin_emitir');
      await alertar(
        `Pago aprobado que NO se pudo emitir (cotizacion ${quoteId})`,
        `Pago MP: ${pagoMP.id}. Monto: ${fila.monto_clp}. Emision: ${motivo}.`,
      );
      await avisar(MENSAJES.aprobadoSinEmitir);
      res.status(200).json({ ok: true, estado: 'aprobado_sin_emitir' });
      return;
    }

    await marcarEstado(env, quoteId, 'emitido', { emitido_at: new Date().toISOString() });
    // El pedido nace `nuevo` en emitir-ordenes-compra; acá ya está pagado.
    await marcarPedidosPagados(env, quoteId);
    await avisar(MENSAJES.emitido);
    res.status(200).json({ ok: true, estado: 'emitido' });
  };
}
```

- [ ] **Step 4: Correr el test y verificar que pasa**

Run: `npx vitest run apps/mailer/tests/pago-webhook.test.ts`
Expected: PASS, 13 casos.

- [ ] **Step 5: Correr la batería completa**

Run: `npm test`
Expected: PASS, todo el repositorio.

- [ ] **Step 6: Commit**

```bash
git add apps/mailer/src/pago/webhook.ts apps/mailer/tests/pago-webhook.test.ts
git commit -m "feat(pagos): webhook de Mercado Pago con transicion atomica y emision"
```

---

### Task 9: Envoltorios HTTP, alerta por correo, retorno y documentación

Los tres archivos en `api/`, la alerta interna real (por el mailer que esta app ya tiene en proceso) y el README.

**Files:**
- Create: `apps/mailer/api/pago/crear.ts`, `apps/mailer/api/pago/webhook.ts`, `apps/mailer/api/pago/retorno.ts`, `apps/mailer/src/pago/alerta.ts`
- Modify: `apps/mailer/README.md`
- Test: `apps/mailer/tests/pago-alerta.test.ts`

**Interfaces:**
- Consumes: `createCrearHandler` (Task 7), `createWebhookHandler` y el tipo `Alertar` (Task 8).
- Produces: `crearAlertar(env): Alertar`.

- [ ] **Step 1: Escribir el test de la alerta**

Crear `apps/mailer/tests/pago-alerta.test.ts`:

```ts
import { describe, expect, it, vi } from 'vitest';
import { crearAlertar } from '../src/pago/alerta.js';

const ENV = {
  GMAIL_USER: 'interna@ejemplo.cl', GMAIL_APP_PASSWORD: 'x',
  MAILER_FROM: 'interna@ejemplo.cl', MAILER_ALLOWED_RECIPIENTS: 'interna@ejemplo.cl',
};

describe('crearAlertar', () => {
  it('manda el asunto y el detalle a la casilla interna', async () => {
    const send = vi.fn(async () => ({ id: 'msg-1' }));
    await crearAlertar(ENV, { send } as any)('Pago sin emitir', 'cotizacion X');
    expect(send).toHaveBeenCalledTimes(1);
    const mensaje = send.mock.calls[0][0] as any;
    expect(mensaje.to).toBe('interna@ejemplo.cl');
    expect(mensaje.subject).toContain('Pago sin emitir');
    expect(mensaje.text).toContain('cotizacion X');
  });

  it('un fallo del envio no propaga: la alerta es best-effort', async () => {
    const send = vi.fn(async () => { throw new Error('EAUTH'); });
    await expect(crearAlertar(ENV, { send } as any)('a', 'b')).resolves.toBeUndefined();
  });

  it('sin destinatario configurado no revienta', async () => {
    const send = vi.fn();
    await crearAlertar({ ...ENV, MAILER_ALLOWED_RECIPIENTS: '' }, { send } as any)('a', 'b');
    expect(send).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run apps/mailer/tests/pago-alerta.test.ts`
Expected: FAIL — no existe `../src/pago/alerta.js`.

- [ ] **Step 3: Implementar la alerta**

Crear `apps/mailer/src/pago/alerta.ts`:

```ts
import { createGmailTransport, createMailer, type Mailer } from '@rr/mailer';
import type { Alertar } from './webhook.js';

export interface AlertaEnv {
  GMAIL_USER?: string;
  GMAIL_APP_PASSWORD?: string;
  MAILER_FROM?: string;
  MAILER_ALLOWED_RECIPIENTS?: string;
}

/**
 * Aviso interno para los casos en que hay plata recibida y ninguna orden
 * emitida. Es best-effort a proposito: un fallo del correo no puede cambiar la
 * respuesta del webhook -- la fila en Supabase ya dice la verdad, y hacer que
 * Mercado Pago reintente por un correo caido solo agrega ruido.
 */
export function crearAlertar(env: AlertaEnv, mailerInyectado?: Mailer): Alertar {
  return async (asunto: string, detalle: string): Promise<void> => {
    const destino = String(env.MAILER_ALLOWED_RECIPIENTS ?? '').split(',')[0]?.trim();
    if (!destino) return;
    try {
      const mailer = mailerInyectado ?? createMailer(
        createGmailTransport({
          user: env.GMAIL_USER as string,
          appPassword: env.GMAIL_APP_PASSWORD as string,
        }),
        env.MAILER_FROM as string,
      );
      await mailer.send({
        to: destino,
        subject: `[pagos] ${asunto}`,
        text: detalle,
        html: `<p>${detalle.replace(/&/g, '&amp;').replace(/</g, '&lt;')}</p>`,
      });
    } catch {
      // Ya quedo en la fila de `pagos`; el correo es un extra.
      console.error('[pago] no se pudo mandar la alerta interna');
    }
  };
}
```

- [ ] **Step 4: Escribir los tres envoltorios**

Crear `apps/mailer/api/pago/crear.ts`:

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createCrearHandler } from '../../src/pago/crear.js';

// Envoltorio fino, igual que api/send.ts. La validacion de entorno vive en el
// handler, porque las pruebas lo ejercitan inyectando `env` en el factory.
export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return createCrearHandler()(req, res);
}
```

Crear `apps/mailer/api/pago/webhook.ts`:

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { crearAlertar } from '../../src/pago/alerta.js';
import { createWebhookHandler } from '../../src/pago/webhook.js';

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return createWebhookHandler(crearAlertar(process.env))(req, res);
}
```

Crear `apps/mailer/api/pago/retorno.ts`:

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';

// La pagina a la que Mercado Pago devuelve al cliente. No decide nada: la
// verdad del pago llega por el webhook. Solo lo devuelve a la conversacion.
export default function handler(_req: VercelRequest, res: VercelResponse): void {
  res.status(200);
  res.setHeader('Content-Type', 'text/html; charset=utf-8');
  res.send(`<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Pago recibido</title>
<style>
  :root { color-scheme: light; }
  body { margin:0; min-height:100vh; display:grid; place-items:center;
         font:16px/1.5 system-ui,sans-serif; background:#f6f5f1; color:#1c1c1c; padding:24px; }
  main { max-width:26rem; text-align:center; }
  h1 { font-size:1.5rem; margin:0 0 .5rem; }
  p { margin:0; color:#4a4a4a; }
</style>
</head>
<body>
  <main>
    <h1>Listo</h1>
    <p>Vuelve a WhatsApp: apenas se acredite el pago te confirmamos el pedido por ahí.</p>
  </main>
</body>
</html>`);
}
```

- [ ] **Step 5: Documentar en el README del relé**

En `apps/mailer/README.md`, cambiar la primera línea del documento de `# `apps/mailer` — el relé de correo propio` a `# `apps/mailer` — el relé` y agregar, después de la sección de arquitectura, esta sección:

````markdown
## Cobro con Mercado Pago

Desde el 2026-09-10 el relé también cobra: el workflow del Rayo le pide el
link de pago y Mercado Pago le avisa cuando el pago se acredita. El diseño
está en `docs/superpowers/specs/2026-09-10-pagos-mercado-pago-design.md`.

| Ruta | Qué hace |
|---|---|
| `POST /api/pago/crear` | Autenticada con `x-api-key`. Crea la preferencia, guarda la fila `pagos` y manda el link por WhatsApp |
| `POST /api/pago/webhook` | Pública, autenticada por la firma HMAC de Mercado Pago. Emite las órdenes de compra cuando el pago queda aprobado |
| `GET /api/pago/retorno` | La página a la que Mercado Pago devuelve al cliente |

Variables nuevas en el proyecto `rr-mailing`:

| Variable | Qué es |
|---|---|
| `MP_ACCESS_TOKEN` | Access token de la aplicación de Mercado Pago. Cargar como **Sensitive** |
| `MP_WEBHOOK_SECRET` | Clave secreta de la notificación, del panel de Mercado Pago. **Sensitive** |
| `PAGO_BASE_URL` | `https://rr-mailing.vercel.app` |
| `KAPSO_API_KEY` | La misma clave de la Platform API que usan los scripts de `apps/kapso-agent` |

En el panel de Mercado Pago hay que apuntar la notificación de tipo `payment`
a `<PAGO_BASE_URL>/api/pago/webhook`.

**Por qué el cobro vive acá y no en una app propia:** el relé ya autentica
llamadas de Kapso, ya lee Supabase y ya manda correo en proceso — las tres
cosas que el cobro necesita. Un quinto proyecto de Vercel para dos endpoints
habría que linkearlo, configurarlo y desplegarlo aparte, y el aviso interno
tendría que salir por HTTP contra este mismo relé.
````

- [ ] **Step 6: Verificar typecheck y toda la batería**

Run: `npm test`
Expected: PASS.

Run: `npm run typecheck`
Expected: sin errores.

- [ ] **Step 7: Commit**

```bash
git add apps/mailer/api/pago apps/mailer/src/pago/alerta.ts apps/mailer/tests/pago-alerta.test.ts apps/mailer/README.md
git commit -m "feat(pagos): endpoints, alerta interna y documentacion del rele"
```

---

### Task 10: Cirugía del grafo y prompt del cierre

Lo último que se toca, porque hasta acá nada cambió el comportamiento del bot en producción. Después de esta tarea, el Rayo cobra.

**Files:**
- Modify: `apps/kapso-agent/scripts/deploy-workflow.ts`
- Create: `apps/kapso-agent/prompts/agente-cierre/v-03.md`
- Modify: `apps/kapso-agent/prompts/agente-cierre/v-02.md` (marcar como superada)
- Modify: `apps/kapso-agent/README.md`
- Test: `apps/kapso-agent/tests/prompts.test.ts` (ya existente, valida que haya una sola vigente)

**Interfaces:**
- Consumes: `POST /api/pago/crear` (Task 9), desplegado y funcionando.
- Produces: el grafo `agente_cierre → fn_crear_pago → handoff_fin`.

- [ ] **Step 1: Escribir el prompt v-03**

Crear `apps/kapso-agent/prompts/agente-cierre/v-03.md` copiando entero `v-02.md` y aplicando tres cambios:

1. La cabecera pasa a `# Cierre y confirmación — v-03`, `**Fecha**` a `2026-09-10`, y `**Siguiente nodo**` a `fn_crear_pago`.
2. La sección "Qué cambió" se reemplaza por:

```markdown
## Qué cambió

Respecto de v-02, el flujo pasa a cobrar antes de emitir: `quote_confirmed:
true` ya no dispara las órdenes de compra al mayorista, dispara el link de
pago de Mercado Pago. Dos ajustes:

1. **El cierre ya no promete que alguien contactará para coordinar el pago.**
   Ahora anuncia que el link llega enseguida, porque efectivamente llega —
   lo manda el servicio de pagos apenas se crea la preferencia.
2. **La línea "Pago: contado" del resumen** pasa a "Pago: con tarjeta por
   Mercado Pago", que es lo que el cliente está a punto de ver.

La advertencia sobre `quote_confirmed` se mantiene íntegra: el riesgo bajó
(un falso positivo manda un link, no una orden de compra) pero la regla no
cambia.
```

3. Dentro del bloque `<!-- PROMPT:INICIO -->`, en el ejemplo de mensaje, cambiar `Pago: contado` por `Pago: con tarjeta (Mercado Pago)`, y reemplazar la línea final del bloque "La confirmación" para el caso del sí por:

```markdown
- **Sí inequívoco** ("sí", "dale", "cúrsalo") → `save_variable` con
  `quote_confirmed: true` y después `complete_task`. Enseguida le llega al
  cliente el link de pago; no lo anuncies con más detalle ni prometas plazos.
```

- [ ] **Step 2: Marcar v-02 como superada**

En `apps/kapso-agent/prompts/agente-cierre/v-02.md`, cambiar la fila `| **Estado** | vigente |` por `| **Estado** | superada |`.

- [ ] **Step 3: Correr el test de prompts**

Run: `npx vitest run apps/kapso-agent/tests/prompts.test.ts`
Expected: PASS — exactamente una versión vigente por agente.

- [ ] **Step 4: Operar el grafo**

En `apps/kapso-agent/scripts/deploy-workflow.ts`:

a) Agregar el helper del nodo `webhook` junto a `fn` y `decide`:

```ts
// El cobro entra por un nodo `webhook` y no por una function nueva: el cupo de
// Cloudflare Workers de Kapso esta en 5 de 5 y ninguna sobra. Un `webhook` no
// consume cupo.
function webhook(id: string, url: string, body: Record<string, unknown>, saveTo: string, x: number, y: number) {
  return {
    id,
    type: 'flow-node',
    position: { x, y },
    data: {
      node_type: 'webhook',
      display_name: 'Webhook: crear pago',
      config: {
        url,
        method: 'POST',
        headers: { 'X-API-Key': '${ENV:MAILER_API_KEY}', 'Content-Type': 'application/json' },
        body_template: body,
        save_response_to: saveTo,
      },
    },
  };
}
```

b) Reemplazar el nodo `fn_emitir_ordenes` y el nodo `send_confirmacion` por un solo nodo. Borrar estas dos definiciones del arreglo `nodes`:

```ts
    fn('fn_emitir_ordenes', id('emitir-ordenes-compra'), 'emitir-ordenes-compra', 'purchase_orders_response', 1500, 120),
```

y el objeto entero de `send_confirmacion` (desde `{ id: 'send_confirmacion',` hasta su `},` de cierre). En su lugar, poner:

```ts
    // El cobro reemplaza a la emision en el grafo: emitir-ordenes-compra sigue
    // desplegada, pero ahora la invoca el servicio de pagos cuando Mercado Pago
    // confirma. Y el texto de confirmacion lo manda ese mismo servicio, que es
    // el unico que sabe si hubo link, si no lo hubo, o si la cotizacion ya no
    // servia -- un send_text fijo aca mentiria en dos de los tres casos.
    webhook(
      'fn_crear_pago',
      'https://rr-mailing.vercel.app/api/pago/crear',
      {
        quote_id: '{{vars.quote_id}}',
        quote_version: '{{vars.quote_version}}',
        phone_number: '{{context.phone_number}}',
        phone_number_id: '{{system.whatsapp_config.phone_number_id}}',
        customer_name: '{{vars.quote_customer_name}}',
        billing_rut: '{{vars.billing_rut}}',
        billing_razon_social: '{{vars.billing_razon_social}}',
        billing_giro: '{{vars.billing_giro}}',
        billing_direccion: '{{vars.billing_direccion}}',
        billing_comuna: '{{vars.billing_comuna}}',
        billing_ciudad: '{{vars.billing_ciudad}}',
        billing_email: '{{vars.billing_email}}',
      },
      'pago_response',
      1500,
      120,
    ),
```

c) En `edges`, reemplazar las tres aristas finales:

```ts
    { source: 'agente_cierre', target: 'fn_emitir_ordenes', label: 'next' },
    { source: 'fn_emitir_ordenes', target: 'send_confirmacion', label: 'next' },
    { source: 'send_confirmacion', target: 'handoff_fin', label: 'next' },
```

por dos:

```ts
    { source: 'agente_cierre', target: 'fn_crear_pago', label: 'next' },
    { source: 'fn_crear_pago', target: 'handoff_fin', label: 'next' },
```

d) En el nodo `handoff_fin`, cambiar `reason` de `'Pedido cursado, órdenes de compra emitidas'` a `'Link de pago enviado; el pedido se emite al acreditarse'`.

- [ ] **Step 5: Verificar el script sin desplegar**

Run: `npm run typecheck`
Expected: sin errores.

Revisar a ojo que `nodes` ya no menciona `fn_emitir_ordenes` ni `send_confirmacion`, y que `edges` tiene 14 entradas:

Run: `grep -c "source:" apps/kapso-agent/scripts/deploy-workflow.ts`
Expected: `14`.

- [ ] **Step 6: Commit**

```bash
git add apps/kapso-agent/scripts/deploy-workflow.ts apps/kapso-agent/prompts/agente-cierre
git commit -m "feat(pagos): el cierre pide el link de pago en vez de emitir"
```

- [ ] **Step 7: Actualizar el README de kapso-agent**

En `apps/kapso-agent/README.md`, en la sección que describe el grafo, agregar:

```markdown
### El cobro no es una function

Desde el 2026-09-10 el nodo final antes del handoff es `fn_crear_pago`, un
nodo **`webhook`** que llama a `POST /api/pago/crear` del relé
(`apps/mailer`). No es una function de Kapso a propósito: el cupo de
Cloudflare Workers está en 5 de 5 y un nodo `webhook` no consume cupo.

`emitir-ordenes-compra` **sigue desplegada y sin cambios**, pero ya no está en
el grafo: ahora la invoca el servicio de pagos por la Platform API cuando
Mercado Pago confirma que el pago se acreditó. El nodo `send_confirmacion`
también salió — los mensajes al cliente los manda el servicio de pagos, que es
el único que sabe cuál de los seis corresponde.

Necesita `MAILER_API_KEY` como variable de entorno del workflow en Kapso
(`${ENV:MAILER_API_KEY}`), con el mismo valor que ya tiene cargado como
secreto la function `emitir-ordenes-compra`.
```

```bash
git add apps/kapso-agent/README.md
git commit -m "docs(kapso): el grafo cobra antes de emitir"
```

---

### Task 11: Despliegue y verificación de punta a punta

Nada de lo anterior cobra un peso hasta este paso. Va con credenciales de **prueba** de Mercado Pago.

**Files:** ninguno. Es operación.

**Interfaces:**
- Consumes: todo lo anterior.
- Produces: el cobro andando en el número sandbox.

- [ ] **Step 1: Crear la aplicación en Mercado Pago**

En `developers.mercadopago.com`, con la cuenta de la empresa: crear una aplicación de tipo Checkout Pro. Anotar el **Access Token de prueba**. En la sección de Webhooks, configurar la notificación de tipo `payment` apuntando a `https://rr-mailing.vercel.app/api/pago/webhook` y copiar la **clave secreta** que Mercado Pago genera ahí.

Crear también un **usuario de prueba comprador** para poder pagar.

- [ ] **Step 2: Cargar las variables en Vercel**

En el proyecto `rr-mailing` → Settings → Environment Variables, agregar las cuatro. `MP_ACCESS_TOKEN` y `MP_WEBHOOK_SECRET` como **Sensitive**.

```
MP_ACCESS_TOKEN      = <access token de prueba>
MP_WEBHOOK_SECRET    = <clave secreta del webhook>
PAGO_BASE_URL        = https://rr-mailing.vercel.app
KAPSO_API_KEY        = <la misma de los scripts de kapso-agent>
```

- [ ] **Step 3: Desplegar el relé**

```bash
git push
```

Esperar el deploy de `rr-mailing` y comprobar que el retorno responde:

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://rr-mailing.vercel.app/api/pago/retorno
```

Expected: `200`.

Comprobar que el webhook rechaza una llamada sin firma:

```bash
curl -s -X POST "https://rr-mailing.vercel.app/api/pago/webhook?type=payment&data.id=1" \
  -H 'Content-Type: application/json' -d '{}' -o /dev/null -w "%{http_code}\n"
```

Expected: `401`.

- [ ] **Step 4: Cargar `MAILER_API_KEY` en el workflow de Kapso y desplegar el grafo**

En el panel de Kapso, en las variables de entorno del proyecto, confirmar que existe `MAILER_API_KEY` con el mismo valor que tiene la function `emitir-ordenes-compra`. Después:

```bash
npm run kapso:functions   # redespliega generar-cotizacion-v2 con el campo nuevo
npm run kapso:workflow    # aplica la cirugia del grafo
```

Expected: ambos idempotentes, sin errores. El segundo imprime `workflow actualizado: f8fbe458-...`.

- [ ] **Step 5: Verificar el camino feliz**

Desde el número sandbox, conversar con el bot hasta el sí de `agente_cierre`.

Expected: llega un mensaje con botón "Pagar" y el monto correcto con IVA.

Pagar con el usuario de prueba y una tarjeta de prueba **aprobada**.

Expected, en orden:
1. Llega "Pago recibido ✅ Tu pedido quedó cursado".
2. Las órdenes de compra llegan al correo interno con sus PDF.
3. El pedido aparece en el backoffice ya en estado **pagado**, no en `nuevo`.
4. La fila de `pagos` en Supabase quedó en `emitido`.

- [ ] **Step 6: Verificar el rechazo**

Repetir con una tarjeta de prueba **rechazada**.

Expected: llega el aviso de rechazo, **no** se emite ninguna orden, la fila sigue `pendiente` y `intentos_rechazados` es 1. Pagar después con la tarjeta buena, con el mismo link, tiene que funcionar.

- [ ] **Step 7: Verificar la idempotencia**

Desde el panel de Mercado Pago, reenviar a mano la notificación del pago aprobado del paso 5.

Expected: no se emite una segunda orden de compra (ni llega un segundo correo), y la fila sigue en `emitido`.

- [ ] **Step 8: Verificar el caso sin vigencia**

En Supabase, sobre una cotización nueva de prueba, adelantar `valida_hasta` a dentro de 5 minutos. Confirmar el pedido en el bot.

Expected: no se crea link; llega el mensaje de que hay que refrescar precios.

- [ ] **Step 9: Anotar el resultado**

Agregar al final del README de `apps/mailer` una línea con la fecha de la verificación y qué credenciales se usaron (prueba o producción), igual que hace `apps/kapso-agent/README.md` con sus verificaciones.

```bash
git add apps/mailer/README.md
git commit -m "docs(pagos): resultado de la verificacion de punta a punta"
```

---

## Notas de cierre

**Lo que queda pendiente y es deliberado:**

- La tienda web sigue emitiendo sin cobrar. Enchufarla es reusar `POST /api/pago/crear` tal cual, en una fase aparte.
- `invocarFunction` queda duplicada entre `apps/tienda/src/lib/kapso.ts` y `apps/mailer/src/pago/kapso.ts`. Colapsan en un paquete cuando la tienda cobre.
- Pasar a producción es cambiar `MP_ACCESS_TOKEN` y `MP_WEBHOOK_SECRET` en Vercel y el `notification_url` en el panel de Mercado Pago. No toca código.

**El orden de las tareas no es negociable en un punto:** el bot sigue vendiendo exactamente como hoy hasta el Step 4 de la Task 11, el `npm run kapso:workflow` que aplica la cirugía del grafo. Las tareas 1 a 10 solo agregan código que nadie invoca todavía — la Task 10 deja el grafo nuevo escrito en el script, pero no desplegado. Si el trabajo se detiene en cualquier punto antes de ese comando, producción queda intacta.
