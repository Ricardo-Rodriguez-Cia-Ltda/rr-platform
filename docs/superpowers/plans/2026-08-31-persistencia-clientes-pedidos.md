# Persistencia de clientes, cotizaciones y pedidos — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que el negocio recuerde: los datos de facturación de un cliente se piden una sola vez (después se confirman/editan), y cada cotización y cada pedido quedan guardados completos en Supabase.

**Architecture:** Tres tablas en Supabase (Postgres, `sa-east-1`), consumidas por PostgREST vía `fetch` desde dos functions de Kapso ya existentes: `generar-cotizacion-v2` guarda la cotización y carga al cliente por su teléfono de WhatsApp (→ `vars.cliente_guardado`); `emitir-ordenes-compra` guarda el pedido completo y hace upsert del cliente confirmado. El prompt de facturación v-03 confirma en una línea en vez de pedir siete campos. La persistencia es best-effort con timeout de 4 s: jamás bloquea una venta.

**Tech Stack:** Supabase (PostgREST), JavaScript plano de Cloudflare Workers (sin imports del workspace), vitest con `loadHandler` + `vi.stubGlobal('fetch')`.

**Spec:** `docs/superpowers/specs/2026-08-31-persistencia-clientes-pedidos-design.md`

## Global Constraints

- **La persistencia nunca bloquea una venta**: toda llamada a Supabase con `AbortSignal.timeout(4000)`, y su fallo degrada al comportamiento actual.
- **Sin functions nuevas** (cupo 5/5) y **D1 no se toca**: sigue siendo el candado de idempotencia.
- Sin secretos configurados, el comportamiento es **idéntico al actual** — las pruebas existentes de ambas functions no cambian de resultado.
- La clave `service_role` vive solo en secretos de Kapso y en `.env.local`. **Jamás en código, en pruebas, en reportes ni en el chat.**
- El teléfono se normaliza a **solo dígitos**; sin teléfono en el contexto → no se carga ni guarda cliente (cotización/pedido van con `telefono: null`).
- La validación de RUT aguas abajo corre igual para datos guardados.
- Los contratos existentes de vars no cambian: `generar-cotizacion` solo **suma** `cliente_guardado`; `emitir` solo suma `persistencia` a nivel de respuesta.
- La suite tiene **755 pruebas**; al final: 755 + las nuevas, verdes, `npm run typecheck` limpio.
- Identificadores en inglés donde aplique; el JS de functions sigue su idioma actual (español en nombres de dominio); comentarios y prompts en español.
- **Nunca `git add -A` ni `git add .`** — hay directorios sin trackear del usuario en la raíz.
- No desplegar nada hasta la tarea final.

---

## Estructura de archivos

| Archivo | Papel |
|---|---|
| `docs/sql/2026-08-31-persistencia.sql` (crear) | DDL de las tres tablas — se pega una vez en el SQL Editor de Supabase |
| `apps/kapso-agent/functions/generar-cotizacion-v2.js` (modificar) | helper `supabase()` + guardar cotización + cargar cliente |
| `apps/kapso-agent/tests/generar-cotizacion-v2.test.ts` (modificar) | pruebas nuevas con fetch enrutado por URL |
| `apps/kapso-agent/functions/emitir-ordenes-compra.js` (modificar) | helper `supabase()` + guardar pedido + upsert cliente + `persistencia` |
| `apps/kapso-agent/tests/emitir-ordenes-compra.test.ts` (modificar) | sus pruebas |
| `apps/kapso-agent/scripts/deploy-functions.ts` (modificar) | secretos `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` en ambas functions |
| `apps/kapso-agent/prompts/agente-facturacion/v-03.md` (crear) + `v-02.md` (marcar reemplazado) | el flujo de confirmación |
| `apps/kapso-agent/README.md` (modificar) | sección breve de la persistencia |

---

### Task 1: El SQL de las tablas

**Files:**
- Create: `docs/sql/2026-08-31-persistencia.sql`

**Interfaces:**
- Produces: los nombres exactos de tablas y columnas que las Tareas 2 y 3 usan en sus llamadas PostgREST.

**Nota de ejecución:** el DDL no puede correrse por PostgREST. El archivo queda versionado y **el controlador se lo entrega al usuario para pegarlo una vez** en el SQL Editor de Supabase (como los reinicios de la API: es un paso humano del despliegue, no de esta tarea). Esta tarea solo crea y commitea el archivo; la verificación de que las tablas existen es de la Tarea 5.

- [ ] **Step 1: Escribir el archivo**

Contenido exacto (es el DDL del spec, verbatim):

```sql
-- Persistencia de clientes, cotizaciones y pedidos (spec 2026-08-31).
-- Se ejecuta UNA vez en el SQL Editor de Supabase. Idempotente.

create table if not exists clientes (
  telefono      text primary key,
  rut           text not null,
  razon_social  text not null,
  giro          text not null,
  direccion     text not null,
  comuna        text not null,
  ciudad        text not null,
  email         text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table if not exists cotizaciones (
  quote_id      text not null,
  version       text not null,
  telefono      text,
  neto_clp      bigint not null,
  iva_clp       bigint not null,
  total_clp     bigint not null,
  valida_hasta  timestamptz,
  lineas        jsonb not null,
  created_at    timestamptz not null default now(),
  primary key (quote_id, version)
);

create table if not exists pedidos (
  po_id           text primary key,
  quote_id        text not null,
  quote_version   text not null,
  proveedor       text not null,
  telefono        text,
  rut             text,
  razon_social    text,
  lineas          jsonb not null,
  neto_grupo_clp  bigint,
  estado          text not null,
  email_id        text,
  created_at      timestamptz not null default now()
);
```

- [ ] **Step 2: Commit**

```bash
git add docs/sql/2026-08-31-persistencia.sql
git commit -m "feat(persistencia): DDL de clientes, cotizaciones y pedidos"
```

---

### Task 2: `generar-cotizacion-v2` guarda la cotización y carga al cliente

**Files:**
- Modify: `apps/kapso-agent/functions/generar-cotizacion-v2.js`
- Test: `apps/kapso-agent/tests/generar-cotizacion-v2.test.ts`

**Interfaces:**
- Consumes: tablas de la Task 1 (`cotizaciones`, `clientes` con las columnas exactas).
- Produces: `vars.cliente_guardado` — objeto `{ rut, razon_social, giro, direccion, comuna, ciudad, email }` o `null`. La Task 4 (prompt) lo lee con ese nombre y esas claves exactas.

Contexto del archivo: el handler lee `const vars = body.execution_context?.vars || {}` (línea ~40), arma `quote` con `quote_id: crypto.randomUUID()`, `version`, `lineas`, `neto_clp`, `iva_clp`, `total_clp`, `valid_until`, y retorna `json({ estado: "ok", quote, vars: { quote_result, quote_id, quote_version, quote_total_clp, quote_valid_until } })`.

- [ ] **Step 1: Pruebas nuevas (fallan)**

En `generar-cotizacion-v2.test.ts`, siguiendo el patrón del archivo (léelo: `loadHandler`, `request`, mocks de fetch). El mock de fetch pasa a **enrutar por URL**: las URLs con `supabase.test` responden lo del caso; el resto responde lo que el mock actual ya respondía (la API de precios). El `env` de las pruebas nuevas suma `SUPABASE_URL: 'https://supabase.test'` y `SUPABASE_SERVICE_KEY: 'clave-de-prueba'`.

```ts
// La persistencia es memoria del negocio, no un eslabon: estas pruebas
// verifican tanto que se use como que su ausencia no cambie nada.
describe('generar-cotizacion-v2: persistencia', () => {
  const ENV_SB = { ...env, SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_KEY: 'clave-de-prueba' };
  const CTX = { context: { phone_number: '+56 9 4175 7584' } };
  const CLIENTE = { rut: '21099234-0', razon_social: 'Vicente Pareja', giro: 'Servicios', direccion: 'Holanda 222', comuna: 'Ñuñoa', ciudad: 'Santiago', email: 'parejavice@gmail.com' };

  it('carga al cliente por telefono normalizado y lo devuelve en vars', async () => {
    const llamadasSupabase: string[] = [];
    routeFetch({ supabase: (url) => { llamadasSupabase.push(url); return url.includes('/clientes') ? [CLIENTE] : {}; } });
    const res = await handler(request({ execution_context: { vars: CART_VARS, ...CTX } }), ENV_SB);
    const data = (await res.json()) as any;
    expect(data.vars.cliente_guardado).toEqual(CLIENTE);
    expect(llamadasSupabase.some((u) => u.includes('telefono=eq.56941757584'))).toBe(true);
  });

  it('guarda la cotizacion con sus totales y lineas', async () => {
    const cuerpos: any[] = [];
    routeFetch({ supabase: (url, init) => { if (url.includes('/cotizaciones')) cuerpos.push(JSON.parse(String(init?.body))); return url.includes('/clientes') ? [] : {}; } });
    const res = await handler(request({ execution_context: { vars: CART_VARS, ...CTX } }), ENV_SB);
    const data = (await res.json()) as any;
    expect(cuerpos).toHaveLength(1);
    expect(cuerpos[0].quote_id).toBe(data.vars.quote_id);
    expect(cuerpos[0].telefono).toBe('56941757584');
    expect(cuerpos[0].total_clp).toBe(data.vars.quote_total_clp);
    expect(Array.isArray(cuerpos[0].lineas)).toBe(true);
  });

  it('sin fila en Supabase, cliente_guardado es null', async () => {
    routeFetch({ supabase: (url) => (url.includes('/clientes') ? [] : {}) });
    const res = await handler(request({ execution_context: { vars: CART_VARS, ...CTX } }), ENV_SB);
    expect(((await res.json()) as any).vars.cliente_guardado).toBeNull();
  });

  it('con Supabase caido, la cotizacion sale igual y cliente_guardado es null', async () => {
    routeFetch({ supabase: () => { throw new Error('ECONNRESET'); } });
    const res = await handler(request({ execution_context: { vars: CART_VARS, ...CTX } }), ENV_SB);
    const data = (await res.json()) as any;
    expect(data.estado).toBe('ok');
    expect(data.vars.cliente_guardado).toBeNull();
  });

  it('sin telefono en el contexto no llama a /clientes y la cotizacion va con telefono null', async () => {
    const urls: string[] = [];
    const cuerpos: any[] = [];
    routeFetch({ supabase: (url, init) => { urls.push(url); if (url.includes('/cotizaciones')) cuerpos.push(JSON.parse(String(init?.body))); return {}; } });
    await handler(request({ execution_context: { vars: CART_VARS } }), ENV_SB);
    expect(urls.some((u) => u.includes('/clientes'))).toBe(false);
    expect(cuerpos[0]?.telefono).toBeNull();
  });

  it('sin secretos, no llama a Supabase y responde como siempre', async () => {
    const urls: string[] = [];
    routeFetch({ supabase: (url) => { urls.push(url); return {}; } });
    const res = await handler(request({ execution_context: { vars: CART_VARS, ...CTX } }), env); // env SIN supabase
    expect(urls).toHaveLength(0);
    expect(((await res.json()) as any).estado).toBe('ok');
    expect(((await res.json()) as any).vars.cliente_guardado).toBeUndefined();
  });
});
```

Notas para el implementador: `CART_VARS` es el fixture de carro que las pruebas existentes ya usan (reúsalo con el nombre que tenga); `routeFetch` es un helper nuevo del archivo de pruebas que stubbea `fetch` global enrutando: si la URL empieza con `https://supabase.test` usa el callback `supabase(url, init)` (un throw simula caída; el retorno se envuelve en `Response` 200 JSON), si no, delega en el mock de la API de precios que las pruebas existentes ya definen. Escríbelo una vez arriba del archivo y refactoriza solo si es trivial — las pruebas existentes no deben cambiar de resultado.

**Cuidado con el último caso**: `cliente_guardado` debe ser `undefined` (no `null`) cuando no hay secretos, para que el contrato actual de vars quede intacto byte a byte. Con secretos y sin fila, sí es `null` explícito.

- [ ] **Step 2: Correr y verlas fallar**

Run: `npx vitest run apps/kapso-agent/tests/generar-cotizacion-v2.test.ts`
Expected: FAIL las 6 nuevas; las existentes verdes.

- [ ] **Step 3: Implementar**

En `generar-cotizacion-v2.js`, arriba del handler:

```js
// --- persistencia (Supabase) ---------------------------------------------
// Memoria del negocio, no un eslabon del flujo: nunca lanza, 4s de timeout,
// y sin secretos configurados no hace nada. Ver el spec 2026-08-31.
async function supabase(env, method, path, body) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
      method,
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: method === "POST" ? "resolution=merge-duplicates,return=minimal" : "count=none"
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(4000)
    });
    if (!r.ok) return null;
    const text = await r.text();
    return text ? JSON.parse(text) : {};
  } catch (_) {
    return null;
  }
}

// El telefono de WhatsApp es la llave del cliente: llega solo, en el contexto.
function telefonoDesdeContexto(executionContext) {
  const ctx = executionContext?.context || {};
  const crudo = ctx.phone_number || ctx.contact?.wa_id || "";
  const digitos = String(crudo).replace(/\D/g, "");
  return digitos.length > 0 ? digitos : null;
}
```

Dentro del handler, después de armar `quote` y **antes** del `return json(...)` final:

```js
  // Persistencia best-effort: la cotizacion al registro, y el cliente (si
  // existe) de vuelta al flujo para que facturacion confirme en vez de pedir.
  const telefono = telefonoDesdeContexto(body.execution_context);
  let clienteGuardado = null;
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    const [_, filas] = await Promise.all([
      supabase(env, "POST", "/cotizaciones", {
        quote_id: quote.quote_id,
        version: String(quote.version),
        telefono,
        neto_clp: quote.neto_clp,
        iva_clp: quote.iva_clp,
        total_clp: quote.total_clp,
        valida_hasta: quote.valid_until,
        lineas: quote.lineas
      }),
      telefono
        ? supabase(env, "GET", `/clientes?telefono=eq.${telefono}&select=rut,razon_social,giro,direccion,comuna,ciudad,email&limit=1`)
        : Promise.resolve(null)
    ]);
    if (Array.isArray(filas) && filas.length > 0) clienteGuardado = filas[0];
  }
```

Y en el objeto `vars` del `return json(...)` final, **solo cuando hay secretos**, sumar `cliente_guardado: clienteGuardado`. La forma más simple que respeta el contrato: construir el objeto vars como hoy y hacer `if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) varsRespuesta.cliente_guardado = clienteGuardado;` antes del return.

- [ ] **Step 4: Correr el archivo completo**

Run: `npx vitest run apps/kapso-agent/tests/generar-cotizacion-v2.test.ts`
Expected: PASS todas (existentes + 6).

- [ ] **Step 5: Typecheck + suite completa**

Run: `npm run typecheck && npm test`
Expected: limpio; 755 + 6 = 761 verdes.

- [ ] **Step 6: Commit**

```bash
git add apps/kapso-agent/functions/generar-cotizacion-v2.js apps/kapso-agent/tests/generar-cotizacion-v2.test.ts
git commit -m "feat(persistencia): la cotizacion se guarda y el cliente vuelve al flujo"
```

---

### Task 3: `emitir-ordenes-compra` guarda el pedido y al cliente, y los secretos

**Files:**
- Modify: `apps/kapso-agent/functions/emitir-ordenes-compra.js`
- Modify: `apps/kapso-agent/scripts/deploy-functions.ts`
- Test: `apps/kapso-agent/tests/emitir-ordenes-compra.test.ts`

**Interfaces:**
- Consumes: tablas de la Task 1; el mismo helper `supabase()` y `telefonoDesdeContexto()` de la Task 2 — **duplicados verbatim** en este archivo (las functions son JS plano sin imports; es el trade-off ya aceptado del área).
- Produces: la respuesta gana `persistencia: "ok" | "fallo"` a nivel superior (no en vars).

Contexto del archivo: agrupa `quote.lineas` por `proveedor` en un `Map` `grupos`, emite un correo por grupo con `poId` y deja `resultados` (`{ proveedor, po_id, status, lineas }`). Lee `vars.billing_rut`, `billing_razon_social`, `billing_giro`, `billing_direccion`, `billing_comuna`, `billing_ciudad`, `billing_email`. Retorna `json({ ok: true, ordenes, vars: {...} })`.

- [ ] **Step 1: Pruebas nuevas (fallan)**

En `emitir-ordenes-compra.test.ts` (mismo patrón `routeFetch` de la Task 2 — duplícalo aquí adaptado al mock del relé que este archivo ya tiene; las URLs `supabase.test` van al callback, el resto al relé mockeado):

```ts
describe('emitir-ordenes-compra: persistencia', () => {
  // ENV_SB = el env valido de las pruebas existentes + SUPABASE_URL/KEY de prueba.
  // VARS_OK = el fixture de cotizacion confirmada de las pruebas existentes,
  // con billing_* poblados y context.phone_number en el execution_context.

  it('guarda una fila de pedido por proveedor, con las lineas del grupo', async () => {
    const cuerpos: any[] = [];
    routeFetch({ supabase: (url, init) => { if (url.includes('/pedidos')) cuerpos.push(JSON.parse(String(init?.body))); return {}; } });
    await handler(request(BODY_DOS_PROVEEDORES), ENV_SB);
    expect(cuerpos).toHaveLength(1);           // un solo POST con arreglo
    expect(cuerpos[0]).toHaveLength(2);        // dos proveedores = dos filas
    const proveedores = cuerpos[0].map((p: any) => p.proveedor).sort();
    expect(proveedores).toEqual(['ingram', 'intcomex']);
    expect(cuerpos[0][0].estado).toBe('sent');
    expect(cuerpos[0][0].rut).toBe('21099234-0');
  });

  it('hace upsert del cliente confirmado por telefono', async () => {
    const urls: string[] = [];
    const cuerpos: any[] = [];
    routeFetch({ supabase: (url, init) => { urls.push(url); if (url.includes('/clientes')) cuerpos.push(JSON.parse(String(init?.body))); return {}; } });
    await handler(request(BODY_DOS_PROVEEDORES), ENV_SB);
    expect(urls.some((u) => u.includes('/clientes?on_conflict=telefono'))).toBe(true);
    expect(cuerpos[0].telefono).toBe('56941757584');
    expect(cuerpos[0].razon_social).toBe('Vicente Pareja');
  });

  it('con Supabase caido, la emision completa igual y persistencia es fallo', async () => {
    routeFetch({ supabase: () => { throw new Error('ECONNRESET'); } });
    const res = await handler(request(BODY_DOS_PROVEEDORES), ENV_SB);
    const data = (await res.json()) as any;
    expect(data.ok).toBe(true);
    expect(data.vars.purchase_orders_ok).toBe(true);
    expect(data.persistencia).toBe('fallo');
  });

  it('sin secretos, ni llama a Supabase ni agrega el campo', async () => {
    const urls: string[] = [];
    routeFetch({ supabase: (url) => { urls.push(url); return {}; } });
    const res = await handler(request(BODY_DOS_PROVEEDORES), ENV_SIN_SUPABASE);
    expect(urls).toHaveLength(0);
    expect(((await res.json()) as any).persistencia).toBeUndefined();
  });

  it('sin telefono en contexto, el pedido se guarda con telefono null y el cliente no se toca', async () => {
    const urls: string[] = [];
    const cuerpos: any[] = [];
    routeFetch({ supabase: (url, init) => { urls.push(url); if (url.includes('/pedidos')) cuerpos.push(JSON.parse(String(init?.body))); return {}; } });
    await handler(request(BODY_SIN_TELEFONO), ENV_SB);
    expect(urls.some((u) => u.includes('/clientes'))).toBe(false);
    expect(cuerpos[0][0].telefono).toBeNull();
  });
});
```

El implementador construye `BODY_DOS_PROVEEDORES` (cotización de dos proveedores + `billing_*` + `context.phone_number: '+56 9 4175 7584'`) reutilizando los fixtures existentes del archivo, y `BODY_SIN_TELEFONO` igual pero sin `context`.

- [ ] **Step 2: Correr y verlas fallar**

Run: `npx vitest run apps/kapso-agent/tests/emitir-ordenes-compra.test.ts`
Expected: FAIL las 5 nuevas; las existentes verdes.

- [ ] **Step 3: Implementar**

1. Duplicar `supabase()` y `telefonoDesdeContexto()` verbatim de la Task 2 (mismo comentario de cabecera).
2. Durante el bucle de grupos, acumular las filas de pedido en un arreglo `filasPedidos` — una por proveedor, construida **después** de conocer el estado final de esa orden:

```js
    filasPedidos.push({
      po_id: poId,
      quote_id: quote.quote_id,
      quote_version: version,
      proveedor,
      telefono,
      rut: rut === "No informado" ? null : rut,
      razon_social: razon === "No informado" ? null : razon,
      lineas,
      neto_grupo_clp: lineas.reduce((suma, l) => suma + (Number(l.subtotal_neto_clp) || 0), 0),
      estado: resultados[resultados.length - 1].status,
      email_id: resultados[resultados.length - 1].status === "sent" ? (cuerpo.id || null) : null
    });
```

   (Colocación exacta: al final de cada iteración del `for`, cubriendo también las ramas `failed`/`duplicate` — el registro de negocio refleja lo que pasó, no solo los éxitos. En las ramas con `continue`, empujar la fila **antes** del `continue`.)

3. Después del bucle y antes del `return`:

```js
  // Registro de negocio, best-effort. D1 ya guardo la verdad tecnica; esto es
  // lo que el humano quiere mirar despues. Un fallo se declara, no se esconde.
  let persistencia;
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    const telefono = telefonoDesdeContexto(body.execution_context);
    const escrituras = [supabase(env, "POST", "/pedidos?on_conflict=po_id", filasPedidos)];
    if (telefono && rut !== "No informado") {
      escrituras.push(supabase(env, "POST", "/clientes?on_conflict=telefono", {
        telefono,
        rut,
        razon_social: razon,
        giro: String(vars.billing_giro || "No informado"),
        direccion: String(vars.billing_direccion || "No informado"),
        comuna: String(vars.billing_comuna || "No informado"),
        ciudad: String(vars.billing_ciudad || "No informado"),
        email,
        updated_at: new Date().toISOString()
      }));
    }
    const resultadosEscritura = await Promise.all(escrituras);
    persistencia = resultadosEscritura.every((r) => r !== null) ? "ok" : "fallo";
  }
```

   (`telefono` calcúlalo una vez arriba si lo prefieres; `giro/direccion/comuna/ciudad` se leen de vars aquí porque el archivo hoy solo extrae `rut`, `razon`, `email` — no cambies esas tres extracciones existentes.)

4. En el `return json({...})` final: `...(persistencia !== undefined ? { persistencia } : {})`.

5. En `deploy-functions.ts`, la lista `FUNCTIONS`: `generar-cotizacion-v2` y `emitir-ordenes-compra` suman `'SUPABASE_URL', 'SUPABASE_SERVICE_KEY'` a sus `secrets`, y `VALUES` gana:

```ts
  SUPABASE_URL: process.env.SUPABASE_URL ?? '',
  SUPABASE_SERVICE_KEY: process.env.SUPABASE_SERVICE_KEY ?? '',
```

- [ ] **Step 4: Correr el archivo y la suite**

Run: `npx vitest run apps/kapso-agent/tests/emitir-ordenes-compra.test.ts && npm run typecheck && npm test`
Expected: todo verde; 761 + 5 = 766.

- [ ] **Step 5: Commit**

```bash
git add apps/kapso-agent/functions/emitir-ordenes-compra.js apps/kapso-agent/tests/emitir-ordenes-compra.test.ts apps/kapso-agent/scripts/deploy-functions.ts
git commit -m "feat(persistencia): el pedido completo y el cliente confirmado quedan guardados"
```

---

### Task 4: El prompt de facturación v-03

**Files:**
- Create: `apps/kapso-agent/prompts/agente-facturacion/v-03.md`
- Modify: `apps/kapso-agent/prompts/agente-facturacion/v-02.md` (solo `| **Estado** | vigente |` → `| **Estado** | reemplazado |`)
- Modify: `apps/kapso-agent/README.md` (sección nueva de persistencia + tabla de prompts si la hay)

**Interfaces:**
- Consumes: `vars.cliente_guardado` de la Task 2 (objeto con `rut, razon_social, giro, direccion, comuna, ciudad, email`, o `null`/ausente).

- [ ] **Step 1: v-03**

Copiar v-02 y aplicar: cabecera (`v-03`, `vigente`, fecha `2026-08-31`, fila **Lee** pasa a `quote_result`, `rut_valid`, `cliente_guardado`); `## Qué cambió` nuevo que explique el flujo de confirmación (el bot ahora recuerda; motivación: el usuario pidió que se pregunte una sola vez). Dentro del bloque PROMPT, **antes** de la sección "## El mensaje", insertar:

```markdown
## Si hay datos guardados

Si `cliente_guardado` existe (no es null), NO pidas los siete campos. Preséntalos
y pide confirmación en un solo mensaje:

```
¿Facturamos con los datos de la vez pasada?

RUT 21099234-0 · Vicente Pareja
Giro: Servicios
Holanda 222, Ñuñoa, Santiago
parejavice@gmail.com

¿Está todo igual o corregimos algo?
```

- Si confirma: guarda los siete campos con `save_variable` **desde
  `cliente_guardado`** (cada `billing_*` con su valor guardado) y llama a
  `complete_task`.
- Si corrige un campo: reemplaza **solo ese campo**, los demás van desde
  `cliente_guardado`. No vuelvas a preguntar los que no mencionó.
- Si dice que es otra persona o empresa, descarta lo guardado y pide los siete
  como se describe abajo.

La validación del RUT corre igual con datos guardados: si vuelve inválido, se
pide revisar el RUT como siempre.

## Si no hay datos guardados
```

(y la sección "El mensaje" actual queda bajo ese encabezado, con el resto del prompt intacto — incluida la reentrada por RUT y las reglas de escalada.)

- [ ] **Step 2: README**

En `apps/kapso-agent/README.md`, tras la sección de la tabla D1, una sección `## Persistencia de negocio (Supabase)` breve: qué guarda cada function, que es best-effort (jamás bloquea una venta), que la llave del cliente es el teléfono de WhatsApp, dónde se mira (el editor de tablas de Supabase), y que los secretos son `SUPABASE_URL` y `SUPABASE_SERVICE_KEY`, cargados desde `.env.local` por `deploy-functions.ts`.

- [ ] **Step 3: Pruebas y commit**

Run: `npx vitest run apps/kapso-agent/tests/prompts.test.ts && npm test`
Expected: prompts valida v-03 como única vigente; suite completa verde (las paramétricas de prompts suman casos solas).

```bash
git add apps/kapso-agent/prompts/agente-facturacion/v-03.md apps/kapso-agent/prompts/agente-facturacion/v-02.md apps/kapso-agent/README.md
git commit -m "feat(persistencia): facturacion confirma los datos guardados en vez de pedirlos"
```

---

### Task 5: Despliegue y verificación de punta a punta (controlador)

**Files:** ninguno — operacional.

**Orden:**

- [ ] **Step 1: Tablas.** El controlador entrega `docs/sql/2026-08-31-persistencia.sql` al usuario para pegarlo en el SQL Editor de Supabase, y verifica después: `GET /rest/v1/clientes?limit=1` → `200 []` (y lo mismo para `cotizaciones` y `pedidos`).
- [ ] **Step 2: Desplegar.** `npm run kapso:functions` (sube código y secretos de ambas functions) y `npm run kapso:workflow` (prompt v-03). No hay cambios en la API de oficina: **no hay reinicio**.
- [ ] **Step 3: Verificación sintética.** Vía Platform API: invocar `generar-cotizacion` con un carro real y `context.phone_number` de prueba → confirmar en Supabase la fila de `cotizaciones` y `cliente_guardado: null`. Insertar un cliente de prueba vía REST, invocar de nuevo → `cliente_guardado` poblado. Invocar `emitir-ordenes-compra` con una cotización de humo → filas en `pedidos` y upsert en `clientes`. Borrar los datos de prueba al final.
- [ ] **Step 4: Verificación real (usuario).** Las conversaciones 1-3 del spec: comprar dictando datos; volver a comprar y confirmar con "sí"; corregir un campo. El controlador revisa las tablas tras cada una.

---

## Verificación final

```bash
npm test            # 766 verdes
npm run typecheck
grep -rn "SUPABASE_SERVICE_KEY" apps/kapso-agent/functions/*.js | grep -v "env\." | wc -l   # 0: la clave jamas en codigo
```

Y contra el mundo real: un cliente que vuelve confirma con una palabra, y las tres tablas se llenan solas.
