# PDF de cotización por WhatsApp — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que al cotizar, el cliente reciba en el mismo chat un PDF formal con membrete, número correlativo y tabla de valores, generado al vuelo desde la cotización guardada en Supabase.

**Architecture:** `apps/mailer` gana `GET /api/cotizacion/<quote_id>`: lee la fila de `cotizaciones` (+ `clientes`), la transforma con `buildCotizacionView` (pura, donde viven las pruebas) y la dibuja con `pdf-lib` (`drawCotizacion`, fino). `generar-cotizacion-v2` — tras guardar la cotización con éxito — manda el documento por la API Meta-proxy de Kapso (`POST /meta/whatsapp/v24.0/{phone_number_id}/messages`, header `X-API-Key`), best-effort: un fallo del PDF jamás toca la cotización conversacional.

**Tech Stack:** `pdf-lib` (JS puro, nueva dependencia de `apps/mailer`), PostgREST, Cloud API de Meta vía Kapso, vitest.

**Spec:** `docs/superpowers/specs/2026-09-01-pdf-cotizacion-design.md`

## Global Constraints

- **El envío del PDF es best-effort**: si falla, la cotización de texto sale igual; `pdf: "enviado" | "fallo"` a nivel de respuesta (ausente sin los secretos nuevos). Solo se intenta si el guardado de la cotización en Supabase fue exitoso — un link a una fila que no existe es un 404 garantizado.
- El endpoint del PDF es **público por diseño** (capability URL: el `quote_id` UUID v4); valida la forma del id (`^[0-9a-f-]{36}$`, case-insensitive) y responde 404 ante cualquier otra cosa.
- Los helpers `supabase()` de `generar-cotizacion-v2.js` y `emitir-ordenes-compra.js` deben seguir **byte-idénticos**: cualquier cambio se aplica a ambos.
- Ninguna clave real en código, pruebas ni reportes. La suite hoy: **828 verdes**; al final todas + las nuevas. `npm run typecheck` limpio.
- Identificadores en inglés; textos del PDF y comentarios en español. **Nunca `git add -A`** (directorios sin trackear del usuario, incluida `idea pdf/`).
- No desplegar nada hasta la tarea final.

---

## Estructura de archivos

| Archivo | Papel |
|---|---|
| `docs/sql/2026-09-01-numero-cotizacion.sql` (crear) | ALTER de la columna `numero` — lo pega el usuario |
| `apps/mailer/src/cotizacion-view.ts` (crear) | `buildCotizacionView` + `formatCLP` — pura |
| `apps/mailer/src/cotizacion.ts` (crear) | `createCotizacionHandler` + `drawCotizacion` (pdf-lib) |
| `apps/mailer/api/cotizacion/[id].ts` (crear) | Envoltorio Vercel fino |
| `apps/mailer/tests/cotizacion-view.test.ts`, `apps/mailer/tests/cotizacion.test.ts` (crear) | Sus pruebas |
| `apps/mailer/package.json` (modificar) | `pdf-lib` |
| `apps/kapso-agent/functions/generar-cotizacion-v2.js` + `emitir-ordenes-compra.js` (modificar) | helper con `prefer` opcional (idéntico en ambos); el envío solo en generar |
| `apps/kapso-agent/tests/generar-cotizacion-v2.test.ts` (modificar) | pruebas del envío |
| `apps/kapso-agent/scripts/deploy-functions.ts` (modificar) | secretos `KAPSO_API_KEY`, `COTIZACION_PDF_BASE` |
| `apps/mailer/README.md`, `apps/kapso-agent/README.md` (modificar) | el endpoint y los secretos nuevos |

---

### Task 1: El modelo de vista y el SQL

**Files:**
- Create: `docs/sql/2026-09-01-numero-cotizacion.sql`
- Create: `apps/mailer/src/cotizacion-view.ts`
- Test: `apps/mailer/tests/cotizacion-view.test.ts`

**Interfaces:**
- Produces (Task 2 depende de estos nombres exactos):

```ts
export interface CotizacionRow {
  quote_id: string;
  numero: number | null;         // null si la fila es anterior al ALTER
  telefono: string | null;       // para buscar al cliente
  neto_clp: number;
  iva_clp: number;
  total_clp: number;
  valida_hasta: string | null;   // ISO
  created_at: string;            // ISO
  lineas: Array<{
    mpn?: string | null;
    sku_proveedor?: string | null;
    nombre?: string | null;
    cantidad?: number;
    precio_unitario_clp?: number;
    subtotal_neto_clp?: number;
  }>;
}

export interface ClienteRow { razon_social: string; rut: string; }

export interface CotizacionView {
  numero: string;                // "1600001" o "S/N"
  archivo: string;               // "cotizacion-1600001.pdf" o "cotizacion-SN.pdf"
  fechaLarga: string;            // "Santiago, 1 de septiembre de 2026" (zona America/Santiago)
  cliente: { razonSocial: string; rut: string } | null;
  lineas: Array<{ codigo: string; descripcion: string; cantidad: number; valorUnitario: string; total: string }>;
  netoFmt: string; ivaFmt: string; totalFmt: string;   // "$1.221.795"
  vigenciaTexto: string;         // "COTIZACIÓN VÁLIDA HASTA: 01-09-2026, 18:45 hrs (hora de Santiago)" o "" si no hay fecha
}

export function formatCLP(n: number): string;
export function buildCotizacionView(row: CotizacionRow, cliente: ClienteRow | null): CotizacionView;
```

- [ ] **Step 1: El SQL**

`docs/sql/2026-09-01-numero-cotizacion.sql`:

```sql
-- Numero correlativo de cotizacion (spec 2026-09-01). Se ejecuta UNA vez en el
-- SQL Editor de Supabase. Arranca en 1.600.001 para quedar por sobre la
-- numeracion historica en papel (~1.53M); ajustar el start ANTES de pegar si
-- se quiere otro punto de partida.
alter table cotizaciones
  add column if not exists numero bigint generated always as identity (start with 1600001);
```

- [ ] **Step 2: Las pruebas del modelo (fallan)**

```ts
import { describe, expect, it } from 'vitest';
import { buildCotizacionView, formatCLP, type CotizacionRow } from '../src/cotizacion-view.js';

const ROW: CotizacionRow = {
  quote_id: 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4',
  numero: 1600001,
  neto_clp: 6108975,
  iva_clp: 1160705,
  total_clp: 7269680,
  valida_hasta: '2026-09-01T21:45:00.000Z',   // 18:45 en Santiago (UTC-3)
  created_at: '2026-09-01T18:00:00.000Z',
  lineas: [
    { mpn: 'D6UF9AT#ABM', nombre: 'HP EliteBook G1i - Notebook - 14"', cantidad: 5, precio_unitario_clp: 1221795, subtotal_neto_clp: 6108975 },
  ],
};

describe('formatCLP', () => {
  it('separa miles con punto y antepone $', () => {
    expect(formatCLP(1221795)).toBe('$1.221.795');
    expect(formatCLP(0)).toBe('$0');
    expect(formatCLP(990047)).toBe('$990.047');
  });
});

describe('buildCotizacionView', () => {
  it('arma numero, archivo y montos formateados', () => {
    const v = buildCotizacionView(ROW, null);
    expect(v.numero).toBe('1600001');
    expect(v.archivo).toBe('cotizacion-1600001.pdf');
    expect(v.netoFmt).toBe('$6.108.975');
    expect(v.ivaFmt).toBe('$1.160.705');
    expect(v.totalFmt).toBe('$7.269.680');
  });

  it('sin numero (fila anterior al ALTER) sale S/N, no revienta', () => {
    const v = buildCotizacionView({ ...ROW, numero: null }, null);
    expect(v.numero).toBe('S/N');
    expect(v.archivo).toBe('cotizacion-SN.pdf');
  });

  it('la fecha y la vigencia van en hora de Santiago', () => {
    const v = buildCotizacionView(ROW, null);
    expect(v.fechaLarga).toBe('Santiago, 1 de septiembre de 2026');
    expect(v.vigenciaTexto).toContain('01-09-2026');
    expect(v.vigenciaTexto).toContain('18:45');
  });

  it('el codigo de cada linea es el MPN, con fallback al SKU del proveedor', () => {
    const v = buildCotizacionView(ROW, null);
    expect(v.lineas[0].codigo).toBe('D6UF9AT#ABM');
    const sinMpn = buildCotizacionView({ ...ROW, lineas: [{ ...ROW.lineas[0], mpn: null, sku_proveedor: 'NT030HPQ58' }] }, null);
    expect(sinMpn.lineas[0].codigo).toBe('NT030HPQ58');
  });

  it('con cliente guardado va la razon social; sin el, null', () => {
    expect(buildCotizacionView(ROW, { razon_social: 'Felipe Carvallo SpA', rut: '20986748-6' }).cliente)
      .toEqual({ razonSocial: 'Felipe Carvallo SpA', rut: '20986748-6' });
    expect(buildCotizacionView(ROW, null).cliente).toBeNull();
  });

  it('sin valida_hasta, la vigencia es cadena vacia', () => {
    expect(buildCotizacionView({ ...ROW, valida_hasta: null }, null).vigenciaTexto).toBe('');
  });
});
```

- [ ] **Step 3: Verlas fallar** — `npx vitest run apps/mailer/tests/cotizacion-view.test.ts` → FAIL (módulo no existe).

- [ ] **Step 4: Implementar `cotizacion-view.ts`**

Guía (la forma final es tuya, las salidas las fijan las pruebas):

```ts
const ZONA = 'America/Santiago';

export function formatCLP(n: number): string {
  return '$' + Math.round(n).toLocaleString('es-CL'); // es-CL usa punto de miles
}
// fechaLarga: Intl.DateTimeFormat('es-CL', { timeZone: ZONA, day: 'numeric', month: 'long', year: 'numeric' })
//   -> "1 de septiembre de 2026", prefijado "Santiago, ".
// vigenciaTexto: partes dia/mes/anio/hora/minuto con Intl y timeZone ZONA,
//   armadas como "COTIZACIÓN VÁLIDA HASTA: dd-mm-aaaa, HH:MM hrs (hora de Santiago)".
// codigo: (l.mpn ?? l.sku_proveedor ?? '—'); descripcion: l.nombre ?? '';
```

Ojo con `toLocaleString('es-CL')` en Node: verifica en la prueba real que el separador sea `.` (Node ≥ 13 trae ICU completo; si saliera distinto, formatea a mano con regex). No dependas del locale del sistema.

- [ ] **Step 5: Verde + commit**

```bash
npx vitest run apps/mailer/tests/cotizacion-view.test.ts && npm run typecheck
git add docs/sql/2026-09-01-numero-cotizacion.sql apps/mailer/src/cotizacion-view.ts apps/mailer/tests/cotizacion-view.test.ts
git commit -m "feat(pdf): modelo de vista de la cotizacion y columna numero"
```

---

### Task 2: El endpoint que dibuja el PDF

**Files:**
- Create: `apps/mailer/src/cotizacion.ts`, `apps/mailer/api/cotizacion/[id].ts`
- Modify: `apps/mailer/package.json` (dependencia `pdf-lib`), `apps/mailer/README.md`
- Test: `apps/mailer/tests/cotizacion.test.ts`

**Interfaces:**
- Consumes: `buildCotizacionView`, `CotizacionRow`, `ClienteRow` (Task 1).
- Produces: `GET /api/cotizacion/<uuid>` → `200 application/pdf` (`Content-Disposition: inline; filename="cotizacion-<numero>.pdf"`), `404 {error:"cotizacion_no_encontrada"}`, `503 {error:"falta_configuracion", faltan:[...]}`. La Task 3 construye links `${COTIZACION_PDF_BASE}/<quote_id>`.

- [ ] **Step 1: `npm install pdf-lib -w @rr/mailer-app`** (verifica el nombre real del workspace en `apps/mailer/package.json` y usa ese; commit incluye el lockfile).

- [ ] **Step 2: Pruebas (fallan)**

Patrón del archivo hermano `apps/mailer/tests/send.test.ts`: handler factory + req/res falsos. Supabase se mockea con `vi.stubGlobal('fetch', ...)`.

```ts
import { describe, expect, it, vi, afterEach } from 'vitest';
import { PDFDocument } from 'pdf-lib';
import { createCotizacionHandler } from '../src/cotizacion.js';

const ENV = { SUPABASE_URL: 'https://supabase.test', SUPABASE_SERVICE_KEY: 'clave-de-prueba' };
const ROW = { quote_id: 'f9b6c8ad-5b51-408d-8de2-acd10ff35ec4', numero: 1600001, telefono: '56941757584', neto_clp: 1000, iva_clp: 190, total_clp: 1190, valida_hasta: '2026-09-01T21:45:00.000Z', created_at: '2026-09-01T18:00:00.000Z', lineas: [{ mpn: 'X', nombre: 'Producto', cantidad: 1, precio_unitario_clp: 1000, subtotal_neto_clp: 1000 }] };

// makeReq/makeRes: calca los de send.test.ts (res captura status, headers via setHeader, y body via send/end con Buffer).

function stubSupabase(rows: unknown[], clientes: unknown[] = []) {
  vi.stubGlobal('fetch', vi.fn(async (url: any) =>
    new Response(JSON.stringify(String(url).includes('/clientes') ? clientes : rows), { status: 200 })));
}
afterEach(() => vi.unstubAllGlobals());

describe('GET /api/cotizacion/[id]', () => {
  it('devuelve un PDF valido de una pagina con los headers correctos', async () => {
    stubSupabase([ROW]);
    const res = makeRes();
    await createCotizacionHandler()(makeReq({ id: ROW.quote_id }), res);
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toBe('application/pdf');
    expect(res.headers['content-disposition']).toContain('cotizacion-1600001.pdf');
    const bytes: Buffer = res.body;
    expect(bytes.subarray(0, 4).toString()).toBe('%PDF');
    const doc = await PDFDocument.load(bytes);
    expect(doc.getPageCount()).toBe(1);
  }, 15000);

  it('un id que no es UUID responde 404 sin tocar Supabase', async () => {
    const spy = vi.fn(); vi.stubGlobal('fetch', spy);
    const res = makeRes();
    await createCotizacionHandler()(makeReq({ id: '../etc/passwd' }), res);
    expect(res.statusCode).toBe(404);
    expect(spy).not.toHaveBeenCalled();
  });

  it('cotizacion inexistente responde 404 con el codigo del contrato', async () => {
    stubSupabase([]);
    const res = makeRes();
    await createCotizacionHandler()(makeReq({ id: ROW.quote_id }), res);
    expect(res.statusCode).toBe(404);
    expect(res.jsonBody?.error).toBe('cotizacion_no_encontrada');
  });

  it('sin variables de entorno responde 503 nombrando las que faltan, nunca valores', async () => {
    const res = makeRes();
    await createCotizacionHandler()(makeReq({ id: ROW.quote_id }), res, /* env sin SUPABASE_* */);
    expect(res.statusCode).toBe(503);
    expect(res.jsonBody?.faltan).toContain('SUPABASE_URL');
  });

  it('fila sin numero sale como S/N en el filename', async () => {
    stubSupabase([{ ...ROW, numero: null }]);
    const res = makeRes();
    await createCotizacionHandler()(makeReq({ id: ROW.quote_id }), res);
    expect(res.headers['content-disposition']).toContain('cotizacion-SN.pdf');
  });
});
```

(La firma exacta de `createCotizacionHandler` — si toma `env` inyectado como `createSendHandler` o lee `process.env` con `vi.stubEnv` — cópiala del patrón real de `src/send.ts`; ajusta la prueba de 503 a ese patrón.)

- [ ] **Step 3: Implementar**

`src/cotizacion.ts`:
- `createCotizacionHandler` valida el id (`/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i` → si no, 404 inmediato), consulta `GET {SUPABASE_URL}/rest/v1/cotizaciones?quote_id=eq.<id>&limit=1` con headers `apikey`/`Authorization` (timeout 8 s), luego `clientes?telefono=eq.<row.telefono>&limit=1` si hay teléfono; un fetch que falla o expira responde `503 {error:"upstream"}` (el link es reintentable); `buildCotizacionView`; `drawCotizacion`; responde el Buffer.
- `drawCotizacion(view)` con `pdf-lib`: página A4 (595×842), `StandardFonts.Helvetica` y `HelveticaBold`. Layout del mockup: monograma (rect borde azul `rgb(0.23,0.23,0.7)` con "R" bold 28 dentro — **no** incrustar `idea pdf/cotización.png`; si al implementar existe un archivo de logo separado en `idea pdf/` tipo `logo.png`, conviértelo a base64 en `src/logo.ts` e incrústalo con `embedPng`), membrete centrado (`RICARDO RODRIGUEZ & CIA. LTDA` bold 14 / `DIVISION INFORMATICA` 9 / `R.U.T.: 89.912.300-K` 9), fecha a la derecha, `COTIZACION N° <numero>` bold 13 centrado, bloque cliente (`Señores:` + razón social + `R.U.T.: <rut>` si hay; si no solo `Presente`), párrafo de cortesía, tabla con encabezados subrayados (Código 70pt · Descripción 260pt · Cantidad 60pt · Valor 70pt · Total 70pt; descripción truncada con "…" si excede el ancho a fuente 8), línea, `Neto / IVA / Total` alineados a la derecha con Total en bold, `Observaciones:` con viñetas (valores en pesos chilenos · `<vigenciaTexto>` · CONSULTAS AL FONO: +56-2-23641111), cierre de cortesía, y pie chico gris (WWW.RICARDORODRIGUEZ.CL · política de garantías · `José M. Infante #2629 Ñuñoa · Santiago — CHILE · e-mail: ventas@ricardorodriguez.cl`).
- Si las líneas superan las ~18 filas, segunda página con la tabla continuada (el caso real es 1-5 líneas; basta un `addPage` y reiniciar el cursor — pruébalo con una vista de 25 líneas en una prueba estructural: `getPageCount() === 2`).

`api/cotizacion/[id].ts`: envoltorio fino que llama al factory (mismo estilo que `api/send.ts`; el `id` llega en `req.query.id` por la ruta dinámica de Vercel).

- [ ] **Step 4: Verde + typecheck + suite completa** — `npx vitest run apps/mailer/tests/ && npm run typecheck && npm test`.

- [ ] **Step 5: README de `apps/mailer`** — sección corta: qué es el endpoint, que es una capability URL pública por diseño (UUID inadivinable), y que necesita `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` en el proyecto Vercel.

- [ ] **Step 6: Commit**

```bash
git add apps/mailer/src/cotizacion.ts apps/mailer/src/cotizacion-view.ts apps/mailer/api/cotizacion apps/mailer/tests/cotizacion.test.ts apps/mailer/package.json package-lock.json apps/mailer/README.md
git commit -m "feat(pdf): endpoint que dibuja la cotizacion desde Supabase"
```

---

### Task 3: `generar-cotizacion-v2` manda el documento

**Files:**
- Modify: `apps/kapso-agent/functions/generar-cotizacion-v2.js`, `apps/kapso-agent/functions/emitir-ordenes-compra.js` (solo el helper, idéntico), `apps/kapso-agent/scripts/deploy-functions.ts`, `apps/kapso-agent/README.md`
- Test: `apps/kapso-agent/tests/generar-cotizacion-v2.test.ts`

**Interfaces:**
- Consumes: el endpoint de la Task 2 (`${COTIZACION_PDF_BASE}/<quote_id>`); el helper `supabase()` existente en ambas functions.
- Produces: `pdf: "enviado" | "fallo"` a nivel de respuesta (ausente sin `KAPSO_API_KEY`/`COTIZACION_PDF_BASE`).

- [ ] **Step 1: El helper gana un `prefer` opcional — en AMBAS functions, idéntico**

La firma pasa a `supabase(env, method, path, body, prefer)`; el header `Prefer` usa `prefer` si viene, si no el valor actual según método. Ningún llamador existente cambia. (Se necesita porque el POST de cotizaciones ahora pide `return=representation` para recuperar el `numero` asignado.)

- [ ] **Step 2: Pruebas del envío (fallan)**

En `generar-cotizacion-v2.test.ts`, extendiendo `routeFetch` con una ruta más (`api.kapso.ai` → callback `kapso(url, init)`):

```ts
describe('generar-cotizacion-v2: PDF por WhatsApp', () => {
  const ENV_PDF = { ...ENV_SB_REAL, KAPSO_API_KEY: 'kapso-de-prueba', COTIZACION_PDF_BASE: 'https://pdf.test/api/cotizacion' };
  const CTX_FULL = { context: { phone_number: '+56 9 4175 7584' }, system: { whatsapp_config: { phone_number_id: '1286605217864083' } } };

  it('manda el documento con el link, filename por numero y al telefono del contexto', async () => {
    const envios: Array<{ url: string; body: any }> = [];
    routeFetch({
      supabase: (url) => (url.includes('/cotizaciones') ? [{ numero: 1600001 }] : []),
      kapso: (url, init) => { envios.push({ url, body: JSON.parse(String(init?.body)) }); return { messages: [{ id: 'wamid.X' }] }; },
    });
    const res = await handler(request({ execution_context: { vars: CART_VARS, ...CTX_FULL } }), ENV_PDF);
    const data = (await res.json()) as any;
    expect(data.pdf).toBe('enviado');
    expect(envios).toHaveLength(1);
    expect(envios[0].url).toContain('/meta/whatsapp/v24.0/1286605217864083/messages');
    expect(envios[0].body.type).toBe('document');
    expect(envios[0].body.to).toBe('56941757584');
    expect(envios[0].body.document.link).toBe(`https://pdf.test/api/cotizacion/${data.vars.quote_id}`);
    expect(envios[0].body.document.filename).toBe('cotizacion-1600001.pdf');
  });

  it('si Supabase no devolvio numero, el filename cae a los 8 primeros del quote_id', async () => {
    const envios: any[] = [];
    routeFetch({ supabase: (url) => (url.includes('/cotizaciones') ? [{}] : []), kapso: (url, init) => { envios.push(JSON.parse(String(init?.body))); return {}; } });
    const res = await handler(request({ execution_context: { vars: CART_VARS, ...CTX_FULL } }), ENV_PDF);
    const data = (await res.json()) as any;
    expect(envios[0].document.filename).toBe(`cotizacion-${String(data.vars.quote_id).slice(0, 8)}.pdf`);
  });

  it('si el guardado de la cotizacion fallo, NO se intenta el PDF', async () => {
    const kapsoCalls: string[] = [];
    routeFetch({ supabase: (url) => { if (url.includes('/cotizaciones')) throw new Error('caido'); return []; }, kapso: (url) => { kapsoCalls.push(url); return {}; } });
    const res = await handler(request({ execution_context: { vars: CART_VARS, ...CTX_FULL } }), ENV_PDF);
    expect(kapsoCalls).toHaveLength(0);
    expect(((await res.json()) as any).pdf).toBe('fallo');
  });

  it('si Kapso falla, pdf es fallo y todo lo demas queda intacto', async () => {
    routeFetch({ supabase: (url) => (url.includes('/cotizaciones') ? [{ numero: 1 }] : []), kapso: () => { throw new Error('ECONNRESET'); } });
    const res = await handler(request({ execution_context: { vars: CART_VARS, ...CTX_FULL } }), ENV_PDF);
    const data = (await res.json()) as any;
    expect(data.estado).toBe('ok');
    expect(data.pdf).toBe('fallo');
    expect(data.vars.quote_id).toBeTruthy();
  });

  it('sin los secretos nuevos, ni lo intenta y el campo no aparece', async () => {
    const kapsoCalls: string[] = [];
    routeFetch({ supabase: () => [], kapso: (url) => { kapsoCalls.push(url); return {}; } });
    const res = await handler(request({ execution_context: { vars: CART_VARS, ...CTX_FULL } }), ENV_SB_REAL); // sin KAPSO_API_KEY ni base
    expect(kapsoCalls).toHaveLength(0);
    expect(((await res.json()) as any).pdf).toBeUndefined();
  });
});
```

(`ENV_SB_REAL` y `CART_VARS` son los fixtures que el archivo ya tiene con sus nombres reales — reúsalos. La aserción del caso "guardado falló" fija también el comportamiento de `persistencia: "fallo"` existente: verifica que no lo rompes.)

- [ ] **Step 3: Implementar en `generar-cotizacion-v2.js`**

En el bloque de persistencia: el POST de cotizaciones pasa a `supabase(env, "POST", "/cotizaciones?select=numero", {...}, "resolution=merge-duplicates,return=representation")` y captura el resultado (`postCotizacion`). Después:

```js
  // El PDF formal, best-effort. Solo si la cotizacion QUEDO guardada: el link
  // apunta a esa fila, y un PDF hacia una fila inexistente es un 404 seguro.
  let pdf;
  if (env.KAPSO_API_KEY && env.COTIZACION_PDF_BASE) {
    const phoneNumberId = body.execution_context?.system?.whatsapp_config?.phone_number_id;
    if (postCotizacion !== null && telefono && phoneNumberId) {
      const numero = Array.isArray(postCotizacion) && postCotizacion[0]?.numero != null
        ? String(postCotizacion[0].numero)
        : String(quote.quote_id).slice(0, 8);
      const base = String(env.COTIZACION_PDF_BASE).replace(/\/+$/, "");
      try {
        const r = await fetch(`https://api.kapso.ai/meta/whatsapp/v24.0/${phoneNumberId}/messages`, {
          method: "POST",
          headers: { "X-API-Key": env.KAPSO_API_KEY, "Content-Type": "application/json" },
          body: JSON.stringify({
            messaging_product: "whatsapp",
            to: telefono,
            type: "document",
            document: {
              link: `${base}/${quote.quote_id}`,
              filename: `cotizacion-${numero}.pdf`,
              caption: "Tu cotización formal en PDF 📄"
            }
          }),
          signal: AbortSignal.timeout(5000)
        });
        pdf = r.ok ? "enviado" : "fallo";
      } catch (_) {
        pdf = "fallo";
      }
    } else {
      pdf = "fallo";
    }
  }
```

Y el `return` final gana `...(pdf !== undefined ? { pdf } : {})`.

- [ ] **Step 4: Secretos** — `deploy-functions.ts`: `generar-cotizacion-v2` suma `'KAPSO_API_KEY', 'COTIZACION_PDF_BASE'`; `VALUES` gana `KAPSO_API_KEY: process.env.KAPSO_API_KEY ?? ''` y `COTIZACION_PDF_BASE: 'https://rr-mailing.vercel.app/api/cotizacion'`. README de kapso-agent: dos filas en la tabla de secretos.

- [ ] **Step 5: Verde total** — `npx vitest run apps/kapso-agent/tests/generar-cotizacion-v2.test.ts apps/kapso-agent/tests/emitir-ordenes-compra.test.ts && npm run typecheck && npm test`. Verifica con un diff textual que los dos helpers `supabase()` quedaron byte-idénticos.

- [ ] **Step 6: Commit**

```bash
git add apps/kapso-agent/functions/generar-cotizacion-v2.js apps/kapso-agent/functions/emitir-ordenes-compra.js apps/kapso-agent/tests/generar-cotizacion-v2.test.ts apps/kapso-agent/scripts/deploy-functions.ts apps/kapso-agent/README.md
git commit -m "feat(pdf): la cotizacion llega como documento al chat, best-effort"
```

---

### Task 4: Despliegue y verificación (controlador)

**Files:** ninguno — operacional. Orden obligatorio:

- [ ] **Step 1 (usuario): el ALTER** — pegar `docs/sql/2026-09-01-numero-cotizacion.sql` en el SQL Editor. El controlador verifica: `GET /rest/v1/cotizaciones?select=numero&limit=1` responde 200.
- [ ] **Step 2 (usuario): las env de Vercel** — en vercel.com → proyecto `rr-mailing` → Settings → Environment Variables → agregar `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` (los mismos valores de `.env.local`), entorno Production.
- [ ] **Step 3: desplegar el relé** — desde la raíz, `npx vercel --prod --yes` con los ids de `apps/mailer/.vercel/project.json` (patrón conocido). Verificar: un `quote_id` real → `200 %PDF`; un UUID inventado → 404.
- [ ] **Step 4: desplegar Kapso** — `npm run kapso:functions` (secretos nuevos incluidos). No hay cambios de workflow ni de la API de oficina: **sin reinicio**.
- [ ] **Step 5: verificación sintética** — invocar `generar-cotizacion` vía Platform API con un carro real y el `phone_number_id` de prueba de Kapso; confirmar `pdf: "enviado"` y que el link del payload responde `%PDF`.
- [ ] **Step 6 (usuario): la real** — cotizar por WhatsApp y recibir el PDF adjunto.

---

## Verificación final

```bash
npm test                                  # 828 + todas las nuevas, verdes
npm run typecheck
grep -rn "KAPSO_API_KEY" apps/kapso-agent/functions/*.js | grep -v "env\." | wc -l    # 0
```

Y contra el mundo real: el PDF en el chat, con número correlativo, descargable desde el link.
