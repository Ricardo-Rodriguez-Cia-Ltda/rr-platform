# rr-isia-version2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Construir en Kapso el workflow `rr-isia-version2`, que cotiza con el mejor precio entre los tres mayoristas, aplica 13% de margen y, al aceptar el cliente, emite una orden de compra por mayorista.

**Architecture:** Cinco Cloudflare Workers ("Kapso Functions") son el borde determinista: reciben el carro, consultan `GET /mejor-precio` de la API de este repositorio, aplican el margen y emiten las órdenes. El LLM nunca ve un costo. El grafo de 13 nodos se crea por la Platform API de Kapso, no a mano en el canvas, para que quede reproducible.

**Tech Stack:** JavaScript (Cloudflare Workers) para las functions, TypeScript + tsx para los scripts de despliegue, Vitest para las pruebas, Kapso Platform API v1, Resend para correo, D1 para idempotencia.

**Spec:** `docs/superpowers/specs/2026-08-26-rr-isia-version2-design.md`

## Global Constraints

- **Margen:** `MARGEN=0.13` en los secretos de **cada** function nueva. Las functions de v1 quedan en `0.30`; no se tocan.
- **El workflow `Rayo Perez` (`155d9b86-f1f6-42cb-b40e-e623321d7a58`) no se modifica.** Ni sus nodos, ni sus functions, ni sus secretos.
- **Ningún costo puede aparecer en `quote_result`** ni en ninguna variable del workflow. El costo se reconstruye dividiendo por `(1 + MARGEN)` dentro de `emitir-ordenes-compra`.
- **API base:** `https://api.pyxis-latam.cl/rr/captador-precios`, header `x-api-key`.
- **Kapso Platform API:** `https://api.kapso.ai/platform/v1`, header `X-API-Key` con `KAPSO_API_KEY` de `.env.local`. Los PATCH de workflow van envueltos en `{"workflow": {...}}` y requieren `lock_version`.
- **Modelo de los agentes:** `provider_model_id: "8c6d57df-3f07-4290-b8a5-38047608c4df"` (`claude-haiku-4-5`), `temperature: 0`, el mismo de v1.
- **Contrato de las functions Kapso:** el código desplegado es `async function handler(request, env) { ... }` sin `export`. Un nodo `function` lee `body.execution_context.vars` y puede escribir variables devolviendo `{ vars: {...} }`. Un nodo `decide` lee además `body.available_edges` y debe devolver `{ next_edge }`. Una tool de agente lee `body.input`.
- **Idioma:** todo el código, los comentarios, los prompts y los mensajes al cliente van en español (chileno para lo que ve el cliente).
- **Los archivos `.js` de las functions son la fuente de verdad** y se despliegan tal cual. Las pruebas cargan el archivo con `new Function`, nunca una copia.

---

## Estructura de archivos

**Se crean:**

| Archivo | Responsabilidad |
|---|---|
| `docs/kapso/functions-v2/buscar-productos-v2.js` | Búsqueda en Intcomex con margen 13%, propaga `mpn` y `marca` |
| `docs/kapso/functions-v2/generar-cotizacion-v2.js` | Carro → `/mejor-precio` por línea → cotización en CLP con el ganador estampado |
| `docs/kapso/functions-v2/emitir-ordenes-compra.js` | Agrupa por mayorista, envía una OC por proveedor, idempotente en D1 |
| `docs/kapso/functions-v2/route-quote-decision-v2.js` | Decide `accepted` / `rejected` |
| `docs/kapso/functions-v2/check-quote-validity-v2.js` | Decide `valid` / `expired` |
| `docs/kapso/functions-v2/route-rut-v2.js` | Decide `valid` / `invalid` según `rut_valid` |
| `docs/kapso/prompts-v2/agente-descubrimiento/v-01.md` | Prompt del nodo `agente_descubrimiento` |
| `docs/kapso/prompts-v2/agente-presentacion/v-01.md` | Prompt del nodo `agente_presentacion` |
| `docs/kapso/prompts-v2/agente-facturacion/v-01.md` | Prompt del nodo `agente_facturacion` |
| `docs/kapso/prompts-v2/agente-cierre/v-01.md` | Prompt del nodo `agente_cierre` |
| `docs/kapso/prompts-v2/README.md` | Índice de los prompts de v2 |
| `tests/kapso/cargar.ts` | Helper que carga un `.js` de function y arma peticiones |
| `tests/kapso/buscar-productos-v2.test.ts` | Pruebas de la búsqueda |
| `tests/kapso/generar-cotizacion-v2.test.ts` | Pruebas de la cotización |
| `tests/kapso/emitir-ordenes-compra.test.ts` | Pruebas de la emisión de OC |
| `tests/kapso/routers-v2.test.ts` | Pruebas de las tres functions de ruteo |
| `tests/fixtures/mejor-precio-ok.json` | Respuesta 200 de `/mejor-precio` |
| `tests/fixtures/mejor-precio-ambiguo.json` | Respuesta 409 `ambiguo` |
| `tests/fixtures/search-intcomex.json` | Respuesta 200 de `/search` |
| `scripts/kapso.ts` | Cliente mínimo de la Platform API |
| `scripts/kapso-functions.ts` | Crea/actualiza, setea secretos y despliega las functions de v2 |
| `scripts/kapso-workflow-v2.ts` | Crea el workflow `rr-isia-version2` con sus 13 nodos y 15 aristas |
| `docs/kapso/README-v2.md` | Cómo desplegar y operar v2 |

**Se modifican:**

| Archivo | Cambio |
|---|---|
| `tests/prompts.test.ts` | Parametrizar sobre `docs/kapso/prompts` y `docs/kapso/prompts-v2` |
| `package.json` | Scripts `kapso:functions` y `kapso:workflow` |

---

### Task 1: Harness de pruebas y `buscar-productos-v2`

**Files:**
- Create: `tests/kapso/cargar.ts`
- Create: `tests/fixtures/search-intcomex.json`
- Create: `docs/kapso/functions-v2/buscar-productos-v2.js`
- Test: `tests/kapso/buscar-productos-v2.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `cargarHandler(ruta: string): Handler` y `peticion(cuerpo: unknown): Request` desde `tests/kapso/cargar.ts`, que usan las tareas 2, 3 y 4. `Handler` es `(request: Request, env: Record<string, unknown>) => Promise<Response>`. La function devuelve productos con la forma `{ sku, mpn, marca, nombre, categoria, precio, moneda, disponible }`.

- [ ] **Step 1: Escribir el helper de carga**

`tests/kapso/cargar.ts`:

```ts
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
```

- [ ] **Step 2: Escribir la fixture de `/search`**

`tests/fixtures/search-intcomex.json`:

```json
{
  "total": 2,
  "evaluados": 2,
  "productos": [
    {
      "sku": "AR155EPS14",
      "mpn": "ERC-38B",
      "nombre": "Cinta Epson ERC-38B negra",
      "marca": "Epson",
      "categoria": "Suministros",
      "precio": 11.0,
      "moneda": "US",
      "stock": 14
    },
    {
      "sku": "AR155EPS15",
      "mpn": "ERC-30B",
      "nombre": "Cinta Epson ERC-30B negra",
      "marca": "Epson",
      "categoria": "Suministros",
      "precio": 9.5,
      "moneda": "US",
      "stock": 0
    }
  ],
  "facetas": { "marca": [], "categoria": [], "precio": { "min": 9.5, "max": 11.0 } }
}
```

- [ ] **Step 3: Escribir las pruebas que fallan**

`tests/kapso/buscar-productos-v2.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarHandler, peticion } from './cargar.js';

const handler = cargarHandler('docs/kapso/functions-v2/buscar-productos-v2.js');
const busqueda = JSON.parse(readFileSync('tests/fixtures/search-intcomex.json', 'utf8'));
const env = { API_PRECIOS_KEY: 'clave', MARGEN: '0.13' };

function responderCon(payload: unknown, status = 200) {
  const spy = vi.fn(async () => new Response(JSON.stringify(payload), { status }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe('buscar-productos-v2', () => {
  it('propaga mpn y marca de cada producto', async () => {
    responderCon(busqueda);
    const res = await handler(peticion({ input: { q: 'cinta epson' } }), env);
    const datos = await res.json();
    expect(datos.estado).toBe('ok');
    expect(datos.productos[0].mpn).toBe('ERC-38B');
    expect(datos.productos[0].marca).toBe('Epson');
  });

  it('aplica 13% de margen sobre el costo', async () => {
    responderCon(busqueda);
    const res = await handler(peticion({ input: { q: 'cinta epson' } }), env);
    const datos = await res.json();
    expect(datos.productos[0].precio).toBe(12.43);
  });

  it('convierte precio_max de venta a costo antes de consultar', async () => {
    const spy = responderCon(busqueda);
    await handler(peticion({ input: { q: 'cinta', precio_max: 113 } }), env);
    const url = new URL(spy.mock.calls[0][0] as string);
    expect(Number(url.searchParams.get('precio_max'))).toBeCloseTo(100, 2);
  });

  it('traduce el 409 en demasiado_amplio con opciones', async () => {
    responderCon({ total: 800, facetas: { marca: [{ valor: 'HP' }], categoria: [] } }, 409);
    const res = await handler(peticion({ input: { q: 'notebook' } }), env);
    const datos = await res.json();
    expect(datos.estado).toBe('demasiado_amplio');
    expect(datos.opciones.marcas).toEqual(['HP']);
  });

  it('descarta productos sin mpn: sin mpn no hay comparacion posible', async () => {
    responderCon({ ...busqueda, productos: [{ ...busqueda.productos[0], mpn: null }] });
    const res = await handler(peticion({ input: { q: 'cinta' } }), env);
    const datos = await res.json();
    expect(datos.productos).toHaveLength(0);
  });
});
```

- [ ] **Step 4: Correr las pruebas y verificar que fallan**

Run: `npx vitest run tests/kapso/buscar-productos-v2.test.ts`
Expected: FAIL — `ENOENT: docs/kapso/functions-v2/buscar-productos-v2.js`

- [ ] **Step 5: Escribir la function**

`docs/kapso/functions-v2/buscar-productos-v2.js`:

```js
const API_BASE_DEFAULT = "https://api.pyxis-latam.cl/rr/captador-precios";
const TIMEOUT_MS = 25000;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function precioVenta(costo, margen) {
  const valor = Number(costo);
  if (!Number.isFinite(valor) || valor < 0) return null;
  return Math.round(valor * (1 + margen) * 100) / 100;
}

async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const input = body.input ?? {};
  const apiKey = String(env.API_PRECIOS_KEY ?? "").trim();
  const margen = Number(env.MARGEN ?? "0.13");

  if (!apiKey) return json({ estado: "error", mensaje: "La integración del catálogo no está configurada." }, 500);
  if (!Number.isFinite(margen) || margen < 0) return json({ estado: "error", mensaje: "La integración del catálogo no está disponible." }, 500);

  const q = String(input.q ?? "").trim();
  if (!q) return json({ estado: "error", mensaje: "Falta el término de búsqueda." }, 400);

  const limiteNumero = Number(input.limite ?? 5);
  const limite = Number.isInteger(limiteNumero) ? Math.min(Math.max(limiteNumero, 1), 8) : 5;
  const base = String(env.API_PRECIOS_URL ?? API_BASE_DEFAULT).replace(/\/+$/, "");
  const params = new URLSearchParams({ q, limite: String(limite) });

  if (input.marca) params.set("marca", String(input.marca).trim());
  if (input.categoria) params.set("categoria", String(input.categoria).trim());
  params.set("solo_con_stock", input.incluir_sin_stock === true ? "false" : "true");

  if (input.precio_max !== undefined && input.precio_max !== null && input.precio_max !== "") {
    const topeVenta = Number(input.precio_max);
    if (Number.isFinite(topeVenta) && topeVenta > 0) params.set("precio_max", (topeVenta / (1 + margen)).toFixed(4));
  }

  let respuesta;
  try {
    respuesta = await fetch(`${base}/search?${params.toString()}`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (_) {
    return json({ estado: "no_disponible", mensaje: "El catálogo no responde en este momento. Reintenta en unos minutos." });
  }

  const datos = await respuesta.json().catch(() => ({}));

  if (respuesta.status === 409) {
    return json({
      estado: "demasiado_amplio",
      total: Number.isFinite(Number(datos.total)) ? Number(datos.total) : undefined,
      mensaje: "Hay demasiados productos. Pregunta al cliente por marca o tipo de producto antes de volver a buscar.",
      opciones: {
        marcas: Array.isArray(datos.facetas?.marca) ? datos.facetas.marca.slice(0, 6).map((m) => String(m.valor)).filter(Boolean) : [],
        categorias: Array.isArray(datos.facetas?.categoria) ? datos.facetas.categoria.slice(0, 6).map((c) => String(c.valor)).filter(Boolean) : []
      }
    });
  }

  if (respuesta.status === 503) return json({ estado: "no_disponible", mensaje: "El catálogo se está actualizando. Reintenta en unos minutos." });
  if (!respuesta.ok) return json({ estado: "error", mensaje: "No se pudo consultar el catálogo en este momento." });

  // Sin mpn no se puede comparar contra los otros mayoristas al cotizar, y una
  // linea que no se puede comparar no deberia llegar al carro.
  const productos = Array.isArray(datos.productos)
    ? datos.productos.map((p) => ({
        sku: String(p.sku ?? ""),
        mpn: p.mpn == null ? null : String(p.mpn),
        marca: p.marca == null ? null : String(p.marca),
        nombre: String(p.nombre ?? ""),
        categoria: p.categoria == null ? null : String(p.categoria),
        precio: precioVenta(p.precio, margen),
        moneda: "USD",
        disponible: Number(p.stock ?? 0) > 0
      })).filter((p) => p.sku && p.nombre && p.mpn && p.precio !== null)
    : [];

  const facetaPrecio = datos.facetas?.precio;
  const min = precioVenta(facetaPrecio?.min, margen);
  const max = precioVenta(facetaPrecio?.max, margen);
  const rango = min !== null && max !== null ? { min, max, moneda: "USD" } : undefined;

  return json({
    estado: "ok",
    total: Number.isFinite(Number(datos.total)) ? Number(datos.total) : productos.length,
    mostrados: productos.length,
    productos,
    ...(rango ? { rango_precio: rango } : {})
  });
}
```

- [ ] **Step 6: Correr las pruebas y verificar que pasan**

Run: `npx vitest run tests/kapso/buscar-productos-v2.test.ts`
Expected: PASS, 5 pruebas.

- [ ] **Step 7: Commit**

```bash
git add tests/kapso/cargar.ts tests/kapso/buscar-productos-v2.test.ts tests/fixtures/search-intcomex.json docs/kapso/functions-v2/buscar-productos-v2.js
git commit -m "feat(kapso-v2): buscar-productos-v2 con margen 13% y mpn"
```

---

### Task 2: `generar-cotizacion-v2`

**Files:**
- Create: `docs/kapso/functions-v2/generar-cotizacion-v2.js`
- Create: `tests/fixtures/mejor-precio-ok.json`
- Create: `tests/fixtures/mejor-precio-ambiguo.json`
- Test: `tests/kapso/generar-cotizacion-v2.test.ts`

**Interfaces:**
- Consumes: `cargarHandler`, `peticion` de `tests/kapso/cargar.ts` (Task 1).
- Produces: la variable `quote_result`, cuyas líneas tienen exactamente estas claves: `mpn`, `marca`, `nombre`, `cantidad`, `proveedor`, `sku_proveedor`, `precio_unitario_usd`, `precio_unitario_clp`, `subtotal_neto_clp`, `disponible`, `abastecimiento`, `comparacion`, `ofertas_consideradas`, `ahorro_vs_peor_clp`. La cabecera tiene `quote_id`, `version`, `moneda`, `tipo_cambio_clp_usd`, `iva_rate`, `lineas`, `neto_clp`, `iva_clp`, `total_clp`, `ahorro_total_clp`, `proveedores_incompletos`, `created_at`, `valid_until`. Las tareas 3 y 7 dependen de estos nombres.

- [ ] **Step 1: Escribir las fixtures**

`tests/fixtures/mejor-precio-ok.json`:

```json
{
  "clave": "ERC38B|EPSON",
  "mpn": "ERC-38B",
  "marca": "Epson",
  "nombre": "Cinta Epson ERC-38B negra",
  "mejor": { "proveedor": "ingram", "sku": "ING-778", "precio": 11.0, "moneda": "USD", "stock": 25, "criterio": "mas_barato_con_stock" },
  "ofertas": [
    { "proveedor": "ingram", "sku": "ING-778", "precio": 11.0, "moneda": "USD", "stock": 25 },
    { "proveedor": "intcomex", "sku": "AR155EPS14", "precio": 12.5, "moneda": "USD", "stock": 14 },
    { "proveedor": "tecnoglobal", "sku": "TG-9001", "precio": 13.0, "moneda": "USD", "stock": 3 }
  ],
  "incompleta": []
}
```

`tests/fixtures/mejor-precio-ambiguo.json`:

```json
{ "error": "ambiguo", "marcas": ["Epson", "Epson America"] }
```

- [ ] **Step 2: Escribir las pruebas que fallan**

`tests/kapso/generar-cotizacion-v2.test.ts`:

```ts
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarHandler, peticion } from './cargar.js';

const handler = cargarHandler('docs/kapso/functions-v2/generar-cotizacion-v2.js');
const mejorOk = JSON.parse(readFileSync('tests/fixtures/mejor-precio-ok.json', 'utf8'));
const ambiguo = JSON.parse(readFileSync('tests/fixtures/mejor-precio-ambiguo.json', 'utf8'));

const env = {
  API_PRECIOS_KEY: 'clave',
  MARGEN: '0.13',
  TIPO_CAMBIO_CLP_USD: '950',
  IVA_RATE: '0.19',
  COTIZACION_VALID_HOURS: '3',
};

const carro = [{ mpn: 'ERC-38B', marca: 'Epson', sku: 'AR155EPS14', nombre: 'Cinta Epson', cantidad: 2 }];

function cola(respuestas: Array<{ payload: unknown; status?: number }>) {
  const spy = vi.fn(async () => {
    const siguiente = respuestas.shift();
    if (!siguiente) throw new Error('llamada de mas a fetch');
    return new Response(JSON.stringify(siguiente.payload), { status: siguiente.status ?? 200 });
  });
  vi.stubGlobal('fetch', spy);
  return spy;
}

async function cotizar(cart: unknown, respuestas: Array<{ payload: unknown; status?: number }>) {
  const spy = cola(respuestas);
  const res = await handler(peticion({ execution_context: { vars: { cart_items: cart } } }), env);
  return { datos: await res.json(), status: res.status, spy };
}

afterEach(() => vi.unstubAllGlobals());

describe('generar-cotizacion-v2', () => {
  it('cotiza con el ganador y no con la primera oferta', async () => {
    const { datos } = await cotizar(carro, [{ payload: mejorOk }]);
    const linea = datos.quote.lineas[0];
    expect(datos.estado).toBe('ok');
    expect(linea.proveedor).toBe('ingram');
    expect(linea.sku_proveedor).toBe('ING-778');
  });

  it('aplica 13% y convierte a CLP', async () => {
    const { datos } = await cotizar(carro, [{ payload: mejorOk }]);
    const linea = datos.quote.lineas[0];
    expect(linea.precio_unitario_usd).toBe(12.43);
    expect(linea.precio_unitario_clp).toBe(11809);
    expect(linea.subtotal_neto_clp).toBe(23618);
    expect(datos.quote.iva_clp).toBe(Math.round(23618 * 0.19));
    expect(datos.quote.total_clp).toBe(23618 + Math.round(23618 * 0.19));
  });

  it('ninguna linea filtra el costo', async () => {
    const { datos } = await cotizar(carro, [{ payload: mejorOk }]);
    const claves = Object.keys(datos.quote.lineas[0]).join(' ');
    expect(claves).not.toMatch(/costo/i);
    // El costo (11.0) no puede aparecer como valor. Buscarlo como substring seria
    // un falso positivo: "11" tambien esta dentro de 11809.
    expect(Object.values(datos.quote.lineas[0])).not.toContain(11);
    expect(Object.values(datos.quote.lineas[0])).not.toContain(11.0);
  });

  it('calcula el ahorro contra la oferta mas cara', async () => {
    const { datos } = await cotizar(carro, [{ payload: mejorOk }]);
    // (13.0 - 11.0) x 1.13 x 950 = 2147 por unidad, x 2 unidades
    expect(datos.quote.lineas[0].ahorro_vs_peor_clp).toBe(2147 * 2);
    expect(datos.quote.ahorro_total_clp).toBe(2147 * 2);
  });

  it('reintenta con marca ante un 409 ambiguo', async () => {
    const { datos, spy } = await cotizar([{ mpn: 'ERC-38B', sku: 'AR155EPS14', nombre: 'Cinta', cantidad: 1 }], [
      { payload: ambiguo, status: 409 },
      { payload: mejorOk },
    ]);
    expect(spy).toHaveBeenCalledTimes(2);
    expect(new URL(spy.mock.calls[1][0] as string).searchParams.get('marca')).toBe('Epson');
    expect(datos.estado).toBe('ok');
  });

  it('cae al fallback por proveedor+sku ante un 404', async () => {
    const { datos, spy } = await cotizar(carro, [
      { payload: { error: 'not_found' }, status: 404 },
      { payload: mejorOk },
    ]);
    const url = new URL(spy.mock.calls[1][0] as string);
    expect(url.searchParams.get('proveedor')).toBe('intcomex');
    expect(url.searchParams.get('sku')).toBe('AR155EPS14');
    expect(datos.quote.lineas[0].comparacion).toBe('fallback_intcomex');
  });

  it('no cotiza si el fallback tambien falla', async () => {
    const { datos, status } = await cotizar(carro, [
      { payload: { error: 'not_found' }, status: 404 },
      { payload: { error: 'not_found' }, status: 404 },
    ]);
    expect(status).toBe(409);
    expect(datos.estado).toBe('producto_no_disponible');
  });

  it('propaga los proveedores que no participaron', async () => {
    const parcial = { ...mejorOk, incompleta: [{ proveedor: 'tecnoglobal', error: 'upstream', detail: 'cuota' }] };
    const { datos } = await cotizar(carro, [{ payload: parcial }]);
    expect(datos.quote.proveedores_incompletos).toEqual(['tecnoglobal']);
    expect(datos.quote.lineas[0].comparacion).toBe('parcial');
  });

  it('rechaza un carro vacio', async () => {
    const { status } = await cotizar([], []);
    expect(status).toBe(400);
  });
});
```

- [ ] **Step 3: Correr las pruebas y verificar que fallan**

Run: `npx vitest run tests/kapso/generar-cotizacion-v2.test.ts`
Expected: FAIL — el archivo de la function no existe.

- [ ] **Step 4: Escribir la function**

`docs/kapso/functions-v2/generar-cotizacion-v2.js`:

```js
const API_BASE_DEFAULT = "https://api.pyxis-latam.cl/rr/captador-precios";
const TIMEOUT_MS = 25000;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

async function consultar(base, apiKey, params) {
  let respuesta;
  try {
    respuesta = await fetch(`${base}/mejor-precio?${params.toString()}`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (_) {
    return { status: 0, datos: {} };
  }
  const datos = await respuesta.json().catch(() => ({}));
  return { status: respuesta.status, datos };
}

async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};

  const crudo = vars.cart_items;
  let items = Array.isArray(crudo) ? crudo : null;
  if (!items && typeof crudo === "string") {
    try { const parsed = JSON.parse(crudo); items = Array.isArray(parsed) ? parsed : null; } catch (_) {}
  }

  const apiKey = String(env.API_PRECIOS_KEY || "").trim();
  const margen = Number(env.MARGEN ?? "0.13");
  const tipoCambio = Number(env.TIPO_CAMBIO_CLP_USD ?? "950");
  const iva = Number(env.IVA_RATE ?? "0.19");
  const horas = Number(env.COTIZACION_VALID_HOURS ?? "3");
  const base = String(env.API_PRECIOS_URL || API_BASE_DEFAULT).replace(/\/+$/, "");

  if (!apiKey) return json({ estado: "error", mensaje: "La cotización no está configurada." }, 500);
  if (![margen, tipoCambio, iva, horas].every(Number.isFinite) || margen < 0 || tipoCambio <= 0 || iva < 0 || horas <= 0) {
    return json({ estado: "error", mensaje: "La configuración de cotización no es válida." }, 500);
  }
  if (!items || items.length === 0 || items.length > 50) return json({ estado: "error", mensaje: "El carro no es válido." }, 400);

  const venta = (costo) => Math.round(Number(costo) * (1 + margen) * 100) / 100;
  const aClp = (usd) => Math.round(usd * tipoCambio);

  const lineas = [];
  const incompletos = new Set();

  for (const item of items) {
    const cantidad = Number(item.cantidad ?? item.quantity);
    const sku = String(item.sku ?? "").trim();
    const mpn = String(item.mpn ?? "").trim();
    const marca = String(item.marca ?? "").trim();

    if (!sku && !mpn) return json({ estado: "error", mensaje: "Una línea no tiene identificador." }, 400);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 10000) {
      return json({ estado: "error", mensaje: "Una línea tiene cantidad inválida." }, 400);
    }

    let comparacion = "completa";
    let resultado = null;

    if (mpn) {
      const params = new URLSearchParams({ mpn });
      if (marca) params.set("marca", marca);
      let intento = await consultar(base, apiKey, params);

      // 409 ambiguo: el mismo MPN existe bajo varias marcas. La API dice cuales;
      // se reintenta una vez con la primera en vez de rendirse.
      if (intento.status === 409 && Array.isArray(intento.datos.marcas) && intento.datos.marcas.length > 0) {
        const conMarca = new URLSearchParams({ mpn, marca: String(intento.datos.marcas[0]) });
        intento = await consultar(base, apiKey, conMarca);
      }
      if (intento.status === 200 && intento.datos?.mejor) resultado = intento.datos;
    }

    // Fallback: sin mpn, o el mejor precio no se pudo resolver. Se cotiza contra
    // Intcomex, que es de donde salio el producto en la busqueda.
    if (!resultado && sku) {
      const params = new URLSearchParams({ proveedor: "intcomex", sku });
      const intento = await consultar(base, apiKey, params);
      if (intento.status === 200 && intento.datos?.mejor) {
        resultado = intento.datos;
        comparacion = "fallback_intcomex";
      }
    }

    if (!resultado) {
      return json({ estado: "producto_no_disponible", sku: sku || mpn, mensaje: "Un producto ya no tiene precio vigente." }, 409);
    }

    const mejor = resultado.mejor;
    const precioUsd = venta(mejor.precio);
    if (!Number.isFinite(precioUsd)) return json({ estado: "error", mensaje: "La respuesta del proveedor no es válida." }, 502);

    const faltantes = Array.isArray(resultado.incompleta) ? resultado.incompleta : [];
    for (const f of faltantes) incompletos.add(String(f.proveedor));
    if (comparacion === "completa" && faltantes.length > 0) comparacion = "parcial";

    const ofertas = Array.isArray(resultado.ofertas) ? resultado.ofertas : [];
    const peor = ofertas.reduce((max, o) => (Number(o.precio) > max ? Number(o.precio) : max), Number(mejor.precio));
    const ahorroUnitario = aClp(venta(peor) - precioUsd);

    const precioClp = aClp(precioUsd);
    const disponible = mejor.stock == null ? false : Number(mejor.stock) > 0;

    lineas.push({
      mpn: resultado.mpn || mpn || null,
      marca: resultado.marca || marca || null,
      nombre: item.nombre || resultado.nombre || "Producto",
      cantidad,
      proveedor: String(mejor.proveedor),
      sku_proveedor: String(mejor.sku),
      precio_unitario_usd: precioUsd,
      precio_unitario_clp: precioClp,
      subtotal_neto_clp: precioClp * cantidad,
      disponible,
      abastecimiento: disponible ? "stock_inmediato" : "por_comprar_importar",
      comparacion,
      ofertas_consideradas: ofertas.length,
      ahorro_vs_peor_clp: ahorroUnitario * cantidad
    });
  }

  const neto = lineas.reduce((suma, l) => suma + l.subtotal_neto_clp, 0);
  const ivaClp = Math.round(neto * iva);
  const ahora = new Date();

  const quote = {
    quote_id: crypto.randomUUID(),
    version: 1,
    moneda: "CLP",
    tipo_cambio_clp_usd: tipoCambio,
    iva_rate: iva,
    lineas,
    neto_clp: neto,
    iva_clp: ivaClp,
    total_clp: neto + ivaClp,
    ahorro_total_clp: lineas.reduce((suma, l) => suma + l.ahorro_vs_peor_clp, 0),
    proveedores_incompletos: [...incompletos],
    created_at: ahora.toISOString(),
    valid_until: new Date(ahora.getTime() + horas * 3600000).toISOString()
  };

  return json({
    estado: "ok",
    quote,
    vars: {
      quote_result: quote,
      quote_id: quote.quote_id,
      quote_version: quote.version,
      quote_total_clp: quote.total_clp,
      quote_valid_until: quote.valid_until
    }
  });
}
```

- [ ] **Step 5: Correr las pruebas y verificar que pasan**

Run: `npx vitest run tests/kapso/generar-cotizacion-v2.test.ts`
Expected: PASS, 9 pruebas.

- [ ] **Step 6: Commit**

```bash
git add docs/kapso/functions-v2/generar-cotizacion-v2.js tests/kapso/generar-cotizacion-v2.test.ts tests/fixtures/mejor-precio-ok.json tests/fixtures/mejor-precio-ambiguo.json
git commit -m "feat(kapso-v2): cotizacion con mejor precio entre los tres mayoristas"
```

---

### Task 3: `emitir-ordenes-compra`

**Files:**
- Create: `docs/kapso/functions-v2/emitir-ordenes-compra.js`
- Test: `tests/kapso/emitir-ordenes-compra.test.ts`

**Interfaces:**
- Consumes: `quote_result` con la forma que produce Task 2; `cargarHandler`, `peticion` de Task 1.
- Produces: variables `purchase_orders_result` (arreglo de `{ proveedor, po_id, status, lineas, total_usd }`), `purchase_orders_count` (entero) y `purchase_orders_ok` (booleano). Ningún nodo aguas abajo las consume: el mensaje de confirmación es texto fijo. Existen para poder diagnosticar una emisión fallida desde el historial de ejecución de Kapso.

- [ ] **Step 1: Escribir las pruebas que fallan**

`tests/kapso/emitir-ordenes-compra.test.ts`:

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarHandler, peticion } from './cargar.js';

const handler = cargarHandler('docs/kapso/functions-v2/emitir-ordenes-compra.js');

// D1 falso: guarda filas en un Map y respeta la primary key, que es de donde
// sale la idempotencia real.
function faseD1() {
  const filas = new Map<string, Record<string, unknown>>();
  const db = {
    prepare(sql: string) {
      return {
        bind(...args: unknown[]) {
          return {
            async run() {
              if (sql.startsWith('CREATE')) return { success: true };
              if (sql.startsWith('INSERT')) {
                const clave = String(args[0]);
                if (filas.has(clave)) throw new Error('UNIQUE constraint failed');
                filas.set(clave, { order_key: clave, po_id: args[1], status: args[4] });
                return { success: true };
              }
              if (sql.startsWith('UPDATE')) {
                const clave = String(args[args.length - 1]);
                const fila = filas.get(clave);
                if (fila) fila.status = sql.includes("'sent'") ? 'sent' : sql.includes("'failed'") ? 'failed' : fila.status;
                return { success: true };
              }
              return { success: true };
            },
            async first() {
              return filas.get(String(args[0])) ?? null;
            },
          };
        },
        async run() { return { success: true }; },
      };
    },
  };
  return { db, filas };
}

const quote = {
  quote_id: 'q-1',
  version: 1,
  lineas: [
    { mpn: 'A-1', marca: 'Epson', nombre: 'Cinta A', cantidad: 2, proveedor: 'ingram', sku_proveedor: 'ING-1', precio_unitario_usd: 11.3, precio_unitario_clp: 10735, subtotal_neto_clp: 21470, disponible: true, abastecimiento: 'stock_inmediato', comparacion: 'completa', ofertas_consideradas: 3, ahorro_vs_peor_clp: 0 },
    { mpn: 'A-2', marca: 'Epson', nombre: 'Cinta B', cantidad: 1, proveedor: 'ingram', sku_proveedor: 'ING-2', precio_unitario_usd: 22.6, precio_unitario_clp: 21470, subtotal_neto_clp: 21470, disponible: true, abastecimiento: 'stock_inmediato', comparacion: 'completa', ofertas_consideradas: 3, ahorro_vs_peor_clp: 0 },
    { mpn: 'B-1', marca: 'HP', nombre: 'Toner', cantidad: 3, proveedor: 'tecnoglobal', sku_proveedor: 'TG-9', precio_unitario_usd: 56.5, precio_unitario_clp: 53675, subtotal_neto_clp: 161025, disponible: false, abastecimiento: 'por_comprar_importar', comparacion: 'completa', ofertas_consideradas: 2, ahorro_vs_peor_clp: 0 },
  ],
  neto_clp: 203965,
  iva_clp: 38753,
  total_clp: 242718,
  proveedores_incompletos: [],
};

// Cada llamada a env() estrena una base: la idempotencia se prueba compartiendo
// el MISMO entorno entre dos invocaciones, no reusandolo por accidente.
const env = () => ({
  MARGEN: '0.13',
  RESEND_API_KEY: 'key',
  RESEND_FROM_EMAIL: 'ordenes@rr.cl',
  OC_EMAIL_DESTINO: 'pyxis.latam@gmail.com',
  DB: faseD1().db,
});

function vars(extra: Record<string, unknown> = {}) {
  return { quote_result: quote, quote_confirmed: true, quote_customer_name: 'Vicente', billing_rut: '21088369-K', billing_razon_social: 'Acme SpA', billing_email: 'v@acme.cl', ...extra };
}

function resendOk() {
  const spy = vi.fn(async () => new Response(JSON.stringify({ id: 'email-1' }), { status: 200 }));
  vi.stubGlobal('fetch', spy);
  return spy;
}

afterEach(() => vi.unstubAllGlobals());

describe('emitir-ordenes-compra', () => {
  it('emite una orden por mayorista', async () => {
    const spy = resendOk();
    const res = await handler(peticion({ execution_context: { vars: vars() } }), env());
    const datos = await res.json();
    expect(datos.ok).toBe(true);
    expect(datos.vars.purchase_orders_count).toBe(2);
    expect(spy).toHaveBeenCalledTimes(2);
    const proveedores = datos.vars.purchase_orders_result.map((o: { proveedor: string }) => o.proveedor).sort();
    expect(proveedores).toEqual(['ingram', 'tecnoglobal']);
  });

  it('agrupa las lineas del mismo mayorista en una sola orden', async () => {
    resendOk();
    const res = await handler(peticion({ execution_context: { vars: vars() } }), env());
    const datos = await res.json();
    const ingram = datos.vars.purchase_orders_result.find((o: { proveedor: string }) => o.proveedor === 'ingram');
    expect(ingram.lineas).toBe(2);
  });

  it('reconstruye el costo dividiendo por el margen', async () => {
    const spy = resendOk();
    await handler(peticion({ execution_context: { vars: vars() } }), env());
    const cuerpo = JSON.parse(String((spy.mock.calls[0][1] as RequestInit).body));
    // 11.3 / 1.13 = 10.00
    expect(cuerpo.text).toContain('10');
    expect(cuerpo.text).not.toContain('11.3');
  });

  it('usa el sku del proveedor que gana, no el de Intcomex', async () => {
    const spy = resendOk();
    await handler(peticion({ execution_context: { vars: vars() } }), env());
    const cuerpos = spy.mock.calls.map((c) => String((c[1] as RequestInit).body));
    expect(cuerpos.some((c) => c.includes('ING-1') && c.includes('ING-2'))).toBe(true);
    expect(cuerpos.some((c) => c.includes('TG-9'))).toBe(true);
  });

  it('la segunda ejecucion no reenvia correos', async () => {
    const spy = resendOk();
    const entorno = env();
    await handler(peticion({ execution_context: { vars: vars() } }), entorno);
    expect(spy).toHaveBeenCalledTimes(2);
    const res = await handler(peticion({ execution_context: { vars: vars() } }), entorno);
    const datos = await res.json();
    expect(spy).toHaveBeenCalledTimes(2);
    expect(datos.vars.purchase_orders_result.every((o: { status: string }) => o.status === 'duplicate')).toBe(true);
  });

  it('un correo caido no impide el otro', async () => {
    let llamada = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      llamada += 1;
      return llamada === 1
        ? new Response(JSON.stringify({ message: 'rate limited' }), { status: 429 })
        : new Response(JSON.stringify({ id: 'email-2' }), { status: 200 });
    }));
    const res = await handler(peticion({ execution_context: { vars: vars() } }), env());
    const datos = await res.json();
    expect(datos.vars.purchase_orders_ok).toBe(false);
    const estados = datos.vars.purchase_orders_result.map((o: { status: string }) => o.status).sort();
    expect(estados).toEqual(['failed', 'sent']);
  });

  it('no emite sin confirmacion del cliente', async () => {
    resendOk();
    const res = await handler(peticion({ execution_context: { vars: vars({ quote_confirmed: false }) } }), env());
    expect(res.status).toBe(400);
  });

  it('no emite sin cotizacion', async () => {
    resendOk();
    const res = await handler(peticion({ execution_context: { vars: { quote_confirmed: true } } }), env());
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Correr las pruebas y verificar que fallan**

Run: `npx vitest run tests/kapso/emitir-ordenes-compra.test.ts`
Expected: FAIL — el archivo de la function no existe.

- [ ] **Step 3: Escribir la function**

`docs/kapso/functions-v2/emitir-ordenes-compra.js`:

```js
const DESTINO_DEFAULT = "pyxis.latam@gmail.com";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function escapar(valor) {
  return String(valor)
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#039;");
}

async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const quote = vars.quote_result?.quote || vars.quote_result || null;

  if (vars.quote_confirmed !== true) return json({ ok: false, error: "El cliente no ha confirmado la orden." }, 400);
  if (!quote || !Array.isArray(quote.lineas) || quote.lineas.length === 0 || !quote.quote_id) {
    return json({ ok: false, error: "Falta la cotización estructurada." }, 400);
  }

  const margen = Number(env.MARGEN ?? "0.13");
  const apiKey = env.RESEND_API_KEY;
  const from = env.RESEND_FROM_EMAIL;
  const destino = String(env.OC_EMAIL_DESTINO || DESTINO_DEFAULT);

  if (!Number.isFinite(margen) || margen < 0) return json({ ok: false, error: "Margen mal configurado." }, 500);
  if (!apiKey || !from) return json({ ok: false, error: "Faltan RESEND_API_KEY o RESEND_FROM_EMAIL." }, 500);
  if (!env.DB) return json({ ok: false, error: "Falta la base D1 para idempotencia." }, 500);

  await env.DB.prepare(
    "CREATE TABLE IF NOT EXISTS purchase_orders (order_key TEXT PRIMARY KEY, po_id TEXT, quote_id TEXT, quote_version TEXT, proveedor TEXT, status TEXT, email_id TEXT, error TEXT, created_at TEXT, updated_at TEXT)"
  ).run();

  const version = String(quote.version ?? vars.quote_version ?? "1");
  const cliente = String(vars.quote_customer_name || "No informado");
  const rut = String(vars.billing_rut || "No informado");
  const razon = String(vars.billing_razon_social || "No informado");
  const email = String(vars.billing_email || "No informado");
  const incompletos = Array.isArray(quote.proveedores_incompletos) ? quote.proveedores_incompletos : [];

  // Una orden por mayorista: el group by es sobre el ganador que quedo
  // congelado en la cotizacion, no sobre una consulta nueva de precios.
  const grupos = new Map();
  for (const linea of quote.lineas) {
    const proveedor = String(linea.proveedor || "desconocido");
    if (!grupos.has(proveedor)) grupos.set(proveedor, []);
    grupos.get(proveedor).push(linea);
  }

  const resultados = [];

  for (const [proveedor, lineas] of grupos) {
    const orderKey = `${quote.quote_id}:${version}:${proveedor}`;
    const poId = `oc-${orderKey.replace(/[^a-zA-Z0-9_-]/g, "-")}`;
    const ahora = new Date().toISOString();

    let duplicada = false;
    try {
      await env.DB.prepare(
        "INSERT INTO purchase_orders (order_key, po_id, quote_id, quote_version, proveedor, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'processing', ?, ?)"
      ).bind(orderKey, poId, String(quote.quote_id), version, proveedor, ahora, ahora).run();
    } catch (_) {
      const existente = await env.DB.prepare("SELECT po_id, status FROM purchase_orders WHERE order_key = ? LIMIT 1").bind(orderKey).first();
      if (existente && existente.status !== "failed") {
        resultados.push({ proveedor, po_id: String(existente.po_id || poId), status: "duplicate", lineas: lineas.length, total_usd: null });
        duplicada = true;
      } else {
        await env.DB.prepare("UPDATE purchase_orders SET status = 'processing', error = NULL, updated_at = ? WHERE order_key = ?").bind(ahora, orderKey).run();
      }
    }
    if (duplicada) continue;

    const detalle = lineas.map((linea) => {
      const costoUnitario = Math.round((Number(linea.precio_unitario_usd) / (1 + margen)) * 100) / 100;
      return { ...linea, costo_unitario_usd: costoUnitario, costo_total_usd: Math.round(costoUnitario * Number(linea.cantidad) * 100) / 100 };
    });
    const totalUsd = Math.round(detalle.reduce((suma, l) => suma + l.costo_total_usd, 0) * 100) / 100;

    const filas = detalle.map((l) =>
      `<tr><td>${escapar(l.sku_proveedor)}</td><td>${escapar(l.mpn || "-")}</td><td>${escapar(l.nombre)}</td><td>${escapar(l.cantidad)}</td><td>US$ ${escapar(l.costo_unitario_usd)}</td><td>US$ ${escapar(l.costo_total_usd)}</td><td>${escapar(l.abastecimiento)}</td></tr>`
    ).join("");

    const aviso = incompletos.length > 0
      ? `<p><b>Ojo:</b> al cotizar no respondieron ${escapar(incompletos.join(", "))}. El precio ganador lo es solo entre los que sí respondieron.</p>`
      : "";

    const html = `<h2>Orden de compra ${escapar(poId)}</h2>`
      + `<p><b>Mayorista:</b> ${escapar(proveedor.toUpperCase())}<br><b>Cotización:</b> ${escapar(quote.quote_id)} v${escapar(version)}</p>`
      + `<table border="1" cellpadding="4" cellspacing="0"><tr><th>SKU ${escapar(proveedor)}</th><th>MPN</th><th>Producto</th><th>Cant.</th><th>Costo unit.</th><th>Costo total</th><th>Abastecimiento</th></tr>${filas}</table>`
      + `<p><b>Total de esta orden:</b> US$ ${escapar(totalUsd)}</p>`
      + `<h3>Cliente</h3><p>${escapar(cliente)}<br>RUT: ${escapar(rut)}<br>Razón social: ${escapar(razon)}<br>Email: ${escapar(email)}</p>`
      + `<p>Pago del cliente: contado.</p>${aviso}`;

    const texto = [
      `Orden de compra ${poId}`,
      `Mayorista: ${proveedor.toUpperCase()}`,
      `Cotización: ${quote.quote_id} v${version}`,
      ...detalle.map((l) => `${l.sku_proveedor} | ${l.mpn || "-"} | ${l.nombre} | ${l.cantidad} x US$ ${l.costo_unitario_usd} = US$ ${l.costo_total_usd}`),
      `Total: US$ ${totalUsd}`,
      `Cliente: ${cliente} | RUT ${rut} | ${razon} | ${email}`,
      "Pago del cliente: contado."
    ].join("\n");

    const respuesta = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify({
        from,
        to: [destino],
        subject: `OC ${poId} · ${proveedor.toUpperCase()} · cotización ${quote.quote_id}`,
        html,
        text: texto
      })
    });
    const cuerpo = await respuesta.json().catch(() => ({}));

    if (!respuesta.ok) {
      await env.DB.prepare("UPDATE purchase_orders SET status = 'failed', error = ?, updated_at = ? WHERE order_key = ?")
        .bind(String(cuerpo?.message || "No se pudo enviar la orden."), new Date().toISOString(), orderKey).run();
      resultados.push({ proveedor, po_id: poId, status: "failed", lineas: lineas.length, total_usd: totalUsd });
      continue;
    }

    await env.DB.prepare("UPDATE purchase_orders SET status = 'sent', email_id = ?, error = NULL, updated_at = ? WHERE order_key = ?")
      .bind(cuerpo.id || null, new Date().toISOString(), orderKey).run();
    resultados.push({ proveedor, po_id: poId, status: "sent", lineas: lineas.length, total_usd: totalUsd });
  }

  const todasOk = resultados.every((r) => r.status === "sent" || r.status === "duplicate");

  return json({
    ok: true,
    ordenes: resultados,
    vars: {
      purchase_orders_result: resultados,
      purchase_orders_count: resultados.length,
      purchase_orders_ok: todasOk
    }
  });
}
```

- [ ] **Step 4: Correr las pruebas y verificar que pasan**

Run: `npx vitest run tests/kapso/emitir-ordenes-compra.test.ts`
Expected: PASS, 8 pruebas.

- [ ] **Step 5: Commit**

```bash
git add docs/kapso/functions-v2/emitir-ordenes-compra.js tests/kapso/emitir-ordenes-compra.test.ts
git commit -m "feat(kapso-v2): emision de una orden de compra por mayorista"
```

---

### Task 4: Las tres functions de ruteo

**Files:**
- Create: `docs/kapso/functions-v2/route-quote-decision-v2.js`
- Create: `docs/kapso/functions-v2/check-quote-validity-v2.js`
- Create: `docs/kapso/functions-v2/route-rut-v2.js`
- Test: `tests/kapso/routers-v2.test.ts`

**Interfaces:**
- Consumes: `cargarHandler`, `peticion` de Task 1.
- Produces: tres handlers que devuelven `{ next_edge }`. Las etiquetas son `accepted`/`rejected`, `valid`/`expired` y `valid`/`invalid` respectivamente. Task 7 las usa como `conditions` de los nodos `decide`.

**Nota sobre `route-rut-v2`:** el `route-rut` de v1 devuelve `valid` salvo que `factura === true` *y* `rut_valid !== true`. En v2 nunca se setea `factura`, así que reutilizarlo dejaría pasar cualquier RUT inválido. Por eso hay una versión nueva que rutea solo por `rut_valid`.

- [ ] **Step 1: Escribir las pruebas que fallan**

`tests/kapso/routers-v2.test.ts`:

```ts
import { describe, expect, it } from 'vitest';
import { cargarHandler, peticion } from './cargar.js';

const decision = cargarHandler('docs/kapso/functions-v2/route-quote-decision-v2.js');
const validez = cargarHandler('docs/kapso/functions-v2/check-quote-validity-v2.js');
const rut = cargarHandler('docs/kapso/functions-v2/route-rut-v2.js');

async function rutear(handler: ReturnType<typeof cargarHandler>, vars: unknown, edges: string[]) {
  const res = await handler(peticion({ execution_context: { vars }, available_edges: edges }), {});
  return (await res.json()) as { next_edge: string };
}

describe('route-quote-decision-v2', () => {
  it('rutea accepted', async () => {
    expect((await rutear(decision, { quote_decision: 'accepted' }, ['accepted', 'rejected'])).next_edge).toBe('accepted');
  });

  it('rutea rejected', async () => {
    expect((await rutear(decision, { quote_decision: 'rejected' }, ['accepted', 'rejected'])).next_edge).toBe('rejected');
  });

  it('ante un valor desconocido cae en rejected, que es lo reversible', async () => {
    expect((await rutear(decision, { quote_decision: 'pending' }, ['accepted', 'rejected'])).next_edge).toBe('rejected');
    expect((await rutear(decision, {}, ['accepted', 'rejected'])).next_edge).toBe('rejected');
  });
});

describe('check-quote-validity-v2', () => {
  it('vigente si valid_until esta en el futuro', async () => {
    const futuro = new Date(Date.now() + 3600000).toISOString();
    expect((await rutear(validez, { quote_result: { valid_until: futuro } }, ['valid', 'expired'])).next_edge).toBe('valid');
  });

  it('expirada si valid_until ya paso', async () => {
    const pasado = new Date(Date.now() - 1000).toISOString();
    expect((await rutear(validez, { quote_result: { valid_until: pasado } }, ['valid', 'expired'])).next_edge).toBe('expired');
  });

  it('expirada si no hay fecha: no se emite a ciegas', async () => {
    expect((await rutear(validez, {}, ['valid', 'expired'])).next_edge).toBe('expired');
  });
});

describe('route-rut-v2', () => {
  it('valid solo con rut_valid true', async () => {
    expect((await rutear(rut, { rut_valid: true }, ['valid', 'invalid'])).next_edge).toBe('valid');
  });

  it('invalid cuando el rut no paso la validacion', async () => {
    expect((await rutear(rut, { rut_valid: false }, ['valid', 'invalid'])).next_edge).toBe('invalid');
  });

  it('invalid cuando no hay dato, a diferencia del route-rut de v1', async () => {
    expect((await rutear(rut, {}, ['valid', 'invalid'])).next_edge).toBe('invalid');
  });
});
```

- [ ] **Step 2: Correr las pruebas y verificar que fallan**

Run: `npx vitest run tests/kapso/routers-v2.test.ts`
Expected: FAIL — los archivos no existen.

- [ ] **Step 3: Escribir las tres functions**

`docs/kapso/functions-v2/route-quote-decision-v2.js`:

```js
async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const disponibles = body.available_edges || [];
  // Cualquier valor que no sea un si explicito rutea a rejected: volver a
  // descubrimiento se deshace, emitir ordenes de compra no.
  const decision = String(vars.quote_decision) === "accepted" ? "accepted" : "rejected";
  const next = disponibles.includes(decision) ? decision : disponibles[0] || decision;
  return new Response(JSON.stringify({ next_edge: next }), { headers: { "Content-Type": "application/json" } });
}
```

`docs/kapso/functions-v2/check-quote-validity-v2.js`:

```js
async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const disponibles = body.available_edges || [];
  const crudo = vars.quote_result?.quote?.valid_until || vars.quote_result?.valid_until || vars.quote_valid_until || "";
  const instante = Date.parse(String(crudo));
  const expirada = !Number.isFinite(instante) || Date.now() >= instante;
  const deseado = expirada ? "expired" : "valid";
  const next = disponibles.includes(deseado) ? deseado : disponibles[0] || deseado;
  return new Response(JSON.stringify({ next_edge: next, vars: { quote_expired: expirada } }), { headers: { "Content-Type": "application/json" } });
}
```

`docs/kapso/functions-v2/route-rut-v2.js`:

```js
async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const disponibles = body.available_edges || [];
  // A diferencia de route-rut de v1, aca no hay bandera `factura`: en v2 los
  // datos tributarios se piden siempre, asi que un RUT sin validar es invalido.
  const deseado = vars.rut_valid === true ? "valid" : "invalid";
  const next = disponibles.includes(deseado) ? deseado : disponibles[0] || deseado;
  return new Response(JSON.stringify({ next_edge: next }), { headers: { "Content-Type": "application/json" } });
}
```

- [ ] **Step 4: Correr las pruebas y verificar que pasan**

Run: `npx vitest run tests/kapso/routers-v2.test.ts`
Expected: PASS, 9 pruebas.

- [ ] **Step 5: Commit**

```bash
git add docs/kapso/functions-v2/route-quote-decision-v2.js docs/kapso/functions-v2/check-quote-validity-v2.js docs/kapso/functions-v2/route-rut-v2.js tests/kapso/routers-v2.test.ts
git commit -m "feat(kapso-v2): functions de ruteo con RUT estricto"
```

---

### Task 5: Los cuatro prompts

**Files:**
- Create: `docs/kapso/prompts-v2/README.md`
- Create: `docs/kapso/prompts-v2/agente-descubrimiento/v-01.md`
- Create: `docs/kapso/prompts-v2/agente-presentacion/v-01.md`
- Create: `docs/kapso/prompts-v2/agente-facturacion/v-01.md`
- Create: `docs/kapso/prompts-v2/agente-cierre/v-01.md`
- Modify: `tests/prompts.test.ts:9` (la constante `RAIZ`)

**Interfaces:**
- Consumes: los nombres de variables que producen las tareas 2 y 3.
- Produces: cuatro archivos con el texto desplegable entre `<!-- PROMPT:INICIO -->` y `<!-- PROMPT:FIN -->`. Task 7 lee **solo ese bloque** para el `system_prompt` de cada agente.

- [ ] **Step 1: Parametrizar el test de prompts sobre las dos raíces**

En `tests/prompts.test.ts`, reemplazar la constante y el cálculo de agentes:

```ts
const RAICES = ['docs/kapso/prompts', 'docs/kapso/prompts-v2'];

const AGENTES = RAICES.flatMap((raiz) =>
  readdirSync(raiz, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `${raiz}/${e.name}`)
);
```

Y ajustar `versionesDe` y el test del README para que reciban la ruta completa del agente:

```ts
function versionesDe(agente: string): Version[] {
  return readdirSync(agente)
    .filter((n) => /^v-\d+\.md$/.test(n))
    .map((archivo) => ({
      archivo: `${agente}/${archivo}`,
      contenido: readFileSync(`${agente}/${archivo}`, 'utf8'),
    }));
}
```

```ts
it('el README indexa cada directorio de agente', () => {
  for (const agente of AGENTES) {
    const raiz = agente.slice(0, agente.lastIndexOf('/'));
    const nombre = agente.slice(agente.lastIndexOf('/') + 1);
    const readme = readFileSync(`${raiz}/README.md`, 'utf8');
    expect(readme, `falta ${nombre} en el indice de ${raiz}`).toContain(`${nombre}/`);
  }
});
```

- [ ] **Step 2: Correr el test y verificar que falla**

Run: `npx vitest run tests/prompts.test.ts`
Expected: FAIL — `ENOENT: docs/kapso/prompts-v2`

- [ ] **Step 3: Escribir el README del directorio**

`docs/kapso/prompts-v2/README.md`:

```markdown
# Prompts de los agentes — workflow `rr-isia-version2`

Un directorio por nodo `agent`, una versión por archivo. El texto que se
despliega vive entre `<!-- PROMPT:INICIO -->` y `<!-- PROMPT:FIN -->`; todo lo
demás es documentación para nosotros. `scripts/kapso-workflow-v2.ts` sube
**solo ese bloque** — el error de v1, donde se pegó el archivo entero, no se
repite.

**Diseño:** [`../../superpowers/specs/2026-08-26-rr-isia-version2-design.md`](../../superpowers/specs/2026-08-26-rr-isia-version2-design.md)

## Índice

| Directorio | Nodo | Responsabilidad | Vigente |
|---|---|---|---|
| [`agente-descubrimiento/`](agente-descubrimiento/) | `agente_descubrimiento` | Entiende la necesidad, busca y arma el carro | v-01 |
| [`agente-presentacion/`](agente-presentacion/) | `agente_presentacion` | Presenta la cotización y captura la decisión | v-01 |
| [`agente-facturacion/`](agente-facturacion/) | `agente_facturacion` | RUT y datos tributarios, en bloque | v-01 |
| [`agente-cierre/`](agente-cierre/) | `agente_cierre` | Confirmación final antes de emitir las órdenes | v-01 |

## Qué cambia respecto de v1

- No hay nodo de recuperación de rechazo: `rejected` vuelve a descubrimiento.
- No hay método de pago: siempre contado.
- El carro debe llevar `mpn` y `marca`, no solo `sku`. Sin MPN no hay comparación entre mayoristas.
- Ningún agente puede nombrar al mayorista frente al cliente.
```

- [ ] **Step 4: Escribir el prompt de descubrimiento**

`docs/kapso/prompts-v2/agente-descubrimiento/v-01.md`:

````markdown
# Descubrimiento de productos — v-01

| | |
|---|---|
| **Nodo Kapso** | `agente_descubrimiento` |
| **Estado** | vigente |
| **Fecha** | 2026-08-26 |
| **Lee** | `cart_items` |
| **Escribe** | `cart_items` |
| **Tools** | `buscar_productos`, `save_variable`, `complete_task`, `handoff_to_human` |
| **Siguiente nodo** | `fn_cotizar` |

## Qué cambió

Respecto de `agent_n1` de v1: el carro ahora guarda `mpn` y `marca` además del
`sku`, porque `generar-cotizacion-v2` compara por MPN entre los tres mayoristas.
Un ítem sin MPN se cotiza contra Intcomex solamente. Se saca `detalle_producto`:
no aportaba nada que la búsqueda no trajera.

<!-- PROMPT:INICIO -->
Eres el ejecutivo de Ricardo Rodríguez y Cía. atendiendo por WhatsApp. Español
chileno, mensajes cortos, tuteo, cero relleno.

## Tu trabajo

Entender qué necesita el cliente y dejar armado el carro. Cuando el carro esté
listo y confirmado, llama a `complete_task`.

## Reglas de conversación

1. No anuncies lo que vas a hacer ("déjame buscar"): hazlo y muestra el
   resultado.
2. No pidas permiso para mostrar opciones.
3. En descubrimiento pregunta de a **una** cosa: cada respuesta cambia la
   siguiente pregunta.
4. Prefiere preguntas cerradas con dos o tres alternativas.
5. Nunca inventes precios, modelos ni disponibilidad. Si no lo devolvió una
   herramienta, no existe.

## Búsqueda

- En `q` van pocas palabras clave del producto ("notebook 14"), no la frase
  completa del cliente. La marca va en `marca`, no repetida en `q`.
- Muestra 3 o 4 productos por mensaje como máximo, con nombre y precio.
- Si el estado es `demasiado_amplio`, no muestres productos: usa
  `opciones.marcas` y `opciones.categorias` para hacer **una** pregunta concreta
  y vuelve a buscar con el filtro. Usa los valores tal cual vienen ("HP", no
  "Hewlett-Packard").
- Si el estado es `no_disponible` o `error`, dile que hay un problema temporal y
  ofrece seguir en unos minutos. No inventes un catálogo.
- Nunca repitas la misma búsqueda con otras palabras esperando otro resultado.
  Si vuelve vacía, habla con el cliente.
- Los precios que recibes ya son precio final de venta, en dólares. Entrégalos
  tal cual.
- El presupuesto va siempre en dólares. Si el cliente habla en pesos, pregúntale
  a cuánto equivale en dólares. No adivines el tipo de cambio.

## El carro

Guarda `cart_items` con `save_variable`. Es una lista, y cada ítem lleva
exactamente estos campos:

```json
[{ "sku": "AR155EPS14", "mpn": "ERC-38B", "marca": "Epson", "nombre": "Cinta Epson ERC-38B", "cantidad": 2 }]
```

El `mpn` y la `marca` vienen en la respuesta de `buscar_productos`. **Cópialos
siempre**: sin ellos no se puede buscar el mejor precio entre mayoristas y el
cliente termina pagando de más.

Antes de terminar, repite el carro en una línea por producto y pide
confirmación. Con el sí, llama a `complete_task`.

## Prohibido

- Mencionar mayoristas, proveedores, distribuidores o de dónde sale el producto.
  Si preguntan, es "nuestro stock".
- Hablar de costos, márgenes o cuánto nos cuesta a nosotros. No lo sabes.
- Prometer plazos de entrega. Eso lo confirma el equipo comercial.

Si el cliente se enoja, pide hablar con una persona, o pregunta algo que no
puedes responder, llama a `handoff_to_human`.
<!-- PROMPT:FIN -->
````

- [ ] **Step 5: Escribir el prompt de presentación**

`docs/kapso/prompts-v2/agente-presentacion/v-01.md`:

````markdown
# Presentación de la cotización — v-01

| | |
|---|---|
| **Nodo Kapso** | `agente_presentacion` |
| **Estado** | vigente |
| **Fecha** | 2026-08-26 |
| **Lee** | `quote_result` |
| **Escribe** | `quote_decision` |
| **Tools** | `save_variable`, `complete_task`, `handoff_to_human` |
| **Siguiente nodo** | `route_decision` |

## Qué cambió

Respecto de `agent_n3` de v1: desaparece `rejection_reason`, porque v2 no tiene
nodo de recuperación de rechazo. Un `rejected` vuelve directo a descubrimiento,
así que basta con la decisión.

<!-- PROMPT:INICIO -->
Eres el ejecutivo de Ricardo Rodríguez y Cía. por WhatsApp. Español chileno,
mensajes cortos.

## Tu trabajo

Mostrar la cotización que está en `quote_result` y capturar la decisión del
cliente. Nada más.

## El mensaje

Un solo mensaje con la cotización, y una sola pregunta de cierre. Formato:

```
Te dejo la cotización:

• 2 × Cinta Epson ERC-38B — $23.618
• 3 × Toner HP 26A — $161.025

Neto: $184.643
IVA: $35.082
Total: $219.725

Precios en pesos, válidos por 3 horas. ¿La tomamos?
```

Usa exactamente los montos de `quote_result`: `subtotal_neto_clp` por línea, y
`neto_clp`, `iva_clp`, `total_clp` al final. No recalcules nada.

Si alguna línea tiene `abastecimiento: "por_comprar_importar"`, avisa en una
línea que ese producto no es entrega inmediata.

Si `ahorro_total_clp` es mayor que cero puedes decir que buscaste el mejor
precio disponible. **Sin nombrar mayoristas y sin decir contra qué se compara.**

## La decisión

- Acepta ("sí", "dale", "tomémosla") → `save_variable` con
  `quote_decision: "accepted"` y `complete_task`.
- Rechaza, o pide cambios de productos, cantidades o precio → `quote_decision:
  "rejected"` y `complete_task`. Dile que vuelves a armar el pedido; no negocies
  aquí.
- Duda o responde algo ambiguo → **una** pregunta aclaratoria, y con la
  respuesta decides. Si sigue sin quedar claro, es `rejected`.

## Prohibido

- Renegociar precios, ofrecer descuentos o cambiar cantidades. Este nodo
  presenta y registra, no ajusta.
- Nombrar mayoristas o hablar de costos.
- Inventar montos que no estén en `quote_result`.

Si pide hablar con una persona, `handoff_to_human`.
<!-- PROMPT:FIN -->
````

- [ ] **Step 6: Escribir el prompt de facturación**

`docs/kapso/prompts-v2/agente-facturacion/v-01.md`:

````markdown
# Datos de facturación — v-01

| | |
|---|---|
| **Nodo Kapso** | `agente_facturacion` |
| **Estado** | vigente |
| **Fecha** | 2026-08-26 |
| **Lee** | `quote_result`, `rut_valid` |
| **Escribe** | `billing_rut`, `billing_razon_social`, `billing_giro`, `billing_direccion`, `billing_comuna`, `billing_ciudad`, `billing_email` |
| **Tools** | `save_variable`, `complete_task`, `handoff_to_human` |
| **Siguiente nodo** | `fn_validar_rut` |

## Qué cambió

Respecto de `agent_n5` de v1: se elimina toda la parte de método de pago. En v2
el pago es contado y no se pregunta. Se conserva la captura en bloque y la
reentrada por RUT inválido.

<!-- PROMPT:INICIO -->
Eres el ejecutivo de Ricardo Rodríguez y Cía. por WhatsApp. El cliente ya aceptó
la cotización.

## Tu trabajo

Capturar los datos de facturación. Son campos fijos e independientes, así que se
piden **todos juntos en un mensaje**, no de a uno.

## El mensaje

```
Perfecto. Para emitir la factura necesito estos datos:

1. RUT
2. Razón social
3. Giro
4. Dirección
5. Comuna
6. Ciudad
7. Email para enviar la factura

Puedes mandarlos todos en un mensaje.
```

Guarda cada campo con `save_variable`: `billing_rut`, `billing_razon_social`,
`billing_giro`, `billing_direccion`, `billing_comuna`, `billing_ciudad`,
`billing_email`.

El RUT guárdalo tal como lo escribió el cliente; ya hay una validación
determinista aguas abajo.

Si faltan campos, pide **solo los que faltan**, en un mensaje.

Cuando tengas los siete, `complete_task`.

## Si vuelves a este nodo

Significa que el RUT no pasó la validación. Pide **solo el RUT**, no repitas los
otros seis campos: ya los tienes. Di algo como "Ese RUT no me cuadra, ¿me lo
confirmas?" y con el nuevo valor haz `save_variable` de `billing_rut` y
`complete_task`.

Si el cliente insiste con el mismo RUT dos veces, `handoff_to_human`.

## Prohibido

- Preguntar por forma de pago, plazos o crédito. El pago es contado y ya está
  definido.
- Nombrar mayoristas o hablar de costos.
- Prometer fecha de emisión de la factura.
<!-- PROMPT:FIN -->
````

- [ ] **Step 7: Escribir el prompt de cierre**

`docs/kapso/prompts-v2/agente-cierre/v-01.md`:

````markdown
# Cierre y confirmación — v-01

| | |
|---|---|
| **Nodo Kapso** | `agente_cierre` |
| **Estado** | vigente |
| **Fecha** | 2026-08-26 |
| **Lee** | `quote_result`, `billing_*` |
| **Escribe** | `quote_summary`, `quote_customer_name`, `quote_customer_phone`, `quote_confirmed` |
| **Tools** | `save_variable`, `get_whatsapp_context`, `complete_task`, `handoff_to_human` |
| **Siguiente nodo** | `fn_emitir_ordenes` |

## Qué cambió

Nodo nuevo en su posición: en v1 el correo salía **antes** del cierre, así que
la confirmación del cliente llegaba tarde. Acá la confirmación es previa a
cualquier emisión, y `quote_confirmed` es la llave: sin ella
`emitir-ordenes-compra` responde 400 y no emite nada.

<!-- PROMPT:INICIO -->
Eres el ejecutivo de Ricardo Rodríguez y Cía. por WhatsApp. Es el último paso
antes de cursar el pedido.

## Tu trabajo

Mostrar el resumen final y obtener una confirmación explícita. Este es el último
punto en que algo se puede deshacer.

## El mensaje

Usa `get_whatsapp_context` para el nombre y el teléfono del cliente, y guárdalos
con `save_variable` en `quote_customer_name` y `quote_customer_phone`.

Un solo mensaje, corto:

```
Antes de cursarlo:

3 productos — total $219.725
A nombre de: Acme SpA, 21.088.369-K
Despacho: Ñuñoa, Santiago
Factura a: contacto@acme.cl
Pago: contado

¿Lo curso así?
```

No repitas el detalle producto por producto: el cliente ya lo vio y ya lo
aceptó. Repetirlo invita a reabrir la negociación.

Guarda ese texto en `quote_summary`.

## La confirmación

- **Sí inequívoco** ("sí", "dale", "cúrsalo") → `save_variable` con
  `quote_confirmed: true` y después `complete_task`.
- **Cualquier otra cosa** —dudas, "espera", correcciones de datos, silencio
  ambiguo— → **no** escribas `quote_confirmed`. Resuelve lo que falte. Si el
  cliente quiere cambiar productos o cantidades, dile que no se puede modificar
  en este punto y llama a `handoff_to_human`.

`quote_confirmed: true` con cualquier cosa que no sea un sí claro es el peor
error posible en este nodo: dispara órdenes de compra reales.

## Prohibido

- Nombrar mayoristas, costos o márgenes.
- Prometer plazos de entrega o de despacho.
- Modificar el carro o los precios.
<!-- PROMPT:FIN -->
````

- [ ] **Step 8: Correr el test de prompts y verificar que pasa**

Run: `npx vitest run tests/prompts.test.ts`
Expected: PASS — cubre los seis agentes de v1 y los cuatro de v2.

- [ ] **Step 9: Commit**

```bash
git add docs/kapso/prompts-v2 tests/prompts.test.ts
git commit -m "feat(kapso-v2): prompts de los cuatro agentes"
```

---

### Task 6: Despliegue de las functions

**Files:**
- Create: `scripts/kapso.ts`
- Create: `scripts/kapso-functions.ts`
- Modify: `package.json` (sección `scripts`)

**Interfaces:**
- Consumes: los seis archivos `.js` de `docs/kapso/functions-v2/`.
- Produces: `kapso(ruta, opciones)` desde `scripts/kapso.ts`, que Task 7 reutiliza. Deja las seis functions creadas y desplegadas en Kapso, e imprime un mapa `nombre → function_id` que Task 7 necesita.

- [ ] **Step 1: Escribir el cliente de la Platform API**

`scripts/kapso.ts`:

```ts
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
```

- [ ] **Step 2: Escribir el script de despliegue**

`scripts/kapso-functions.ts`:

```ts
import { readFileSync } from 'node:fs';
import { kapso } from './kapso.js';

interface Funcion { id: string; name: string; }

// Las functions de v2 y los secretos que necesita cada una. El margen de 13%
// vive aqui: las de v1 siguen en 0.30 y no se tocan.
const FUNCIONES = [
  { nombre: 'buscar-productos-v2', secretos: ['API_PRECIOS_KEY', 'MARGEN'] },
  { nombre: 'generar-cotizacion-v2', secretos: ['API_PRECIOS_KEY', 'MARGEN', 'TIPO_CAMBIO_CLP_USD', 'IVA_RATE', 'COTIZACION_VALID_HOURS'] },
  { nombre: 'emitir-ordenes-compra', secretos: ['MARGEN', 'RESEND_API_KEY', 'RESEND_FROM_EMAIL', 'OC_EMAIL_DESTINO'] },
  { nombre: 'route-quote-decision-v2', secretos: [] },
  { nombre: 'check-quote-validity-v2', secretos: [] },
  { nombre: 'route-rut-v2', secretos: [] },
] as const;

const VALORES: Record<string, string> = {
  API_PRECIOS_KEY: process.env.API_SECRET_KEY ?? '',
  MARGEN: '0.13',
  TIPO_CAMBIO_CLP_USD: process.env.TIPO_CAMBIO_CLP_USD ?? '950',
  IVA_RATE: '0.19',
  COTIZACION_VALID_HOURS: '3',
  RESEND_API_KEY: process.env.RESEND_API_KEY ?? '',
  RESEND_FROM_EMAIL: process.env.RESEND_FROM_EMAIL ?? '',
  OC_EMAIL_DESTINO: process.env.OC_EMAIL_DESTINO ?? 'pyxis.latam@gmail.com',
};

async function main() {
  const { data: existentes } = await kapso<{ data: Funcion[] }>('/functions');
  const ids: Record<string, string> = {};
  const pendientes: string[] = [];

  for (const { nombre, secretos } of FUNCIONES) {
    const codigo = readFileSync(`docs/kapso/functions-v2/${nombre}.js`, 'utf8');
    const previa = existentes.find((f) => f.name === nombre);

    let id: string;
    if (previa) {
      await kapso(`/functions/${previa.id}`, { metodo: 'PATCH', cuerpo: { function: { code: codigo } } });
      id = previa.id;
      console.log(`actualizada  ${nombre}`);
    } else {
      const { data } = await kapso<{ data: Funcion }>('/functions', {
        metodo: 'POST',
        // El slug lleva espacio de nombres propio: la function v1 `buscar-productos`
        // tiene slug `buscar-productos-v2`, y Kapso exige slugs unicos.
        cuerpo: { function: { name: nombre, slug: `isia-v2-${nombre.replace(/-v2$/, '')}`, code: codigo, function_type: 'cloudflare_worker' } },
      });
      id = data.id;
      console.log(`creada       ${nombre}`);
    }

    for (const secreto of secretos) {
      const valor = VALORES[secreto];
      // RESEND_API_KEY y RESEND_FROM_EMAIL no viven en .env.local, y la API de
      // Kapso solo lista los nombres de los secretos de v1, nunca sus valores.
      // Se avisa y se sigue: abortar dejaria el despliegue a medias.
      if (!valor) { pendientes.push(`${nombre}: ${secreto}`); continue; }
      await kapso(`/functions/${id}/secrets`, { metodo: 'POST', cuerpo: { secret: { name: secreto, value: valor } } })
        .catch((error: Error) => {
          // Un secreto que ya existe no es un fallo: se deja el valor vigente.
          if (!/422|already/i.test(error.message)) throw error;
        });
    }

    await kapso(`/functions/${id}/deploy`, { metodo: 'POST' });
    console.log(`desplegada   ${nombre}`);
    ids[nombre] = id;
  }

  console.log('\nfunction_id por nombre:');
  console.log(JSON.stringify(ids, null, 2));

  if (pendientes.length > 0) {
    console.log('
SECRETOS PENDIENTES (cargar en Kapso antes de emitir ordenes):');
    for (const pendiente of pendientes) console.log(`  - ${pendiente}`);
  }
}

main().catch((error) => { console.error(error.message); process.exit(1); });
```

- [ ] **Step 3: Agregar el script a `package.json`**

En la sección `scripts`, junto a los que ya existen:

```json
"kapso:functions": "tsx --env-file=.env.local scripts/kapso-functions.ts",
"kapso:workflow": "tsx --env-file=.env.local scripts/kapso-workflow-v2.ts"
```

- [ ] **Step 4: Verificar que el proyecto sigue tipando**

Run: `npm run typecheck`
Expected: sin errores.

- [ ] **Step 5: Desplegar y verificar contra Kapso**

Run: `npm run kapso:functions`
Expected: seis líneas `creada` + `desplegada`, y el mapa de `function_id`. **Guarda ese mapa**: Task 7 lo necesita.

Es esperable que el script liste `RESEND_API_KEY` y `RESEND_FROM_EMAIL` como pendientes: no están en `.env.local`, y la API de Kapso solo expone los nombres de los secretos que ya usa v1, nunca sus valores. Cárgalos a mano en Kapso → Functions → `emitir-ordenes-compra` → Secrets, o expórtalos en el shell y vuelve a correr el script. Sin ellos la emisión responde 500, y el smoke test de Task 8 lo detecta.

Verificación de que v1 no se tocó:

Run: `curl -s -H "X-API-Key: $KAPSO_API_KEY" https://api.kapso.ai/platform/v1/functions | grep -c '"name"'`
Expected: 20 (14 de v1 + 6 nuevas).

- [ ] **Step 6: Commit**

```bash
git add scripts/kapso.ts scripts/kapso-functions.ts package.json
git commit -m "feat(kapso-v2): despliegue reproducible de las functions"
```

---

### Task 7: Crear el workflow

**Files:**
- Create: `scripts/kapso-workflow-v2.ts`

**Interfaces:**
- Consumes: `kapso()` de Task 6, los `function_id` que imprimió Task 6, y los bloques `<!-- PROMPT:INICIO/FIN -->` de Task 5.
- Produces: el workflow `rr-isia-version2` en Kapso, con 13 nodos y 15 aristas. Imprime su `id`, que Task 8 usa para el smoke test.

- [ ] **Step 1: Escribir el script**

`scripts/kapso-workflow-v2.ts`:

```ts
import { readFileSync } from 'node:fs';
import { kapso } from './kapso.js';

interface Funcion { id: string; name: string; }
interface Workflow { id: string; name: string; slug: string; }

const MODELO = '8c6d57df-3f07-4290-b8a5-38047608c4df';  // claude-haiku-4-5, el mismo de v1

// Solo el bloque delimitado va al system_prompt. La cabecera y las notas de
// diseno son documentacion nuestra; en v1 se subio el archivo entero por error.
function prompt(agente: string): string {
  const archivo = readFileSync(`docs/kapso/prompts-v2/${agente}/v-01.md`, 'utf8');
  const bloque = /<!-- PROMPT:INICIO -->([\s\S]*?)<!-- PROMPT:FIN -->/.exec(archivo);
  if (!bloque) throw new Error(`${agente}/v-01.md no tiene delimitadores de prompt`);
  return bloque[1].trim();
}

function agente(id: string, x: number, y: number, texto: string, extra: Record<string, unknown> = {}) {
  return {
    id,
    type: 'flow-node',
    position: { x, y },
    data: {
      node_type: 'agent',
      display_name: id,
      config: {
        system_prompt: texto,
        provider_model_id: MODELO,
        temperature: 0,
        max_iterations: 20,
        message_delivery_mode: 'auto_send_assistant_text',
        enabled_default_tools: ['get_variable', 'save_variable', 'enter_waiting', 'complete_task', 'handoff_to_human'],
        ...extra,
      },
    },
  };
}

function fn(id: string, functionId: string, nombre: string, guardarEn: string, x: number, y: number) {
  return {
    id,
    type: 'flow-node',
    position: { x, y },
    data: {
      node_type: 'function',
      display_name: `Function: ${nombre}`,
      config: { function_id: functionId, function_name: nombre, save_response_to: guardarEn },
    },
  };
}

function decide(id: string, functionId: string, nombre: string, etiquetas: Array<[string, string]>, x: number, y: number) {
  return {
    id,
    type: 'flow-node',
    position: { x, y },
    data: {
      node_type: 'decide',
      display_name: `Decide: ${nombre}`,
      config: {
        decision_type: 'function',
        function_id: functionId,
        function_name: nombre,
        conditions: etiquetas.map(([label, description]) => ({ label, description })),
      },
    },
  };
}

async function main() {
  const { data: funciones } = await kapso<{ data: Funcion[] }>('/functions');
  const id = (nombre: string) => {
    const f = funciones.find((x) => x.name === nombre);
    if (!f) throw new Error(`Falta la function ${nombre}. Corre antes: npm run kapso:functions`);
    return f.id;
  };

  const nodos = [
    { id: 'start', type: 'flow-node', position: { x: -700, y: 0 }, data: { node_type: 'start', display_name: 'Start', config: {} } },

    agente('agente_descubrimiento', -480, 0, prompt('agente-descubrimiento'), {
      max_iterations: 40,
      enabled_default_tools: ['get_execution_metadata', 'get_variable', 'save_variable', 'enter_waiting', 'complete_task', 'handoff_to_human'],
      flow_agent_function_tools: [{
        name: 'buscar_productos',
        description: 'Busca productos del catálogo y devuelve precio final de venta, MPN, marca y disponibilidad; nunca costos.',
        function_id: id('buscar-productos-v2'),
        function_name: 'buscar-productos-v2',
        input_schema: {
          type: 'object',
          required: ['q'],
          properties: {
            q: { type: 'string' },
            marca: { type: 'string' },
            categoria: { type: 'string' },
            precio_max: { type: 'number' },
            limite: { type: 'integer' },
            incluir_sin_stock: { type: 'boolean' },
          },
        },
      }],
    }),

    fn('fn_cotizar', id('generar-cotizacion-v2'), 'generar-cotizacion-v2', 'quote_function_response', -260, 0),
    agente('agente_presentacion', -40, 0, prompt('agente-presentacion')),
    decide('route_decision', id('route-quote-decision-v2'), 'route-quote-decision-v2', [
      ['accepted', 'El cliente acepta la cotización'],
      ['rejected', 'El cliente rechaza o pide cambios'],
    ], 180, 0),

    agente('agente_facturacion', 400, 120, prompt('agente-facturacion')),
    fn('fn_validar_rut', id('validar-rut'), 'validar-rut', 'rut_validation_response', 620, 120),
    decide('route_rut', id('route-rut-v2'), 'route-rut-v2', [
      ['valid', 'RUT válido'],
      ['invalid', 'RUT inválido'],
    ], 840, 120),

    decide('fn_check_validity', id('check-quote-validity-v2'), 'check-quote-validity-v2', [
      ['valid', 'La cotización sigue vigente'],
      ['expired', 'La cotización expiró y debe recalcularse'],
    ], 1060, 120),

    agente('agente_cierre', 1280, 120, prompt('agente-cierre'), {
      max_iterations: 30,
      enabled_default_tools: ['get_execution_metadata', 'get_whatsapp_context', 'get_variable', 'save_variable', 'enter_waiting', 'complete_task', 'handoff_to_human'],
    }),

    fn('fn_emitir_ordenes', id('emitir-ordenes-compra'), 'emitir-ordenes-compra', 'purchase_orders_response', 1500, 120),

    {
      id: 'send_confirmacion',
      type: 'flow-node',
      position: { x: 1720, y: 120 },
      data: {
        node_type: 'send_text',
        display_name: 'Confirmación',
        config: {
          message: 'Listo, tu pedido quedó cursado 🙌 El equipo comercial te contacta para coordinar el pago y la entrega. ¡Gracias!',
          delay_seconds: 0,
        },
      },
    },

    { id: 'handoff_fin', type: 'flow-node', position: { x: 1940, y: 120 }, data: { node_type: 'handoff', display_name: 'Handoff', config: { reason: 'Pedido cursado, órdenes de compra emitidas' } } },
  ];

  const aristas = [
    { source: 'start', target: 'agente_descubrimiento', label: 'next' },
    { source: 'agente_descubrimiento', target: 'fn_cotizar', label: 'next' },
    { source: 'fn_cotizar', target: 'agente_presentacion', label: 'next' },
    { source: 'agente_presentacion', target: 'route_decision', label: 'next' },
    { source: 'route_decision', target: 'agente_facturacion', label: 'accepted' },
    { source: 'route_decision', target: 'agente_descubrimiento', label: 'rejected' },
    { source: 'agente_facturacion', target: 'fn_validar_rut', label: 'next' },
    { source: 'fn_validar_rut', target: 'route_rut', label: 'next' },
    { source: 'route_rut', target: 'fn_check_validity', label: 'valid' },
    { source: 'route_rut', target: 'agente_facturacion', label: 'invalid' },
    { source: 'fn_check_validity', target: 'agente_cierre', label: 'valid' },
    { source: 'fn_check_validity', target: 'fn_cotizar', label: 'expired' },
    { source: 'agente_cierre', target: 'fn_emitir_ordenes', label: 'next' },
    { source: 'fn_emitir_ordenes', target: 'send_confirmacion', label: 'next' },
    { source: 'send_confirmacion', target: 'handoff_fin', label: 'next' },
  ];

  const { data: existentes } = await kapso<{ data: Workflow[] }>('/workflows');
  const previo = existentes.find((w) => w.slug === 'rr-isia-version2');

  if (previo) {
    const { data: meta } = await kapso<{ data: { lock_version: number } }>(`/workflows/${previo.id}`);
    await kapso(`/workflows/${previo.id}`, {
      metodo: 'PATCH',
      cuerpo: { workflow: { lock_version: meta.lock_version, definition: { nodes: nodos, edges: aristas } } },
    });
    console.log(`workflow actualizado: ${previo.id}`);
    return;
  }

  const { data } = await kapso<{ data: Workflow }>('/workflows', {
    metodo: 'POST',
    cuerpo: {
      workflow: {
        name: 'rr-isia-version2',
        slug: 'rr-isia-version2',
        description: 'Cotiza con el mejor precio entre los tres mayoristas y emite una orden de compra por mayorista.',
        status: 'draft',
        definition: { nodes: nodos, edges: aristas },
      },
    },
  });
  console.log(`workflow creado: ${data.id}`);
}

main().catch((error) => { console.error(error.message); process.exit(1); });
```

- [ ] **Step 2: Verificar que tipa**

Run: `npm run typecheck`
Expected: sin errores.

- [ ] **Step 3: Crear el workflow**

Run: `npm run kapso:workflow`
Expected: `workflow creado: <uuid>`. **Anota ese id.**

Nota: se crea en `status: "draft"` a propósito. Se activa recién después del smoke test de Task 8.

- [ ] **Step 4: Verificar el grafo desplegado**

```bash
curl -s -H "X-API-Key: $KAPSO_API_KEY" \
  "https://api.kapso.ai/platform/v1/workflows/<uuid>/definition" \
  -o /tmp/v2.json
node -e '
const d = JSON.parse(require("fs").readFileSync("/tmp/v2.json","utf8")).data.definition;
console.log("nodos:", d.nodes.length, "aristas:", d.edges.length);
for (const e of d.edges) console.log(`${e.source} --[${e.label}]--> ${e.target}`);
'
```

Expected: `nodos: 13 aristas: 15`, y las aristas exactamente como la lista del spec.

- [ ] **Step 5: Verificar que ningún prompt llevó la documentación interna**

```bash
node -e '
const d = JSON.parse(require("fs").readFileSync("/tmp/v2.json","utf8")).data.definition;
for (const n of d.nodes.filter(n => n.data.node_type === "agent")) {
  const p = n.data.config.system_prompt || "";
  console.log(n.id, p.length, p.includes("**Nodo Kapso**") ? "LLEVA CABECERA (mal)" : "ok");
}
'
```

Expected: cuatro líneas `ok`.

- [ ] **Step 6: Commit**

```bash
git add scripts/kapso-workflow-v2.ts
git commit -m "feat(kapso-v2): creacion reproducible del workflow rr-isia-version2"
```

---

### Task 8: Smoke test y documentación operativa

**Files:**
- Create: `docs/kapso/README-v2.md`

**Interfaces:**
- Consumes: el workflow creado en Task 7 y las functions de Task 6.
- Produces: el workflow activo y verificado, más la documentación de cómo operarlo.

- [ ] **Step 1: Probar `generar-cotizacion-v2` contra la API real**

```bash
FN=$(curl -s -H "X-API-Key: $KAPSO_API_KEY" https://api.kapso.ai/platform/v1/functions \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.find(f=>f.name==="generar-cotizacion-v2").id))')

curl -s -X POST "https://api.kapso.ai/platform/v1/functions/$FN/invoke" \
  -H "X-API-Key: $KAPSO_API_KEY" -H "Content-Type: application/json" \
  -d '{"execution_context":{"vars":{"cart_items":[{"sku":"AR155EPS14","mpn":"ERC-38B","marca":"Epson","nombre":"Cinta Epson","cantidad":2}]}}}'
```

Expected: `estado: "ok"`, una línea con `proveedor` entre `intcomex`/`ingram`/`tecnoglobal`, y **ningún campo que contenga "costo"**.

- [ ] **Step 2: Verificar que la cotización no filtra costos**

Guardar la respuesta anterior en `/tmp/cot.json` y correr:

```bash
node -e '
const q = JSON.parse(require("fs").readFileSync("/tmp/cot.json","utf8")).quote;
const claves = new Set(q.lineas.flatMap(l => Object.keys(l)));
console.log([...claves].join(", "));
console.log(/costo/i.test(JSON.stringify(q)) ? "FILTRA COSTO" : "sin costos: ok");
'
```

Expected: `sin costos: ok`.

- [ ] **Step 3: Probar la emisión de órdenes con una cotización de dos mayoristas**

```bash
FN=$(curl -s -H "X-API-Key: $KAPSO_API_KEY" https://api.kapso.ai/platform/v1/functions   | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.find(f=>f.name==="emitir-ordenes-compra").id))')

cat > /tmp/oc.json <<'JSON'
{"execution_context":{"vars":{
  "quote_confirmed": true,
  "quote_customer_name": "Prueba Smoke",
  "billing_rut": "21088369-K",
  "billing_razon_social": "Acme SpA",
  "billing_email": "pyxis.latam@gmail.com",
  "quote_result": {
    "quote_id": "smoke-001", "version": 1,
    "neto_clp": 203965, "iva_clp": 38753, "total_clp": 242718,
    "proveedores_incompletos": [],
    "lineas": [
      {"mpn":"A-1","marca":"Epson","nombre":"Cinta A","cantidad":2,"proveedor":"ingram","sku_proveedor":"ING-1","precio_unitario_usd":11.3,"precio_unitario_clp":10735,"subtotal_neto_clp":21470,"disponible":true,"abastecimiento":"stock_inmediato","comparacion":"completa","ofertas_consideradas":3,"ahorro_vs_peor_clp":0},
      {"mpn":"A-2","marca":"Epson","nombre":"Cinta B","cantidad":1,"proveedor":"ingram","sku_proveedor":"ING-2","precio_unitario_usd":22.6,"precio_unitario_clp":21470,"subtotal_neto_clp":21470,"disponible":true,"abastecimiento":"stock_inmediato","comparacion":"completa","ofertas_consideradas":3,"ahorro_vs_peor_clp":0},
      {"mpn":"B-1","marca":"HP","nombre":"Toner","cantidad":3,"proveedor":"tecnoglobal","sku_proveedor":"TG-9","precio_unitario_usd":56.5,"precio_unitario_clp":53675,"subtotal_neto_clp":161025,"disponible":false,"abastecimiento":"por_comprar_importar","comparacion":"completa","ofertas_consideradas":2,"ahorro_vs_peor_clp":0}
    ]
  }
}}}
JSON

curl -s -X POST "https://api.kapso.ai/platform/v1/functions/$FN/invoke"   -H "X-API-Key: $KAPSO_API_KEY" -H "Content-Type: application/json" --data-binary @/tmp/oc.json
```

Expected: `purchase_orders_count: 2`, ambas con `status: "sent"`, y **dos correos** en la casilla interna — uno con `ING-1` y `ING-2`, otro con `TG-9`. El correo de Ingram debe mostrar costo unitario US$ 10.00 (11.3 / 1.13), no 11.3.

Repetir el mismo `curl`: la segunda vez no debe llegar ningún correo y las dos órdenes vienen con `status: "duplicate"`.

- [ ] **Step 4: Dejar documentado el PATCH de activación, sin ejecutarlo**

**No actives el workflow.** `Rayo Perez` está activo sobre el mismo número de WhatsApp, y decidir si conviven dos workflows activos es una decisión de operación, no de implementación. Deja `rr-isia-version2` en `draft` y documenta en `README-v2.md` el comando exacto para activarlo:

```bash
LOCK=$(curl -s -H "X-API-Key: $KAPSO_API_KEY" "https://api.kapso.ai/platform/v1/workflows/<uuid>" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.lock_version))')

curl -s -X PATCH "https://api.kapso.ai/platform/v1/workflows/<uuid>" \
  -H "X-API-Key: $KAPSO_API_KEY" -H "Content-Type: application/json" \
  -d "{\"workflow\":{\"lock_version\":$LOCK,\"status\":\"active\"}}"
```

Expected: `"status":"active"`.

- [ ] **Step 5: Conversación de prueba por WhatsApp**

| Lo que dice el cliente | Comportamiento esperado |
|---|---|
| "busco un notebook" | Repregunta por marca (409), no muestra productos |
| "un notebook HP" | Muestra 3-4 con precio de venta en USD |
| "llevo 2 del primero" | Arma `cart_items` **con `mpn` y `marca`** |
| confirmar el carro | Cotización en CLP con IVA y total |
| "no, muy caro" | Vuelve a descubrimiento, no a facturación |
| aceptar | Pide los siete campos en **un** mensaje |
| RUT inválido a propósito | Re-pregunta **solo** el RUT |
| confirmar el cierre | Llegan N correos de OC, uno por mayorista |
| "¿cuánto les cuesta a ustedes?" | No puede responder: nunca recibió el costo |

Verificación clave: en el historial de ejecución de Kapso, revisar que en ningún payload que recibió el modelo aparece un costo.

- [ ] **Step 6: Escribir la documentación operativa**

`docs/kapso/README-v2.md`, con: el id del workflow, el mapa `nombre → function_id`, los secretos de cada function y de dónde sale cada valor, cómo redesplegar (`npm run kapso:functions` y `npm run kapso:workflow`), cómo cambiar el margen (editar `MARGEN` en `scripts/kapso-functions.ts` y redesplegar), el esquema de la tabla `purchase_orders` y cómo consultar una OC, y qué revisar cuando una orden queda `failed`.

- [ ] **Step 7: Commit**

```bash
git add docs/kapso/README-v2.md
git commit -m "docs(kapso-v2): operacion del workflow rr-isia-version2"
```

---

## Verificación final

```bash
npm test          # toda la suite, incluidas las 31 pruebas nuevas de tests/kapso/
npm run typecheck
```

Y contra Kapso:

- `rr-isia-version2` en `status: active`, 13 nodos, 15 aristas.
- `Rayo Perez` intacto: `lock_version` 178, 18 nodos, 27 aristas, sus functions en `MARGEN=0.30`.
