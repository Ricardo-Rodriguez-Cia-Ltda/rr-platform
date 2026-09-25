# Compras y despachos — plan de implementación (etapa 1)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Registrar en el backoffice qué se compró a cada mayorista y cuándo llegó, y armar despachos al cliente (parciales si hace falta) con modalidad, courier, costo y cobro del envío, pasando el pedido a `entregado` solo cuando todo llegó a manos del cliente.

**Architecture:** Columnas nuevas en `pedidos` (cada fila es una orden de compra) para el estado de compra, y tablas nuevas `recepciones`, `despachos`, `despacho_lineas` y `despacho_eventos`. Toda la lógica de estados y cantidades vive en funciones puras en `apps/backoffice/src/lib/`, probadas sin red; las rutas API del backoffice las usan con datos frescos de Supabase (PostgREST con la service key) y escriben con PATCH condicionales. El despacho se crea con una función SQL (`crear_despacho`) para que despacho, líneas y primer evento se escriban juntos.

**Tech Stack:** Next.js 15 (App Router, server components), TypeScript, vitest, Supabase PostgREST por `fetch` (sin SDK), SQL aplicado a mano en el SQL Editor de Supabase.

**Spec:** `docs/superpowers/specs/2026-09-25-despachos-design.md`

## Global Constraints

- Estados de compra (`pedidos.estado_compra`): `por_comprar`, `comprada`, `por_retirar`, `en_camino`, `directo_al_cliente`, `recibida_parcial`, `recibida`, `entregada_al_cliente`, `anulada`. Default `por_comprar`.
- Modalidades de compra: `retiro`, `despacho_mayorista`, `directo_cliente`.
- Estados de despacho: `por_preparar`, `listo`, `en_ruta`, `entregado`, `fallido`, `anulado`. Default `por_preparar`.
- Modalidades de despacho: `retiro_oficina`, `propio`, `courier`. Couriers: `bluexpress`, `starken`, `chilexpress`, `otro`.
- Una línea de pedido se identifica por `po_id` + clave de línea; la clave es el `mpn` de la línea, o `linea-<índice>` si no tiene `mpn` (`claveLinea`).
- Toda transición es un PATCH condicional sobre el estado actual; si no afecta filas, responde 409. Repetir la misma transición no escribe y responde 200.
- Dirección de retiro en oficina: `José M. Infante 2629, Ñuñoa, Santiago`.
- Links de seguimiento: Starken `https://www.starken.cl/seguimiento?codigo=<n>` (con número); Blue Express `https://www.blue.cl/seguimiento/` y Chilexpress `https://www.chilexpress.cl/estado-envio-paquete-courier` (sin número); `otro` sin link.
- El backoffice no importa paquetes `@rr/*`; todo va en `apps/backoffice`.
- Comentarios en español sin tildes; textos de interfaz con tildes. Tests en `apps/backoffice/tests/`, corridos desde la raíz con `npx vitest run apps/backoffice`.
- Todos los commits terminan con estas dos líneas, verbatim:
  ```
  Co-Authored-By: Claude Opus 5.5 (1M context) <noreply@anthropic.com>
  Claude-Session: https://claude.ai/code/session_0181D9EDBLHn8Srbz98ydxeb
  ```

## Mapa de archivos

| Archivo | Responsabilidad |
|---|---|
| `docs/sql/2026-09-25-despachos.sql` (nuevo) | Columnas de compra, tablas nuevas, relleno inicial, función `crear_despacho` |
| `apps/backoffice/src/lib/supabase.ts` | + `supabasePost`, `supabaseRpc` |
| `apps/backoffice/src/lib/pedidos.ts` | `FilaPedido` suma las columnas de compra |
| `apps/backoffice/src/lib/compras.ts` (nuevo) | Máquina de estados de compra, recepción, atraso |
| `apps/backoffice/src/lib/despachos.ts` (nuevo) | Máquina de estados de despacho y requisitos |
| `apps/backoffice/src/lib/lineas.ts` (nuevo) | Líneas del pedido, cantidades, reglas de asignación, de "listo" y de pedido entregado |
| `apps/backoffice/src/lib/couriers.ts` (nuevo) | Registro de couriers y texto de "Copiar mensaje" |
| `apps/backoffice/src/lib/datos-pedido.ts` (nuevo) | Lectura de un pedido con sus recepciones y despachos; normalización; eventos |
| `apps/backoffice/src/lib/entrega.ts` (nuevo) | Paso automático del pedido a `entregado` |
| `apps/backoffice/src/lib/vista-compras.ts`, `vista-despachos.ts` (nuevos) | Cargadores de las vistas |
| `apps/backoffice/app/api/compras/{registrar,transicion,recepcion}/route.ts` (nuevos) | Rutas de compras |
| `apps/backoffice/app/api/despachos/route.ts`, `despachos/{editar,transicion}/route.ts` (nuevos) | Rutas de despachos |
| `apps/backoffice/app/compras/page.tsx`, `app/despachos/page.tsx` (nuevos) | Vistas |
| `apps/backoffice/app/componentes/{AccionesCompra,FormularioDespacho,AccionesDespacho,TarjetaDespacho}.tsx` (nuevos) | Componentes |
| `apps/backoffice/app/componentes/Nav.tsx`, `app/globals.css` | Entradas de menú y estilos |

---

### Task 1: Esquema SQL

**Files:**
- Create: `docs/sql/2026-09-25-despachos.sql`
- Test: `tests/docs.test.ts` (raíz del repo; se agrega un caso)

**Interfaces:**
- Produces: columnas `pedidos.estado_compra`, `modalidad_compra`, `numero_pedido_mayorista`, `comprada_at`, `llegada_estimada`, `guia_mayorista`, `nota_compra`; tablas `recepciones`, `despachos`, `despacho_lineas`, `despacho_eventos`; función `crear_despacho(p_despacho jsonb, p_lineas jsonb) returns despachos`.

- [ ] **Step 1: Write the failing test**

Agregar al final de `tests/docs.test.ts` (leer el archivo primero para seguir su estilo de imports; usa `readFileSync` de `node:fs`):

```ts
describe('docs/sql/2026-09-25-despachos.sql', () => {
  const sql = readFileSync('docs/sql/2026-09-25-despachos.sql', 'utf8');
  it('declara las columnas de compra, las cuatro tablas y la funcion crear_despacho', () => {
    for (const trozo of [
      'estado_compra', 'modalidad_compra', 'numero_pedido_mayorista', 'comprada_at',
      'llegada_estimada', 'guia_mayorista', 'nota_compra',
      'create table if not exists recepciones', 'create table if not exists despachos',
      'create table if not exists despacho_lineas', 'create table if not exists despacho_eventos',
      'create or replace function crear_despacho',
    ]) expect(sql).toContain(trozo);
  });
  it('activa RLS en las tablas nuevas', () => {
    for (const t of ['recepciones', 'despachos', 'despacho_lineas', 'despacho_eventos']) {
      expect(sql).toContain(`alter table ${t} enable row level security`);
    }
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/docs.test.ts`
Expected: FAIL — `ENOENT` al leer el archivo SQL.

- [ ] **Step 3: Write the SQL**

```sql
-- Modulo de compras y despachos (spec 2026-09-25-despachos-design).
-- Se aplica a mano en el SQL Editor de Supabase. Es idempotente: se puede
-- correr dos veces sin romper nada.

-- 1. Compras: estado de abastecimiento por orden de compra (fila de pedidos).
alter table pedidos add column if not exists estado_compra text not null default 'por_comprar'
  check (estado_compra in ('por_comprar','comprada','por_retirar','en_camino','directo_al_cliente',
                           'recibida_parcial','recibida','entregada_al_cliente','anulada'));
alter table pedidos add column if not exists modalidad_compra text
  check (modalidad_compra in ('retiro','despacho_mayorista','directo_cliente'));
alter table pedidos add column if not exists numero_pedido_mayorista text;
alter table pedidos add column if not exists comprada_at timestamptz;
alter table pedidos add column if not exists llegada_estimada date;
alter table pedidos add column if not exists guia_mayorista text;
alter table pedidos add column if not exists nota_compra text;

-- Relleno inicial: lo ya entregado o anulado no aparece como compra pendiente.
update pedidos set estado_compra = 'recibida'
  where estado_negocio = 'entregado' and estado_compra = 'por_comprar';
update pedidos set estado_compra = 'anulada'
  where estado_negocio = 'anulado' and estado_compra = 'por_comprar';

-- 2. Recepciones: lo que llego de cada linea de una orden de compra.
create table if not exists recepciones (
  id bigint generated always as identity primary key,
  po_id text not null references pedidos(po_id),
  mpn text not null,
  cantidad int not null check (cantidad > 0),
  recibido_at timestamptz not null default now(),
  nota text
);
create index if not exists recepciones_po_id on recepciones(po_id);
alter table recepciones enable row level security;

-- 3. Despachos al cliente. El id es tambien el numero visible del despacho.
create table if not exists despachos (
  id bigint generated always as identity primary key,
  quote_id text not null,
  quote_version text not null,
  modalidad text not null check (modalidad in ('retiro_oficina','propio','courier')),
  courier text check (courier in ('bluexpress','starken','chilexpress','otro')),
  estado text not null default 'por_preparar'
    check (estado in ('por_preparar','listo','en_ruta','entregado','fallido','anulado')),
  direccion text, comuna text, ciudad text,
  contacto_nombre text, contacto_telefono text,
  fecha_programada date,
  responsable text,
  numero_seguimiento text,
  costo_clp int check (costo_clp >= 0),
  cobrado_clp int check (cobrado_clp >= 0),
  cobro_pagado boolean not null default false,
  nota text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  despachado_at timestamptz,
  entregado_at timestamptz
);
create index if not exists despachos_pedido on despachos(quote_id, quote_version);
alter table despachos enable row level security;

create table if not exists despacho_lineas (
  id bigint generated always as identity primary key,
  despacho_id bigint not null references despachos(id) on delete cascade,
  po_id text not null references pedidos(po_id),
  mpn text not null,
  cantidad int not null check (cantidad > 0)
);
create index if not exists despacho_lineas_despacho on despacho_lineas(despacho_id);
alter table despacho_lineas enable row level security;

create table if not exists despacho_eventos (
  id bigint generated always as identity primary key,
  despacho_id bigint not null references despachos(id) on delete cascade,
  desde text,
  hacia text not null,
  nota text,
  created_at timestamptz not null default now()
);
create index if not exists despacho_eventos_despacho on despacho_eventos(despacho_id);
alter table despacho_eventos enable row level security;

-- 4. Crear un despacho con sus lineas y su primer evento en una sola
-- transaccion: si algo falla, no queda un despacho sin lineas.
create or replace function crear_despacho(p_despacho jsonb, p_lineas jsonb)
returns despachos language plpgsql as $$
declare
  d despachos;
begin
  insert into despachos (
    quote_id, quote_version, modalidad, courier, direccion, comuna, ciudad,
    contacto_nombre, contacto_telefono, fecha_programada, responsable,
    costo_clp, cobrado_clp, nota
  ) values (
    p_despacho->>'quote_id', p_despacho->>'quote_version', p_despacho->>'modalidad',
    nullif(p_despacho->>'courier', ''),
    nullif(p_despacho->>'direccion', ''), nullif(p_despacho->>'comuna', ''), nullif(p_despacho->>'ciudad', ''),
    nullif(p_despacho->>'contacto_nombre', ''), nullif(p_despacho->>'contacto_telefono', ''),
    nullif(p_despacho->>'fecha_programada', '')::date,
    nullif(p_despacho->>'responsable', ''),
    nullif(p_despacho->>'costo_clp', '')::int, nullif(p_despacho->>'cobrado_clp', '')::int,
    nullif(p_despacho->>'nota', '')
  ) returning * into d;

  insert into despacho_lineas (despacho_id, po_id, mpn, cantidad)
  select d.id, l->>'po_id', l->>'mpn', (l->>'cantidad')::int
  from jsonb_array_elements(p_lineas) as l;

  insert into despacho_eventos (despacho_id, desde, hacia, nota)
  values (d.id, null, 'por_preparar', 'creado');

  return d;
end;
$$;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/docs.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add docs/sql/2026-09-25-despachos.sql tests/docs.test.ts
git commit -m "feat(despachos): esquema SQL de compras, recepciones y despachos"
```

---

### Task 2: Helpers de escritura en Supabase

**Files:**
- Modify: `apps/backoffice/src/lib/supabase.ts`
- Test: `apps/backoffice/tests/supabase.test.ts` (agregar casos)

**Interfaces:**
- Produces:
  ```ts
  export async function supabasePost(path: string, body: unknown): Promise<unknown[] | null>;
  export async function supabaseRpc(fn: string, args: unknown): Promise<unknown | null>;
  ```

- [ ] **Step 1: Write the failing test**

Agregar a `apps/backoffice/tests/supabase.test.ts` (leer el archivo primero y reutilizar su forma de `vi.stubEnv` / `vi.stubGlobal`):

```ts
import { supabasePost, supabaseRpc } from '../src/lib/supabase.js';

describe('supabasePost y supabaseRpc', () => {
  it('POST inserta con return=representation y devuelve las filas', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    const f = vi.fn(async () => new Response(JSON.stringify([{ id: 1 }]), { status: 201 }));
    vi.stubGlobal('fetch', f);
    expect(await supabasePost('/recepciones', { po_id: 'oc-1' })).toEqual([{ id: 1 }]);
    const [url, init] = f.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe('https://supabase.test/rest/v1/recepciones');
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>).Prefer).toBe('return=representation');
    expect(JSON.parse(String(init.body))).toEqual({ po_id: 'oc-1' });
  });

  it('RPC llama /rpc/<fn> y devuelve el cuerpo tal cual', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    const f = vi.fn(async () => new Response(JSON.stringify({ id: 7 }), { status: 200 }));
    vi.stubGlobal('fetch', f);
    expect(await supabaseRpc('crear_despacho', { p_lineas: [] })).toEqual({ id: 7 });
    expect(String(f.mock.calls[0][0])).toBe('https://supabase.test/rest/v1/rpc/crear_despacho');
  });

  it('status no 2xx, red caida o sin config devuelven null', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test');
    vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 400 })));
    expect(await supabasePost('/x', {})).toBeNull();
    expect(await supabaseRpc('f', {})).toBeNull();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new TypeError('fetch failed'); }));
    expect(await supabasePost('/x', {})).toBeNull();
    vi.unstubAllEnvs();
    expect(await supabaseRpc('f', {})).toBeNull();
  });
});
```

Si el archivo no tiene `afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); })`, agregarlo.

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backoffice/tests/supabase.test.ts`
Expected: FAIL — `supabasePost` no existe.

- [ ] **Step 3: Implement**

Agregar a `apps/backoffice/src/lib/supabase.ts`:

```ts
async function escribir(metodo: 'POST', ruta: string, body: unknown): Promise<unknown | null> {
  const cfg = base();
  if (!cfg) return null;
  try {
    const r = await fetch(`${cfg.url}/rest/v1${ruta}`, {
      method: metodo,
      headers: {
        apikey: cfg.key, Authorization: `Bearer ${cfg.key}`,
        'Content-Type': 'application/json', Prefer: 'return=representation',
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return null;
    return (await r.json()) as unknown;
  } catch {
    return null;
  }
}

export async function supabasePost(path: string, body: unknown): Promise<unknown[] | null> {
  return (await escribir('POST', path, body)) as unknown[] | null;
}

// Funciones SQL expuestas por PostgREST en /rpc/<nombre>. Se usan cuando una
// escritura tiene que ser atomica (varias tablas a la vez).
export async function supabaseRpc(fn: string, args: unknown): Promise<unknown | null> {
  return escribir('POST', `/rpc/${fn}`, args);
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run apps/backoffice/tests/supabase.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backoffice/src/lib/supabase.ts apps/backoffice/tests/supabase.test.ts
git commit -m "feat(despachos): helpers de insercion y RPC para Supabase"
```

---

### Task 3: Lógica pura de compras, despachos, líneas y couriers

**Files:**
- Modify: `apps/backoffice/src/lib/pedidos.ts` (`FilaPedido`)
- Create: `apps/backoffice/src/lib/compras.ts`, `despachos.ts`, `lineas.ts`, `couriers.ts`
- Test: `apps/backoffice/tests/compras.test.ts`, `despachos.test.ts`, `lineas.test.ts`, `couriers.test.ts`

**Interfaces:**
- Produces:
  ```ts
  // compras.ts
  export type EstadoCompra = 'por_comprar' | 'comprada' | 'por_retirar' | 'en_camino' | 'directo_al_cliente'
    | 'recibida_parcial' | 'recibida' | 'entregada_al_cliente' | 'anulada';
  export type ModalidadCompra = 'retiro' | 'despacho_mayorista' | 'directo_cliente';
  export const ESTADOS_COMPRA: EstadoCompra[];
  export const MODALIDADES_COMPRA: ModalidadCompra[];
  export const ESTADOS_COMPRA_EDITABLES: EstadoCompra[];
  export function transicionCompraValida(desde: EstadoCompra, hacia: EstadoCompra, modalidad: ModalidadCompra | null): boolean;
  export function admiteRecepcion(estado: EstadoCompra, modalidad: ModalidadCompra | null): boolean;
  export function estadoTrasRecepcion(comprado: Map<string, number>, recibido: Map<string, number>): 'recibida' | 'recibida_parcial';
  export function compraAtrasada(c: { estado_compra: EstadoCompra; llegada_estimada: string | null }, hoy: string): boolean;
  export function hoySantiago(ahora?: Date): string; // 'YYYY-MM-DD'
  // despachos.ts
  export type EstadoDespacho = 'por_preparar' | 'listo' | 'en_ruta' | 'entregado' | 'fallido' | 'anulado';
  export type ModalidadDespacho = 'retiro_oficina' | 'propio' | 'courier';
  export const ESTADOS_DESPACHO: EstadoDespacho[];
  export const MODALIDADES_DESPACHO: ModalidadDespacho[];
  export const ESTADOS_DESPACHO_ACTIVOS: EstadoDespacho[]; // por_preparar, listo, en_ruta, fallido
  export function transicionDespachoValida(desde: EstadoDespacho, hacia: EstadoDespacho, modalidad: ModalidadDespacho): boolean;
  export function requisitoTransicion(d: { modalidad: ModalidadDespacho; numero_seguimiento: string | null }, hacia: EstadoDespacho): string | null;
  // lineas.ts
  export interface LineaCompra { poId: string; clave: string; nombre: string; cantidad: number; directo: boolean; entregadaDirecto: boolean }
  export interface Recepcion { po_id: string; mpn: string; cantidad: number }
  export interface DespachoLinea { po_id: string; mpn: string; cantidad: number }
  export interface Despacho { id: number; quote_id: string; quote_version: string; modalidad: ModalidadDespacho;
    courier: CourierId | null; estado: EstadoDespacho; direccion: string | null; comuna: string | null; ciudad: string | null;
    contacto_nombre: string | null; contacto_telefono: string | null; fecha_programada: string | null;
    responsable: string | null; numero_seguimiento: string | null; costo_clp: number | null; cobrado_clp: number | null;
    cobro_pagado: boolean; nota: string | null; created_at: string; entregado_at: string | null; lineas: DespachoLinea[] }
  export interface ResumenLinea extends LineaCompra { recibida: number; asignada: number; enMano: number; entregada: number; pendiente: number }
  export function claveLinea(l: { mpn?: string | null }, indice: number): string;
  export function lineasDePedido(filas: FilaPedido[]): LineaCompra[];
  export function resumirLineas(lineas: LineaCompra[], recepciones: Recepcion[], despachos: Despacho[]): ResumenLinea[];
  export function validarAsignacion(resumen: ResumenLinea[], pedidas: DespachoLinea[]): string | null;
  export function faltantesParaListo(despacho: Despacho, recepciones: Recepcion[], despachos: Despacho[]): string[];
  export function pedidoCompletamenteEntregado(resumen: ResumenLinea[]): boolean;
  // couriers.ts
  export type CourierId = 'bluexpress' | 'starken' | 'chilexpress' | 'otro';
  export interface Courier { id: CourierId; nombre: string; urlSeguimiento(numero: string): { url: string; conNumero: boolean } | null }
  export const COURIERS: Record<CourierId, Courier>;
  export const DIRECCION_RETIRO: string;
  export function mensajeCliente(d: Pick<Despacho, 'estado' | 'modalidad' | 'courier' | 'numero_seguimiento' | 'fecha_programada'>,
    p: { numeroCotizacion: number | null; contacto: string | null }): string | null;
  ```

- [ ] **Step 1: Extend `FilaPedido`**

En `apps/backoffice/src/lib/pedidos.ts`, dentro de `interface FilaPedido`, después de `neto_grupo_clp`:

```ts
  // Modulo de compras (docs/sql/2026-09-25-despachos.sql). Opcionales: una
  // consulta sin estas columnas (pre-ALTER) sigue tipando.
  estado_compra?: import('./compras.js').EstadoCompra;
  modalidad_compra?: import('./compras.js').ModalidadCompra | null;
  numero_pedido_mayorista?: string | null;
  comprada_at?: string | null;
  llegada_estimada?: string | null;
  guia_mayorista?: string | null;
  nota_compra?: string | null;
```

- [ ] **Step 2: Write the failing tests**

```ts
// apps/backoffice/tests/compras.test.ts
import { describe, expect, it } from 'vitest';
import {
  admiteRecepcion, compraAtrasada, estadoTrasRecepcion, hoySantiago, transicionCompraValida,
} from '../src/lib/compras.js';

describe('transicionCompraValida', () => {
  it('por_comprar solo va a comprada o anulada', () => {
    expect(transicionCompraValida('por_comprar', 'comprada', null)).toBe(true);
    expect(transicionCompraValida('por_comprar', 'anulada', null)).toBe(true);
    expect(transicionCompraValida('por_comprar', 'en_camino', 'despacho_mayorista')).toBe(false);
  });
  it('desde comprada, el siguiente estado depende de la modalidad', () => {
    expect(transicionCompraValida('comprada', 'por_retirar', 'retiro')).toBe(true);
    expect(transicionCompraValida('comprada', 'por_retirar', 'despacho_mayorista')).toBe(false);
    expect(transicionCompraValida('comprada', 'en_camino', 'despacho_mayorista')).toBe(true);
    expect(transicionCompraValida('comprada', 'directo_al_cliente', 'directo_cliente')).toBe(true);
    expect(transicionCompraValida('comprada', 'directo_al_cliente', 'retiro')).toBe(false);
  });
  it('directo_al_cliente termina en entregada_al_cliente; recibida y anulada son finales', () => {
    expect(transicionCompraValida('directo_al_cliente', 'entregada_al_cliente', 'directo_cliente')).toBe(true);
    expect(transicionCompraValida('recibida', 'anulada', 'retiro')).toBe(false);
    expect(transicionCompraValida('anulada', 'comprada', null)).toBe(false);
  });
});

describe('admiteRecepcion', () => {
  it('solo con la compra hecha y si no va directo al cliente', () => {
    expect(admiteRecepcion('comprada', 'retiro')).toBe(true);
    expect(admiteRecepcion('en_camino', 'despacho_mayorista')).toBe(true);
    expect(admiteRecepcion('recibida_parcial', 'retiro')).toBe(true);
    expect(admiteRecepcion('por_comprar', null)).toBe(false);
    expect(admiteRecepcion('recibida', 'retiro')).toBe(false);
    expect(admiteRecepcion('comprada', 'directo_cliente')).toBe(false);
  });
});

describe('estadoTrasRecepcion', () => {
  const comprado = new Map([['A', 2], ['B', 1]]);
  it('recibida cuando cada linea alcanzo lo comprado; si no, recibida_parcial', () => {
    expect(estadoTrasRecepcion(comprado, new Map([['A', 2], ['B', 1]]))).toBe('recibida');
    expect(estadoTrasRecepcion(comprado, new Map([['A', 2]]))).toBe('recibida_parcial');
    expect(estadoTrasRecepcion(comprado, new Map([['A', 1], ['B', 1]]))).toBe('recibida_parcial');
  });
});

describe('compraAtrasada', () => {
  it('llegada estimada vencida y sin recibir', () => {
    expect(compraAtrasada({ estado_compra: 'en_camino', llegada_estimada: '2026-09-20' }, '2026-09-25')).toBe(true);
    expect(compraAtrasada({ estado_compra: 'en_camino', llegada_estimada: '2026-09-25' }, '2026-09-25')).toBe(false);
    expect(compraAtrasada({ estado_compra: 'recibida', llegada_estimada: '2026-09-20' }, '2026-09-25')).toBe(false);
    expect(compraAtrasada({ estado_compra: 'comprada', llegada_estimada: null }, '2026-09-25')).toBe(false);
  });
  it('hoySantiago da la fecha local de Chile', () => {
    // 2026-09-26 02:00 UTC es todavia 25 en Santiago (UTC-3).
    expect(hoySantiago(new Date('2026-09-26T02:00:00Z'))).toBe('2026-09-25');
  });
});
```

```ts
// apps/backoffice/tests/despachos.test.ts
import { describe, expect, it } from 'vitest';
import { requisitoTransicion, transicionDespachoValida } from '../src/lib/despachos.js';

describe('transicionDespachoValida', () => {
  it('camino normal por courier o despacho propio', () => {
    expect(transicionDespachoValida('por_preparar', 'listo', 'courier')).toBe(true);
    expect(transicionDespachoValida('listo', 'en_ruta', 'courier')).toBe(true);
    expect(transicionDespachoValida('en_ruta', 'entregado', 'propio')).toBe(true);
    expect(transicionDespachoValida('listo', 'entregado', 'propio')).toBe(false);
  });
  it('retiro en oficina pasa de listo a entregado, sin ruta', () => {
    expect(transicionDespachoValida('listo', 'entregado', 'retiro_oficina')).toBe(true);
    expect(transicionDespachoValida('listo', 'en_ruta', 'retiro_oficina')).toBe(false);
  });
  it('fallido se reprograma o se anula; entregado y anulado son finales', () => {
    expect(transicionDespachoValida('en_ruta', 'fallido', 'courier')).toBe(true);
    expect(transicionDespachoValida('fallido', 'listo', 'courier')).toBe(true);
    expect(transicionDespachoValida('fallido', 'anulado', 'courier')).toBe(true);
    expect(transicionDespachoValida('entregado', 'anulado', 'courier')).toBe(false);
    expect(transicionDespachoValida('anulado', 'listo', 'courier')).toBe(false);
    expect(transicionDespachoValida('en_ruta', 'anulado', 'courier')).toBe(false);
  });
});

describe('requisitoTransicion', () => {
  it('courier en ruta exige numero de seguimiento', () => {
    expect(requisitoTransicion({ modalidad: 'courier', numero_seguimiento: null }, 'en_ruta')).toMatch(/seguimiento/);
    expect(requisitoTransicion({ modalidad: 'courier', numero_seguimiento: '  ' }, 'en_ruta')).toMatch(/seguimiento/);
    expect(requisitoTransicion({ modalidad: 'courier', numero_seguimiento: '123' }, 'en_ruta')).toBeNull();
    expect(requisitoTransicion({ modalidad: 'propio', numero_seguimiento: null }, 'en_ruta')).toBeNull();
  });
});
```

```ts
// apps/backoffice/tests/lineas.test.ts
import { describe, expect, it } from 'vitest';
import type { FilaPedido } from '../src/lib/pedidos.js';
import {
  claveLinea, faltantesParaListo, lineasDePedido, pedidoCompletamenteEntregado, resumirLineas, validarAsignacion,
  type Despacho,
} from '../src/lib/lineas.js';

function fila(poId: string, lineas: Array<{ mpn?: string | null; nombre?: string; cantidad: number }>, extra: Partial<FilaPedido> = {}): FilaPedido {
  return {
    po_id: poId, quote_id: 'q', quote_version: '1', proveedor: poId, telefono: null, rut: null, razon_social: null,
    estado: 'sent', estado_negocio: 'pagado', created_at: '2026-09-25T00:00:00Z', neto_grupo_clp: null,
    lineas, estado_compra: 'comprada', modalidad_compra: 'retiro', ...extra,
  };
}
function despacho(id: number, estado: Despacho['estado'], lineas: Despacho['lineas']): Despacho {
  return {
    id, quote_id: 'q', quote_version: '1', modalidad: 'courier', courier: 'starken', estado,
    direccion: null, comuna: null, ciudad: null, contacto_nombre: null, contacto_telefono: null,
    fecha_programada: null, responsable: null, numero_seguimiento: null, costo_clp: null, cobrado_clp: null,
    cobro_pagado: false, nota: null, created_at: '2026-09-25T00:00:00Z', entregado_at: null, lineas,
  };
}

// Pedido de dos mayoristas: oc-int (A x2) y oc-tg (B x1).
const FILAS = [
  fila('oc-int', [{ mpn: 'A', nombre: 'Toner A', cantidad: 2 }]),
  fila('oc-tg', [{ mpn: 'B', nombre: 'Toner B', cantidad: 1 }]),
];

describe('claveLinea y lineasDePedido', () => {
  it('usa el mpn, o linea-<i> si no hay', () => {
    expect(claveLinea({ mpn: 'X1' }, 0)).toBe('X1');
    expect(claveLinea({ mpn: null }, 3)).toBe('linea-3');
  });
  it('marca las lineas directas al cliente y omite las ordenes anuladas', () => {
    const lineas = lineasDePedido([
      ...FILAS,
      fila('oc-dir', [{ mpn: 'C', cantidad: 1 }], { modalidad_compra: 'directo_cliente', estado_compra: 'entregada_al_cliente' }),
      fila('oc-anul', [{ mpn: 'D', cantidad: 1 }], { estado_compra: 'anulada' }),
    ]);
    expect(lineas.map((l) => `${l.poId}|${l.clave}|${l.directo}|${l.entregadaDirecto}`)).toEqual([
      'oc-int|A|false|false', 'oc-tg|B|false|false', 'oc-dir|C|true|true',
    ]);
  });
});

describe('resumirLineas', () => {
  it('cuenta recibido, asignado, en mano y entregado; los anulados no cuentan', () => {
    const r = resumirLineas(
      lineasDePedido(FILAS),
      [{ po_id: 'oc-int', mpn: 'A', cantidad: 2 }],
      [
        despacho(1, 'entregado', [{ po_id: 'oc-int', mpn: 'A', cantidad: 1 }]),
        despacho(2, 'por_preparar', [{ po_id: 'oc-int', mpn: 'A', cantidad: 1 }]),
        despacho(3, 'anulado', [{ po_id: 'oc-tg', mpn: 'B', cantidad: 1 }]),
      ],
    );
    const a = r.find((l) => l.clave === 'A')!;
    expect([a.recibida, a.asignada, a.enMano, a.entregada, a.pendiente]).toEqual([2, 2, 1, 1, 0]);
    const b = r.find((l) => l.clave === 'B')!;
    expect([b.asignada, b.pendiente]).toEqual([0, 1]);
  });
});

describe('validarAsignacion', () => {
  const resumen = () => resumirLineas(lineasDePedido(FILAS), [], [despacho(1, 'listo', [{ po_id: 'oc-int', mpn: 'A', cantidad: 1 }])]);
  it('acepta hasta lo pendiente (despacho parcial)', () => {
    expect(validarAsignacion(resumen(), [{ po_id: 'oc-int', mpn: 'A', cantidad: 1 }])).toBeNull();
  });
  it('rechaza vacio, mas de lo pendiente (tambien sumando duplicados) o una linea ajena', () => {
    expect(validarAsignacion(resumen(), [])).toMatch(/no tiene productos/);
    expect(validarAsignacion(resumen(), [{ po_id: 'oc-int', mpn: 'A', cantidad: 2 }])).toMatch(/quedan 1/);
    expect(validarAsignacion(resumen(), [
      { po_id: 'oc-int', mpn: 'A', cantidad: 1 }, { po_id: 'oc-int', mpn: 'A', cantidad: 1 },
    ])).toMatch(/quedan 1/);
    expect(validarAsignacion(resumen(), [{ po_id: 'oc-x', mpn: 'Z', cantidad: 1 }])).toMatch(/no está en el pedido/);
  });
  it('rechaza lineas que el mayorista despacha directo al cliente', () => {
    const r = resumirLineas(lineasDePedido([fila('oc-dir', [{ mpn: 'C', nombre: 'Toner C', cantidad: 1 }], { modalidad_compra: 'directo_cliente', estado_compra: 'directo_al_cliente' })]), [], []);
    expect(validarAsignacion(r, [{ po_id: 'oc-dir', mpn: 'C', cantidad: 1 }])).toMatch(/directo al cliente/);
  });
});

describe('faltantesParaListo', () => {
  it('lista lo que falta recibir, descontando lo que otros despachos ya tienen en mano', () => {
    const d2 = despacho(2, 'por_preparar', [{ po_id: 'oc-int', mpn: 'A', cantidad: 1 }]);
    const otros = [despacho(1, 'listo', [{ po_id: 'oc-int', mpn: 'A', cantidad: 1 }]), d2];
    expect(faltantesParaListo(d2, [{ po_id: 'oc-int', mpn: 'A', cantidad: 1 }], otros)).toEqual(['A: faltan 1']);
    expect(faltantesParaListo(d2, [{ po_id: 'oc-int', mpn: 'A', cantidad: 2 }], otros)).toEqual([]);
  });
});

describe('pedidoCompletamenteEntregado', () => {
  it('true solo cuando todo lo nuestro se entrego y lo directo quedo entregado', () => {
    const lineas = lineasDePedido(FILAS);
    const todo = [despacho(1, 'entregado', [{ po_id: 'oc-int', mpn: 'A', cantidad: 2 }, { po_id: 'oc-tg', mpn: 'B', cantidad: 1 }])];
    expect(pedidoCompletamenteEntregado(resumirLineas(lineas, [], todo))).toBe(true);
    const parcial = [despacho(1, 'entregado', [{ po_id: 'oc-int', mpn: 'A', cantidad: 2 }])];
    expect(pedidoCompletamenteEntregado(resumirLineas(lineas, [], parcial))).toBe(false);
    const directo = lineasDePedido([fila('oc-dir', [{ mpn: 'C', cantidad: 1 }], { modalidad_compra: 'directo_cliente', estado_compra: 'directo_al_cliente' })]);
    expect(pedidoCompletamenteEntregado(resumirLineas(directo, [], []))).toBe(false);
    expect(pedidoCompletamenteEntregado([])).toBe(false);
  });
});
```

```ts
// apps/backoffice/tests/couriers.test.ts
import { describe, expect, it } from 'vitest';
import { COURIERS, DIRECCION_RETIRO, mensajeCliente } from '../src/lib/couriers.js';

describe('COURIERS.urlSeguimiento', () => {
  it('Starken lleva el numero en la URL', () => {
    expect(COURIERS.starken.urlSeguimiento(' 123456789 ')).toEqual({ url: 'https://www.starken.cl/seguimiento?codigo=123456789', conNumero: true });
  });
  it('Blue Express y Chilexpress dan su pagina sin el numero; otro no da link', () => {
    expect(COURIERS.bluexpress.urlSeguimiento('1')).toEqual({ url: 'https://www.blue.cl/seguimiento/', conNumero: false });
    expect(COURIERS.chilexpress.urlSeguimiento('1')).toEqual({ url: 'https://www.chilexpress.cl/estado-envio-paquete-courier', conNumero: false });
    expect(COURIERS.otro.urlSeguimiento('1')).toBeNull();
  });
  it('sin numero no hay link', () => {
    expect(COURIERS.starken.urlSeguimiento('')).toBeNull();
    expect(COURIERS.bluexpress.urlSeguimiento(' ')).toBeNull();
  });
});

describe('mensajeCliente', () => {
  const p = { numeroCotizacion: 1600010, contacto: 'María López' };
  const base = { courier: null, numero_seguimiento: null, fecha_programada: null } as const;
  it('retiro listo: da la direccion de la oficina', () => {
    const m = mensajeCliente({ ...base, estado: 'listo', modalidad: 'retiro_oficina' }, p);
    expect(m).toBe(`Hola María, tu pedido N° 1600010 está listo para retiro en ${DIRECCION_RETIRO}.`);
  });
  it('courier en ruta: numero y link segun el courier', () => {
    expect(mensajeCliente({ ...base, estado: 'en_ruta', modalidad: 'courier', courier: 'starken', numero_seguimiento: '999' }, p))
      .toBe('Hola María, tu pedido N° 1600010 va en camino por Starken. N° de seguimiento: 999. Síguelo aquí: https://www.starken.cl/seguimiento?codigo=999');
    expect(mensajeCliente({ ...base, estado: 'en_ruta', modalidad: 'courier', courier: 'bluexpress', numero_seguimiento: '999' }, p))
      .toContain('ingresando ese número en https://www.blue.cl/seguimiento/');
  });
  it('despacho propio en ruta, con y sin fecha', () => {
    expect(mensajeCliente({ ...base, estado: 'en_ruta', modalidad: 'propio', fecha_programada: '2026-09-28' }, p))
      .toBe('Hola María, tu pedido N° 1600010 va en camino; te lo entregamos el 28-09-2026.');
    expect(mensajeCliente({ ...base, estado: 'en_ruta', modalidad: 'propio' }, { numeroCotizacion: null, contacto: null }))
      .toBe('Hola, tu pedido va en camino.');
  });
  it('entregado agradece; por_preparar no tiene mensaje', () => {
    expect(mensajeCliente({ ...base, estado: 'entregado', modalidad: 'propio' }, p)).toBe('Hola María, tu pedido N° 1600010 quedó entregado. ¡Gracias por tu compra!');
    expect(mensajeCliente({ ...base, estado: 'por_preparar', modalidad: 'propio' }, p)).toBeNull();
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run: `npx vitest run apps/backoffice/tests/compras.test.ts apps/backoffice/tests/despachos.test.ts apps/backoffice/tests/lineas.test.ts apps/backoffice/tests/couriers.test.ts`
Expected: FAIL — los módulos no existen.

- [ ] **Step 4: Implement**

```ts
// apps/backoffice/src/lib/compras.ts
// Estado de abastecimiento de una orden de compra (fila de pedidos). Ver
// docs/superpowers/specs/2026-09-25-despachos-design.md, Parte 1.

export type EstadoCompra = 'por_comprar' | 'comprada' | 'por_retirar' | 'en_camino' | 'directo_al_cliente'
  | 'recibida_parcial' | 'recibida' | 'entregada_al_cliente' | 'anulada';
export type ModalidadCompra = 'retiro' | 'despacho_mayorista' | 'directo_cliente';

export const ESTADOS_COMPRA: EstadoCompra[] = [
  'por_comprar', 'comprada', 'por_retirar', 'en_camino', 'directo_al_cliente',
  'recibida_parcial', 'recibida', 'entregada_al_cliente', 'anulada',
];
export const MODALIDADES_COMPRA: ModalidadCompra[] = ['retiro', 'despacho_mayorista', 'directo_cliente'];
// Estados donde todavia se pueden corregir los datos de la compra.
export const ESTADOS_COMPRA_EDITABLES: EstadoCompra[] = ['comprada', 'por_retirar', 'en_camino', 'directo_al_cliente', 'recibida_parcial'];

// recibida_parcial y recibida no se eligen a mano: las calcula la recepcion.
const TRANSICIONES: Record<EstadoCompra, EstadoCompra[]> = {
  por_comprar: ['comprada', 'anulada'],
  comprada: ['por_retirar', 'en_camino', 'directo_al_cliente', 'anulada'],
  por_retirar: ['anulada'],
  en_camino: ['anulada'],
  directo_al_cliente: ['entregada_al_cliente', 'anulada'],
  recibida_parcial: [],
  recibida: [],
  entregada_al_cliente: [],
  anulada: [],
};
// El paso siguiente a `comprada` lo decide como se compro.
const MODALIDAD_EXIGIDA: Partial<Record<EstadoCompra, ModalidadCompra>> = {
  por_retirar: 'retiro',
  en_camino: 'despacho_mayorista',
  directo_al_cliente: 'directo_cliente',
};

export function transicionCompraValida(desde: EstadoCompra, hacia: EstadoCompra, modalidad: ModalidadCompra | null): boolean {
  if (!(TRANSICIONES[desde]?.includes(hacia) ?? false)) return false;
  const exigida = MODALIDAD_EXIGIDA[hacia];
  return !exigida || exigida === modalidad;
}

export function admiteRecepcion(estado: EstadoCompra, modalidad: ModalidadCompra | null): boolean {
  if (modalidad === 'directo_cliente') return false;
  return ['comprada', 'por_retirar', 'en_camino', 'recibida_parcial'].includes(estado);
}

export function estadoTrasRecepcion(comprado: Map<string, number>, recibido: Map<string, number>): 'recibida' | 'recibida_parcial' {
  for (const [clave, cantidad] of comprado) {
    if ((recibido.get(clave) ?? 0) < cantidad) return 'recibida_parcial';
  }
  return 'recibida';
}

export function compraAtrasada(c: { estado_compra: EstadoCompra; llegada_estimada: string | null }, hoy: string): boolean {
  if (!c.llegada_estimada) return false;
  if (['recibida', 'entregada_al_cliente', 'anulada'].includes(c.estado_compra)) return false;
  return c.llegada_estimada < hoy;
}

export function hoySantiago(ahora: Date = new Date()): string {
  // en-CA formatea como YYYY-MM-DD.
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Santiago' }).format(ahora);
}
```

```ts
// apps/backoffice/src/lib/despachos.ts
// Estados de un despacho al cliente. Ver la spec, Parte 2.

export type EstadoDespacho = 'por_preparar' | 'listo' | 'en_ruta' | 'entregado' | 'fallido' | 'anulado';
export type ModalidadDespacho = 'retiro_oficina' | 'propio' | 'courier';

export const ESTADOS_DESPACHO: EstadoDespacho[] = ['por_preparar', 'listo', 'en_ruta', 'entregado', 'fallido', 'anulado'];
export const MODALIDADES_DESPACHO: ModalidadDespacho[] = ['retiro_oficina', 'propio', 'courier'];
export const ESTADOS_DESPACHO_ACTIVOS: EstadoDespacho[] = ['por_preparar', 'listo', 'en_ruta', 'fallido'];

const TRANSICIONES: Record<EstadoDespacho, EstadoDespacho[]> = {
  por_preparar: ['listo', 'anulado'],
  listo: ['en_ruta', 'entregado', 'anulado'],
  en_ruta: ['entregado', 'fallido'],
  fallido: ['listo', 'anulado'],
  entregado: [],
  anulado: [],
};

export function transicionDespachoValida(desde: EstadoDespacho, hacia: EstadoDespacho, modalidad: ModalidadDespacho): boolean {
  if (!(TRANSICIONES[desde]?.includes(hacia) ?? false)) return false;
  // El retiro en oficina no sale a ruta: de listo pasa a entregado cuando lo
  // retiran. Lo que sale a ruta no se da por entregado sin pasar por ella.
  if (modalidad === 'retiro_oficina' && hacia === 'en_ruta') return false;
  if (modalidad !== 'retiro_oficina' && desde === 'listo' && hacia === 'entregado') return false;
  return true;
}

export function requisitoTransicion(
  d: { modalidad: ModalidadDespacho; numero_seguimiento: string | null },
  hacia: EstadoDespacho,
): string | null {
  if (hacia === 'en_ruta' && d.modalidad === 'courier' && !d.numero_seguimiento?.trim()) {
    return 'Falta el número de seguimiento del courier';
  }
  return null;
}
```

```ts
// apps/backoffice/src/lib/couriers.ts
import type { Despacho } from './lineas.js';

// Registro de couriers. Vive en el backoffice (unico consumidor hoy); se
// mueve a un paquete compartido cuando haya integracion (etapa 3 de la spec).
export type CourierId = 'bluexpress' | 'starken' | 'chilexpress' | 'otro';

export interface Courier {
  id: CourierId;
  nombre: string;
  /** Pagina publica de seguimiento; `conNumero` dice si ya lleva el numero. */
  urlSeguimiento(numero: string): { url: string; conNumero: boolean } | null;
}

// Verificado el 2026-09-25: solo Starken acepta el numero en la URL.
function pagina(url: string) {
  return (numero: string) => (numero.trim() ? { url, conNumero: false } : null);
}

export const COURIERS: Record<CourierId, Courier> = {
  bluexpress: { id: 'bluexpress', nombre: 'Blue Express', urlSeguimiento: pagina('https://www.blue.cl/seguimiento/') },
  starken: {
    id: 'starken', nombre: 'Starken',
    urlSeguimiento: (numero) => {
      const n = numero.trim();
      return n ? { url: `https://www.starken.cl/seguimiento?codigo=${encodeURIComponent(n)}`, conNumero: true } : null;
    },
  },
  chilexpress: { id: 'chilexpress', nombre: 'Chilexpress', urlSeguimiento: pagina('https://www.chilexpress.cl/estado-envio-paquete-courier') },
  otro: { id: 'otro', nombre: 'Otro courier', urlSeguimiento: () => null },
};

export const DIRECCION_RETIRO = 'José M. Infante 2629, Ñuñoa, Santiago';

function fechaDMY(iso: string): string {
  const [a, m, d] = iso.split('-');
  return `${d}-${m}-${a}`;
}

/** Texto para pegar en WhatsApp segun el estado del despacho, o null si no hay nada que avisar. */
export function mensajeCliente(
  d: Pick<Despacho, 'estado' | 'modalidad' | 'courier' | 'numero_seguimiento' | 'fecha_programada'>,
  p: { numeroCotizacion: number | null; contacto: string | null },
): string | null {
  const nombre = p.contacto?.trim().split(/\s+/)[0];
  const hola = nombre ? `Hola ${nombre}, ` : 'Hola, ';
  const pedido = p.numeroCotizacion !== null ? `tu pedido N° ${p.numeroCotizacion}` : 'tu pedido';

  if (d.estado === 'listo' && d.modalidad === 'retiro_oficina') {
    return `${hola}${pedido} está listo para retiro en ${DIRECCION_RETIRO}.`;
  }
  if (d.estado === 'en_ruta' && d.modalidad === 'courier') {
    const courier = COURIERS[d.courier ?? 'otro'];
    const numero = d.numero_seguimiento?.trim() ?? '';
    const base = `${hola}${pedido} va en camino por ${courier.nombre}. N° de seguimiento: ${numero}.`;
    const seg = courier.urlSeguimiento(numero);
    if (seg?.conNumero) return `${base} Síguelo aquí: ${seg.url}`;
    if (seg) return `${base} Puedes seguirlo ingresando ese número en ${seg.url}`;
    return base;
  }
  if (d.estado === 'en_ruta') {
    return `${hola}${pedido} va en camino${d.fecha_programada ? `; te lo entregamos el ${fechaDMY(d.fecha_programada)}` : ''}.`;
  }
  if (d.estado === 'entregado') {
    return `${hola}${pedido} quedó entregado. ¡Gracias por tu compra!`;
  }
  return null;
}
```

```ts
// apps/backoffice/src/lib/lineas.ts
import type { CourierId } from './couriers.js';
import type { EstadoDespacho, ModalidadDespacho } from './despachos.js';
import type { FilaPedido } from './pedidos.js';

// Cantidades por linea de un pedido del cliente, cruzando lo comprado, lo
// recibido y lo asignado a despachos. Una linea se identifica por po_id +
// clave (el mpn). Ver la spec, Parte 2 ("Cantidades por linea").

export interface LineaCompra {
  poId: string; clave: string; nombre: string; cantidad: number;
  /** La despacha el mayorista directo al cliente: no pasa por nuestros despachos. */
  directo: boolean;
  entregadaDirecto: boolean;
}
export interface Recepcion { po_id: string; mpn: string; cantidad: number }
export interface DespachoLinea { po_id: string; mpn: string; cantidad: number }
export interface Despacho {
  id: number; quote_id: string; quote_version: string;
  modalidad: ModalidadDespacho; courier: CourierId | null; estado: EstadoDespacho;
  direccion: string | null; comuna: string | null; ciudad: string | null;
  contacto_nombre: string | null; contacto_telefono: string | null;
  fecha_programada: string | null; responsable: string | null; numero_seguimiento: string | null;
  costo_clp: number | null; cobrado_clp: number | null; cobro_pagado: boolean; nota: string | null;
  created_at: string; entregado_at: string | null;
  lineas: DespachoLinea[];
}
export interface ResumenLinea extends LineaCompra {
  recibida: number; asignada: number; enMano: number; entregada: number; pendiente: number;
}

const EN_MANO: EstadoDespacho[] = ['listo', 'en_ruta', 'entregado'];

export function claveLinea(l: { mpn?: string | null }, indice: number): string {
  return l.mpn ? l.mpn : `linea-${indice}`;
}

const k = (poId: string, clave: string) => `${poId}|${clave}`;

export function lineasDePedido(filas: FilaPedido[]): LineaCompra[] {
  const out: LineaCompra[] = [];
  for (const f of filas) {
    // Una orden de compra anulada no tiene nada que entregar.
    if (f.estado_compra === 'anulada') continue;
    const directo = f.modalidad_compra === 'directo_cliente';
    (f.lineas ?? []).forEach((l, i) => {
      out.push({
        poId: f.po_id,
        clave: claveLinea(l, i),
        nombre: l.nombre ?? l.mpn ?? 'Producto',
        cantidad: Number(l.cantidad ?? 0),
        directo,
        entregadaDirecto: f.estado_compra === 'entregada_al_cliente',
      });
    });
  }
  return out;
}

export function resumirLineas(lineas: LineaCompra[], recepciones: Recepcion[], despachos: Despacho[]): ResumenLinea[] {
  const recibida = new Map<string, number>();
  for (const r of recepciones) recibida.set(k(r.po_id, r.mpn), (recibida.get(k(r.po_id, r.mpn)) ?? 0) + r.cantidad);
  const asignada = new Map<string, number>(), enMano = new Map<string, number>(), entregada = new Map<string, number>();
  const sumar = (m: Map<string, number>, clave: string, n: number) => m.set(clave, (m.get(clave) ?? 0) + n);
  for (const d of despachos) {
    if (d.estado === 'anulado') continue;
    for (const l of d.lineas) {
      const clave = k(l.po_id, l.mpn);
      sumar(asignada, clave, l.cantidad);
      if (EN_MANO.includes(d.estado)) sumar(enMano, clave, l.cantidad);
      if (d.estado === 'entregado') sumar(entregada, clave, l.cantidad);
    }
  }
  return lineas.map((l) => {
    const clave = k(l.poId, l.clave);
    const a = asignada.get(clave) ?? 0;
    return {
      ...l,
      recibida: recibida.get(clave) ?? 0,
      asignada: a,
      enMano: enMano.get(clave) ?? 0,
      entregada: entregada.get(clave) ?? 0,
      pendiente: l.directo ? 0 : Math.max(0, l.cantidad - a),
    };
  });
}

export function validarAsignacion(resumen: ResumenLinea[], pedidas: DespachoLinea[]): string | null {
  if (pedidas.length === 0) return 'El despacho no tiene productos';
  const pedido = new Map<string, number>();
  for (const p of pedidas) pedido.set(k(p.po_id, p.mpn), (pedido.get(k(p.po_id, p.mpn)) ?? 0) + p.cantidad);
  for (const [clave, cantidad] of pedido) {
    const r = resumen.find((l) => k(l.poId, l.clave) === clave);
    if (!r) return `Producto ${clave.split('|')[1]} no está en el pedido`;
    if (r.directo) return `${r.nombre} lo despacha el mayorista directo al cliente`;
    if (cantidad > r.pendiente) return `${r.nombre}: quedan ${r.pendiente} por asignar`;
  }
  return null;
}

export function faltantesParaListo(despacho: Despacho, recepciones: Recepcion[], despachos: Despacho[]): string[] {
  const faltan: string[] = [];
  for (const l of despacho.lineas) {
    const clave = k(l.po_id, l.mpn);
    const recibida = recepciones.filter((r) => k(r.po_id, r.mpn) === clave).reduce((n, r) => n + r.cantidad, 0);
    const deOtros = despachos
      .filter((d) => d.id !== despacho.id && EN_MANO.includes(d.estado))
      .flatMap((d) => d.lineas)
      .filter((x) => k(x.po_id, x.mpn) === clave)
      .reduce((n, x) => n + x.cantidad, 0);
    const disponible = recibida - deOtros;
    if (disponible < l.cantidad) faltan.push(`${l.mpn}: faltan ${l.cantidad - disponible}`);
  }
  return faltan;
}

export function pedidoCompletamenteEntregado(resumen: ResumenLinea[]): boolean {
  if (resumen.length === 0) return false;
  return resumen.every((r) => (r.directo ? r.entregadaDirecto : r.entregada >= r.cantidad));
}
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run apps/backoffice/tests/compras.test.ts apps/backoffice/tests/despachos.test.ts apps/backoffice/tests/lineas.test.ts apps/backoffice/tests/couriers.test.ts && npm run typecheck`
Expected: PASS y typecheck limpio.

- [ ] **Step 6: Commit**

```bash
git add apps/backoffice/src/lib/pedidos.ts apps/backoffice/src/lib/compras.ts apps/backoffice/src/lib/despachos.ts apps/backoffice/src/lib/lineas.ts apps/backoffice/src/lib/couriers.ts apps/backoffice/tests/compras.test.ts apps/backoffice/tests/despachos.test.ts apps/backoffice/tests/lineas.test.ts apps/backoffice/tests/couriers.test.ts
git commit -m "feat(despachos): estados de compra y despacho, cantidades por linea y couriers"
```

---

### Task 4: Lectura de datos del pedido y paso automático a entregado

**Files:**
- Create: `apps/backoffice/src/lib/datos-pedido.ts`, `apps/backoffice/src/lib/entrega.ts`
- Test: `apps/backoffice/tests/datos-pedido.test.ts`, `apps/backoffice/tests/entrega.test.ts`

**Interfaces:**
- Consumes: `supabaseGet`, `supabasePatch`, `supabasePost` (Task 2); tipos y `lineasDePedido`, `resumirLineas`, `pedidoCompletamenteEntregado` (Task 3).
- Produces:
  ```ts
  // datos-pedido.ts
  export interface DatosPedido { filas: FilaPedido[]; recepciones: Recepcion[]; despachos: Despacho[] }
  export function normalizarDespacho(raw: Record<string, unknown>): Despacho;
  export async function cargarDatosPedido(quoteId: string, version: string): Promise<DatosPedido | null>;
  export async function cargarDespacho(id: number): Promise<Despacho | null | undefined>; // undefined = no existe
  export async function registrarEvento(despachoId: number, desde: string | null, hacia: string, nota: string | null): Promise<void>;
  // entrega.ts
  export async function evaluarPedidoEntregado(quoteId: string, version: string): Promise<boolean>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/backoffice/tests/datos-pedido.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarDatosPedido, cargarDespacho, normalizarDespacho } from '../src/lib/datos-pedido.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
function conEnv() { vi.stubEnv('SUPABASE_URL', 'https://supabase.test'); vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave'); }

const DESPACHO_RAW = {
  id: 3, quote_id: 'q', quote_version: '1', modalidad: 'courier', courier: 'starken', estado: 'listo',
  costo_clp: 3500, cobro_pagado: false, created_at: 'x', despacho_lineas: [{ po_id: 'oc-1', mpn: 'A', cantidad: 2 }],
};

describe('normalizarDespacho', () => {
  it('pasa despacho_lineas a lineas y completa lo ausente con null', () => {
    const d = normalizarDespacho(DESPACHO_RAW);
    expect(d.lineas).toEqual([{ po_id: 'oc-1', mpn: 'A', cantidad: 2 }]);
    expect(d.numero_seguimiento).toBeNull();
    expect(d.costo_clp).toBe(3500);
  });
});

describe('cargarDatosPedido', () => {
  it('lee pedidos, recepciones de sus ordenes y despachos con lineas', async () => {
    conEnv();
    const urls: string[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      urls.push(String(url));
      if (String(url).includes('/pedidos?')) return new Response(JSON.stringify([{ po_id: 'oc-1', quote_id: 'q', quote_version: '1', lineas: [] }]));
      if (String(url).includes('/recepciones?')) return new Response(JSON.stringify([{ po_id: 'oc-1', mpn: 'A', cantidad: 1 }]));
      return new Response(JSON.stringify([DESPACHO_RAW]));
    }));
    const datos = await cargarDatosPedido('q', '1');
    expect(datos?.filas).toHaveLength(1);
    expect(datos?.recepciones).toEqual([{ po_id: 'oc-1', mpn: 'A', cantidad: 1 }]);
    expect(datos?.despachos[0].lineas).toHaveLength(1);
    expect(urls.some((u) => u.includes('quote_id=eq.q') && u.includes('quote_version=eq.1'))).toBe(true);
    expect(urls.some((u) => u.includes('/recepciones?') && u.includes('oc-1'))).toBe(true);
    expect(urls.some((u) => u.includes('/despachos?') && u.includes('despacho_lineas'))).toBe(true);
  });
  it('una falla de cualquier lectura devuelve null', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async (url: string) =>
      String(url).includes('/despachos?') ? new Response('{}', { status: 500 }) : new Response('[]')));
    expect(await cargarDatosPedido('q', '1')).toBeNull();
  });
});

describe('cargarDespacho', () => {
  it('undefined si no existe, null si falla la lectura', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')));
    expect(await cargarDespacho(9)).toBeUndefined();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    expect(await cargarDespacho(9)).toBeNull();
  });
});
```

```ts
// apps/backoffice/tests/entrega.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

const cargarDatosPedido = vi.fn();
vi.mock('../src/lib/datos-pedido.js', () => ({ cargarDatosPedido: (...a: unknown[]) => cargarDatosPedido(...a) }));
const supabasePatch = vi.fn();
vi.mock('../src/lib/supabase.js', () => ({ supabasePatch: (...a: unknown[]) => supabasePatch(...a) }));

const { evaluarPedidoEntregado } = await import('../src/lib/entrega.js');

afterEach(() => { cargarDatosPedido.mockReset(); supabasePatch.mockReset(); });

const FILA = { po_id: 'oc-1', quote_id: 'q', quote_version: '1', estado_negocio: 'pagado', estado_compra: 'recibida', modalidad_compra: 'retiro', lineas: [{ mpn: 'A', cantidad: 2 }] };
const despacho = (estado: string, cantidad: number) => ({ id: 1, estado, lineas: [{ po_id: 'oc-1', mpn: 'A', cantidad }] });

describe('evaluarPedidoEntregado', () => {
  it('con todo entregado pasa el pedido pagado a entregado con escritura condicional', async () => {
    cargarDatosPedido.mockResolvedValue({ filas: [FILA], recepciones: [], despachos: [despacho('entregado', 2)] });
    supabasePatch.mockResolvedValue([{}]);
    expect(await evaluarPedidoEntregado('q', '1')).toBe(true);
    const [ruta, cambio] = supabasePatch.mock.calls[0];
    expect(ruta).toContain('estado_negocio=eq.pagado');
    expect(cambio.estado_negocio).toBe('entregado');
    expect(typeof cambio.entregado_at).toBe('string');
  });
  it('con algo pendiente no escribe', async () => {
    cargarDatosPedido.mockResolvedValue({ filas: [FILA], recepciones: [], despachos: [despacho('entregado', 1)] });
    expect(await evaluarPedidoEntregado('q', '1')).toBe(false);
    expect(supabasePatch).not.toHaveBeenCalled();
  });
  it('si el pedido no esta pagado o no se pudo leer, no escribe', async () => {
    cargarDatosPedido.mockResolvedValue({ filas: [{ ...FILA, estado_negocio: 'entregado' }], recepciones: [], despachos: [despacho('entregado', 2)] });
    expect(await evaluarPedidoEntregado('q', '1')).toBe(false);
    cargarDatosPedido.mockResolvedValue(null);
    expect(await evaluarPedidoEntregado('q', '1')).toBe(false);
    expect(supabasePatch).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/backoffice/tests/datos-pedido.test.ts apps/backoffice/tests/entrega.test.ts`
Expected: FAIL — módulos inexistentes.

- [ ] **Step 3: Implement**

```ts
// apps/backoffice/src/lib/datos-pedido.ts
import { supabaseGet, supabasePost } from './supabase.js';
import type { FilaPedido } from './pedidos.js';
import type { Despacho, DespachoLinea, Recepcion } from './lineas.js';

export interface DatosPedido { filas: FilaPedido[]; recepciones: Recepcion[]; despachos: Despacho[] }

const txt = (v: unknown): string | null => (v === null || v === undefined || v === '' ? null : String(v));
const num = (v: unknown): number | null => (v === null || v === undefined || v === '' ? null : Number(v));

export function normalizarDespacho(raw: Record<string, unknown>): Despacho {
  return {
    id: Number(raw.id),
    quote_id: String(raw.quote_id ?? ''),
    quote_version: String(raw.quote_version ?? ''),
    modalidad: raw.modalidad as Despacho['modalidad'],
    courier: (txt(raw.courier) as Despacho['courier']) ?? null,
    estado: raw.estado as Despacho['estado'],
    direccion: txt(raw.direccion), comuna: txt(raw.comuna), ciudad: txt(raw.ciudad),
    contacto_nombre: txt(raw.contacto_nombre), contacto_telefono: txt(raw.contacto_telefono),
    fecha_programada: txt(raw.fecha_programada), responsable: txt(raw.responsable),
    numero_seguimiento: txt(raw.numero_seguimiento),
    costo_clp: num(raw.costo_clp), cobrado_clp: num(raw.cobrado_clp),
    cobro_pagado: raw.cobro_pagado === true,
    nota: txt(raw.nota),
    created_at: String(raw.created_at ?? ''),
    entregado_at: txt(raw.entregado_at),
    lineas: ((raw.despacho_lineas ?? raw.lineas ?? []) as DespachoLinea[]).map((l) => ({
      po_id: String(l.po_id), mpn: String(l.mpn), cantidad: Number(l.cantidad),
    })),
  };
}

const enLista = (valores: string[]) => encodeURIComponent(valores.map((v) => `"${v}"`).join(','));

export async function cargarDatosPedido(quoteId: string, version: string): Promise<DatosPedido | null> {
  const filtro = `quote_id=eq.${encodeURIComponent(quoteId)}&quote_version=eq.${encodeURIComponent(version)}`;
  const filas = await supabaseGet(`/pedidos?select=*&${filtro}`);
  if (filas === null) return null;
  const poIds = (filas as FilaPedido[]).map((f) => f.po_id);
  const recepciones = poIds.length > 0
    ? await supabaseGet(`/recepciones?select=po_id,mpn,cantidad&po_id=in.(${enLista(poIds)})`)
    : [];
  if (recepciones === null) return null;
  const despachos = await supabaseGet(`/despachos?select=*,despacho_lineas(po_id,mpn,cantidad)&${filtro}&order=id.asc`);
  if (despachos === null) return null;
  return {
    filas: filas as FilaPedido[],
    recepciones: (recepciones as Recepcion[]).map((r) => ({ po_id: r.po_id, mpn: r.mpn, cantidad: Number(r.cantidad) })),
    despachos: (despachos as Record<string, unknown>[]).map(normalizarDespacho),
  };
}

export async function cargarDespacho(id: number): Promise<Despacho | null | undefined> {
  const filas = await supabaseGet(`/despachos?select=*,despacho_lineas(po_id,mpn,cantidad)&id=eq.${id}&limit=1`);
  if (filas === null) return null;
  if (filas.length === 0) return undefined;
  return normalizarDespacho(filas[0] as Record<string, unknown>);
}

// El historial es de mejor esfuerzo: si no se pudo escribir, el cambio de
// estado ya ocurrio y no se deshace; queda en el log.
export async function registrarEvento(despachoId: number, desde: string | null, hacia: string, nota: string | null): Promise<void> {
  const ok = await supabasePost('/despacho_eventos', { despacho_id: despachoId, desde, hacia, nota });
  if (ok === null) console.error('[despachos] no se pudo registrar el evento', { despachoId, desde, hacia });
}
```

```ts
// apps/backoffice/src/lib/entrega.ts
import { cargarDatosPedido } from './datos-pedido.js';
import { lineasDePedido, pedidoCompletamenteEntregado, resumirLineas } from './lineas.js';
import { supabasePatch } from './supabase.js';

/**
 * Pasa el pedido a `entregado` cuando todo lo que compro el cliente ya le
 * llego, por nuestros despachos o directo del mayorista. De mejor esfuerzo:
 * si falla, el boton manual sigue disponible.
 */
export async function evaluarPedidoEntregado(quoteId: string, version: string): Promise<boolean> {
  const datos = await cargarDatosPedido(quoteId, version);
  if (!datos) {
    console.error('[entrega] no se pudo leer el pedido para evaluarlo', { quoteId, version });
    return false;
  }
  if (datos.filas[0]?.estado_negocio !== 'pagado') return false;
  const resumen = resumirLineas(lineasDePedido(datos.filas), datos.recepciones, datos.despachos);
  if (!pedidoCompletamenteEntregado(resumen)) return false;
  const filtro = `quote_id=eq.${encodeURIComponent(quoteId)}&quote_version=eq.${encodeURIComponent(version)}&estado_negocio=eq.pagado`;
  const filas = await supabasePatch(`/pedidos?${filtro}`, { estado_negocio: 'entregado', entregado_at: new Date().toISOString() });
  return filas !== null && filas.length > 0;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/backoffice/tests/datos-pedido.test.ts apps/backoffice/tests/entrega.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backoffice/src/lib/datos-pedido.ts apps/backoffice/src/lib/entrega.ts apps/backoffice/tests/datos-pedido.test.ts apps/backoffice/tests/entrega.test.ts
git commit -m "feat(despachos): lectura de un pedido con recepciones y despachos, y paso automatico a entregado"
```

---

### Task 5: Rutas de compras

**Files:**
- Create: `apps/backoffice/app/api/compras/registrar/route.ts`, `app/api/compras/transicion/route.ts`, `app/api/compras/recepcion/route.ts`
- Test: `apps/backoffice/tests/api-compras.test.ts`

**Interfaces:**
- Consumes: `supabaseGet`, `supabasePatch`, `supabasePost` (Task 2); `transicionCompraValida`, `admiteRecepcion`, `estadoTrasRecepcion`, `ESTADOS_COMPRA`, `MODALIDADES_COMPRA`, `ESTADOS_COMPRA_EDITABLES` (Task 3); `claveLinea` (Task 3); `evaluarPedidoEntregado` (Task 4).
- Produces: `POST /api/compras/registrar` `{ po_id, modalidad?, numero_pedido_mayorista?, llegada_estimada?, guia_mayorista?, nota_compra? }`; `POST /api/compras/transicion` `{ po_id, hacia }`; `POST /api/compras/recepcion` `{ po_id, mpn, cantidad, nota? }`. Todas responden JSON `{ ok: true, estado }` o `{ error, ... }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backoffice/tests/api-compras.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

const supabaseGet = vi.fn(), supabasePatch = vi.fn(), supabasePost = vi.fn();
vi.mock('../src/lib/supabase.js', () => ({
  supabaseGet: (...a: unknown[]) => supabaseGet(...a),
  supabasePatch: (...a: unknown[]) => supabasePatch(...a),
  supabasePost: (...a: unknown[]) => supabasePost(...a),
}));
const evaluarPedidoEntregado = vi.fn(async (..._a: unknown[]) => true);
vi.mock('../src/lib/entrega.js', () => ({ evaluarPedidoEntregado: (...a: unknown[]) => evaluarPedidoEntregado(...a) }));

const { POST: registrar } = await import('../app/api/compras/registrar/route.js');
const { POST: transicion } = await import('../app/api/compras/transicion/route.js');
const { POST: recepcion } = await import('../app/api/compras/recepcion/route.js');

afterEach(() => { vi.clearAllMocks(); });
const req = (body: unknown) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });
const OC = { po_id: 'oc-1', quote_id: 'q', quote_version: '1', estado_compra: 'por_comprar', modalidad_compra: null, lineas: [{ mpn: 'A', cantidad: 2 }, { mpn: 'B', cantidad: 1 }] };

describe('POST /api/compras/registrar', () => {
  it('desde por_comprar exige modalidad y numero, y pasa a comprada con escritura condicional', async () => {
    supabaseGet.mockResolvedValue([OC]);
    supabasePatch.mockResolvedValue([{}]);
    expect((await registrar(req({ po_id: 'oc-1', modalidad: 'retiro' }))).status).toBe(400);
    const res = await registrar(req({ po_id: 'oc-1', modalidad: 'retiro', numero_pedido_mayorista: 'INT-99', llegada_estimada: '2026-09-30' }));
    expect(res.status).toBe(200);
    const [ruta, cambio] = supabasePatch.mock.calls[0];
    expect(ruta).toContain('estado_compra=eq.por_comprar');
    expect(cambio).toMatchObject({ estado_compra: 'comprada', modalidad_compra: 'retiro', numero_pedido_mayorista: 'INT-99', llegada_estimada: '2026-09-30' });
    expect(typeof cambio.comprada_at).toBe('string');
  });
  it('en un estado editable corrige datos sin cambiar el estado; la modalidad solo en comprada', async () => {
    supabaseGet.mockResolvedValue([{ ...OC, estado_compra: 'en_camino', modalidad_compra: 'despacho_mayorista' }]);
    supabasePatch.mockResolvedValue([{}]);
    await registrar(req({ po_id: 'oc-1', guia_mayorista: 'G-1', modalidad: 'retiro' }));
    const cambio = supabasePatch.mock.calls[0][1];
    expect(cambio).toEqual({ guia_mayorista: 'G-1' });
  });
  it('409 si la compra esta cerrada; 404 si no existe; 400 con modalidad invalida', async () => {
    supabaseGet.mockResolvedValue([{ ...OC, estado_compra: 'recibida' }]);
    expect((await registrar(req({ po_id: 'oc-1', nota_compra: 'x' }))).status).toBe(409);
    supabaseGet.mockResolvedValue([]);
    expect((await registrar(req({ po_id: 'oc-1', modalidad: 'retiro', numero_pedido_mayorista: '1' }))).status).toBe(404);
    expect((await registrar(req({ po_id: 'oc-1', modalidad: 'avion' }))).status).toBe(400);
  });
});

describe('POST /api/compras/transicion', () => {
  it('valida contra la modalidad y escribe condicional', async () => {
    supabaseGet.mockResolvedValue([{ ...OC, estado_compra: 'comprada', modalidad_compra: 'retiro' }]);
    supabasePatch.mockResolvedValue([{}]);
    expect((await transicion(req({ po_id: 'oc-1', hacia: 'en_camino' }))).status).toBe(409);
    expect((await transicion(req({ po_id: 'oc-1', hacia: 'por_retirar' }))).status).toBe(200);
    expect(supabasePatch.mock.calls[0][0]).toContain('estado_compra=eq.comprada');
  });
  it('comprada no se alcanza por aqui (va por registrar) y la misma transicion no escribe', async () => {
    supabaseGet.mockResolvedValue([{ ...OC, estado_compra: 'por_retirar', modalidad_compra: 'retiro' }]);
    expect((await transicion(req({ po_id: 'oc-1', hacia: 'comprada' }))).status).toBe(400);
    expect((await transicion(req({ po_id: 'oc-1', hacia: 'por_retirar' }))).status).toBe(200);
    expect(supabasePatch).not.toHaveBeenCalled();
  });
  it('entregada_al_cliente evalua si el pedido quedo entregado', async () => {
    supabaseGet.mockResolvedValue([{ ...OC, estado_compra: 'directo_al_cliente', modalidad_compra: 'directo_cliente' }]);
    supabasePatch.mockResolvedValue([{}]);
    expect((await transicion(req({ po_id: 'oc-1', hacia: 'entregada_al_cliente' }))).status).toBe(200);
    expect(evaluarPedidoEntregado).toHaveBeenCalledWith('q', '1');
  });
  it('carrera: el PATCH condicional no afecta filas -> 409', async () => {
    supabaseGet.mockResolvedValue([{ ...OC, estado_compra: 'comprada', modalidad_compra: 'retiro' }]);
    supabasePatch.mockResolvedValue([]);
    expect((await transicion(req({ po_id: 'oc-1', hacia: 'por_retirar' }))).status).toBe(409);
  });
});

describe('POST /api/compras/recepcion', () => {
  const conDatos = (estado: string, recibidas: unknown[]) => {
    supabaseGet.mockImplementation(async (ruta: string) =>
      ruta.startsWith('/pedidos') ? [{ ...OC, estado_compra: estado, modalidad_compra: 'retiro' }] : recibidas);
  };
  it('registra la recepcion y pasa a recibida_parcial', async () => {
    conDatos('por_retirar', []);
    supabasePost.mockResolvedValue([{ id: 1 }]);
    supabasePatch.mockResolvedValue([{}]);
    const res = await recepcion(req({ po_id: 'oc-1', mpn: 'A', cantidad: 2 }));
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ estado: 'recibida_parcial' });
    expect(supabasePost.mock.calls[0]).toEqual(['/recepciones', { po_id: 'oc-1', mpn: 'A', cantidad: 2, nota: null }]);
    expect(supabasePatch.mock.calls[0][0]).toContain('estado_compra=eq.por_retirar');
  });
  it('completa la compra: recibida', async () => {
    conDatos('recibida_parcial', [{ mpn: 'A', cantidad: 2 }]);
    supabasePost.mockResolvedValue([{ id: 2 }]);
    supabasePatch.mockResolvedValue([{}]);
    expect(await (await recepcion(req({ po_id: 'oc-1', mpn: 'B', cantidad: 1 }))).json()).toMatchObject({ estado: 'recibida' });
  });
  it('rechaza recibir mas de lo comprado, lineas ajenas y estados que no admiten recepcion', async () => {
    conDatos('por_retirar', [{ mpn: 'A', cantidad: 2 }]);
    expect((await recepcion(req({ po_id: 'oc-1', mpn: 'A', cantidad: 1 }))).status).toBe(409);
    expect((await recepcion(req({ po_id: 'oc-1', mpn: 'Z', cantidad: 1 }))).status).toBe(400);
    conDatos('por_comprar', []);
    expect((await recepcion(req({ po_id: 'oc-1', mpn: 'A', cantidad: 1 }))).status).toBe(409);
    expect((await recepcion(req({ po_id: 'oc-1', mpn: 'A', cantidad: 0 }))).status).toBe(400);
    expect(supabasePost).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backoffice/tests/api-compras.test.ts`
Expected: FAIL — las rutas no existen.

- [ ] **Step 3: Implement**

```ts
// apps/backoffice/app/api/compras/registrar/route.ts
import { supabaseGet, supabasePatch } from '../../../../src/lib/supabase.js';
import { ESTADOS_COMPRA_EDITABLES, MODALIDADES_COMPRA, type EstadoCompra, type ModalidadCompra } from '../../../../src/lib/compras.js';

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : null);
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

// Registra la compra hecha en el portal del mayorista (por_comprar ->
// comprada) o corrige sus datos despues. La modalidad solo se cambia
// mientras la compra no avanzo de `comprada`.
export async function POST(req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const poId = texto(b?.po_id);
  if (!poId) return json({ error: 'cuerpo_invalido' }, 400);
  const modalidad = texto(b?.modalidad) as ModalidadCompra | null;
  if (modalidad && !MODALIDADES_COMPRA.includes(modalidad)) return json({ error: 'modalidad_invalida' }, 400);
  const llegada = texto(b?.llegada_estimada);
  if (llegada && !FECHA.test(llegada)) return json({ error: 'fecha_invalida' }, 400);

  const filas = await supabaseGet(`/pedidos?po_id=eq.${encodeURIComponent(poId)}&select=estado_compra,modalidad_compra&limit=1`);
  if (filas === null) return json({ error: 'upstream' }, 503);
  const actual = (filas[0] as { estado_compra?: EstadoCompra } | undefined)?.estado_compra;
  if (actual === undefined) return json({ error: 'compra_no_encontrada' }, 404);

  const datos: Record<string, unknown> = {};
  for (const campo of ['numero_pedido_mayorista', 'guia_mayorista', 'nota_compra'] as const) {
    if (b && campo in b) datos[campo] = texto(b[campo]);
  }
  if (b && 'llegada_estimada' in b) datos.llegada_estimada = llegada;

  if (actual === 'por_comprar') {
    if (!modalidad || !datos.numero_pedido_mayorista) return json({ error: 'faltan_datos', detalle: 'Modalidad y número de pedido del mayorista son obligatorios' }, 400);
    const cambio = { ...datos, estado_compra: 'comprada', modalidad_compra: modalidad, comprada_at: new Date().toISOString() };
    const res = await supabasePatch(`/pedidos?po_id=eq.${encodeURIComponent(poId)}&estado_compra=eq.por_comprar`, cambio);
    if (res === null) return json({ error: 'upstream' }, 503);
    if (res.length === 0) return json({ error: 'transicion_invalida', desde: actual }, 409);
    return json({ ok: true, estado: 'comprada' });
  }

  if (!ESTADOS_COMPRA_EDITABLES.includes(actual)) return json({ error: 'compra_cerrada', estado: actual }, 409);
  if (modalidad && actual === 'comprada') datos.modalidad_compra = modalidad;
  if (Object.keys(datos).length === 0) return json({ ok: true, estado: actual });
  const res = await supabasePatch(`/pedidos?po_id=eq.${encodeURIComponent(poId)}&estado_compra=eq.${actual}`, datos);
  if (res === null) return json({ error: 'upstream' }, 503);
  if (res.length === 0) return json({ error: 'transicion_invalida', desde: actual }, 409);
  return json({ ok: true, estado: actual });
}
```

```ts
// apps/backoffice/app/api/compras/transicion/route.ts
import { supabaseGet, supabasePatch } from '../../../../src/lib/supabase.js';
import { ESTADOS_COMPRA, transicionCompraValida, type EstadoCompra, type ModalidadCompra } from '../../../../src/lib/compras.js';
import { evaluarPedidoEntregado } from '../../../../src/lib/entrega.js';

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

export async function POST(req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as { po_id?: string; hacia?: string } | null;
  const poId = String(b?.po_id ?? '');
  const hacia = String(b?.hacia ?? '') as EstadoCompra;
  if (!poId || !ESTADOS_COMPRA.includes(hacia)) return json({ error: 'cuerpo_invalido' }, 400);
  // comprada exige datos (modalidad, numero): va por /api/compras/registrar.
  // recibida_parcial y recibida las calcula la recepcion.
  if (hacia === 'comprada' || hacia === 'recibida_parcial' || hacia === 'recibida') return json({ error: 'usar_otra_ruta' }, 400);

  const filas = await supabaseGet(`/pedidos?po_id=eq.${encodeURIComponent(poId)}&select=quote_id,quote_version,estado_compra,modalidad_compra&limit=1`);
  if (filas === null) return json({ error: 'upstream' }, 503);
  const f = filas[0] as { quote_id: string; quote_version: string; estado_compra: EstadoCompra; modalidad_compra: ModalidadCompra | null } | undefined;
  if (!f) return json({ error: 'compra_no_encontrada' }, 404);
  if (f.estado_compra === hacia) return json({ ok: true, estado: hacia });
  if (!transicionCompraValida(f.estado_compra, hacia, f.modalidad_compra)) {
    return json({ error: 'transicion_invalida', desde: f.estado_compra }, 409);
  }

  const res = await supabasePatch(
    `/pedidos?po_id=eq.${encodeURIComponent(poId)}&estado_compra=eq.${f.estado_compra}`,
    { estado_compra: hacia },
  );
  if (res === null) return json({ error: 'upstream' }, 503);
  if (res.length === 0) return json({ error: 'transicion_invalida', desde: f.estado_compra }, 409);
  if (hacia === 'entregada_al_cliente') await evaluarPedidoEntregado(f.quote_id, f.quote_version);
  return json({ ok: true, estado: hacia });
}
```

```ts
// apps/backoffice/app/api/compras/recepcion/route.ts
import { supabaseGet, supabasePatch, supabasePost } from '../../../../src/lib/supabase.js';
import { admiteRecepcion, estadoTrasRecepcion, type EstadoCompra, type ModalidadCompra } from '../../../../src/lib/compras.js';
import { claveLinea } from '../../../../src/lib/lineas.js';

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

// Registra lo que llego de una linea y recalcula el estado de la compra.
export async function POST(req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as { po_id?: string; mpn?: string; cantidad?: number; nota?: string } | null;
  const poId = String(b?.po_id ?? '');
  const mpn = String(b?.mpn ?? '');
  const cantidad = Number(b?.cantidad);
  if (!poId || !mpn || !Number.isInteger(cantidad) || cantidad <= 0) return json({ error: 'cuerpo_invalido' }, 400);

  const filas = await supabaseGet(`/pedidos?po_id=eq.${encodeURIComponent(poId)}&select=lineas,estado_compra,modalidad_compra&limit=1`);
  if (filas === null) return json({ error: 'upstream' }, 503);
  const f = filas[0] as { lineas: Array<{ mpn?: string | null; cantidad?: number }>; estado_compra: EstadoCompra; modalidad_compra: ModalidadCompra | null } | undefined;
  if (!f) return json({ error: 'compra_no_encontrada' }, 404);
  if (!admiteRecepcion(f.estado_compra, f.modalidad_compra)) return json({ error: 'no_admite_recepcion', estado: f.estado_compra }, 409);

  const comprado = new Map<string, number>();
  (f.lineas ?? []).forEach((l, i) => comprado.set(claveLinea(l, i), Number(l.cantidad ?? 0)));
  if (!comprado.has(mpn)) return json({ error: 'linea_desconocida' }, 400);

  const previas = await supabaseGet(`/recepciones?po_id=eq.${encodeURIComponent(poId)}&select=mpn,cantidad`);
  if (previas === null) return json({ error: 'upstream' }, 503);
  const recibido = new Map<string, number>();
  for (const r of previas as Array<{ mpn: string; cantidad: number }>) recibido.set(r.mpn, (recibido.get(r.mpn) ?? 0) + Number(r.cantidad));
  const pendiente = (comprado.get(mpn) ?? 0) - (recibido.get(mpn) ?? 0);
  if (cantidad > pendiente) return json({ error: 'excede_comprado', pendiente }, 409);

  const nota = typeof b?.nota === 'string' && b.nota.trim() ? b.nota.trim() : null;
  const creada = await supabasePost('/recepciones', { po_id: poId, mpn, cantidad, nota });
  if (creada === null) return json({ error: 'upstream' }, 503);

  recibido.set(mpn, (recibido.get(mpn) ?? 0) + cantidad);
  const nuevo = estadoTrasRecepcion(comprado, recibido);
  if (nuevo !== f.estado_compra) {
    // Condicional: si otra recepcion ya lo movio, su escritura manda; la
    // recepcion quedo registrada igual.
    await supabasePatch(`/pedidos?po_id=eq.${encodeURIComponent(poId)}&estado_compra=eq.${f.estado_compra}`, { estado_compra: nuevo });
  }
  return json({ ok: true, estado: nuevo });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/backoffice/tests/api-compras.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backoffice/app/api/compras apps/backoffice/tests/api-compras.test.ts
git commit -m "feat(despachos): rutas para registrar compras, avanzarlas y recibir mercaderia"
```

---

### Task 6: Rutas de despachos

**Files:**
- Create: `apps/backoffice/app/api/despachos/route.ts`, `app/api/despachos/editar/route.ts`, `app/api/despachos/transicion/route.ts`
- Test: `apps/backoffice/tests/api-despachos.test.ts`

**Interfaces:**
- Consumes: `cargarDatosPedido`, `cargarDespacho`, `registrarEvento` (Task 4); `evaluarPedidoEntregado` (Task 4); `supabaseRpc`, `supabasePatch` (Task 2); `lineasDePedido`, `resumirLineas`, `validarAsignacion`, `faltantesParaListo` (Task 3); `MODALIDADES_DESPACHO`, `ESTADOS_DESPACHO`, `transicionDespachoValida`, `requisitoTransicion` (Task 3); `COURIERS` (Task 3).
- Produces: `POST /api/despachos` → 201 `{ ok, id }`; `POST /api/despachos/editar` `{ id, ...campos }`; `POST /api/despachos/transicion` `{ id, hacia, nota? }`.

- [ ] **Step 1: Write the failing test**

```ts
// apps/backoffice/tests/api-despachos.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';

const cargarDatosPedido = vi.fn(), cargarDespacho = vi.fn(), registrarEvento = vi.fn(async (..._a: unknown[]) => {});
vi.mock('../src/lib/datos-pedido.js', () => ({
  cargarDatosPedido: (...a: unknown[]) => cargarDatosPedido(...a),
  cargarDespacho: (...a: unknown[]) => cargarDespacho(...a),
  registrarEvento: (...a: unknown[]) => registrarEvento(...a),
}));
const supabaseRpc = vi.fn(), supabasePatch = vi.fn();
vi.mock('../src/lib/supabase.js', () => ({
  supabaseRpc: (...a: unknown[]) => supabaseRpc(...a),
  supabasePatch: (...a: unknown[]) => supabasePatch(...a),
}));
const evaluarPedidoEntregado = vi.fn(async (..._a: unknown[]) => true);
vi.mock('../src/lib/entrega.js', () => ({ evaluarPedidoEntregado: (...a: unknown[]) => evaluarPedidoEntregado(...a) }));

const { POST: crear } = await import('../app/api/despachos/route.js');
const { POST: editar } = await import('../app/api/despachos/editar/route.js');
const { POST: transicion } = await import('../app/api/despachos/transicion/route.js');

afterEach(() => { vi.clearAllMocks(); });
const req = (body: unknown) => new Request('http://x/api', { method: 'POST', body: JSON.stringify(body) });

const FILA = { po_id: 'oc-1', quote_id: 'q', quote_version: '1', estado_negocio: 'pagado', estado_compra: 'recibida', modalidad_compra: 'retiro', lineas: [{ mpn: 'A', nombre: 'Toner A', cantidad: 2 }] };
const DESPACHO = {
  id: 5, quote_id: 'q', quote_version: '1', modalidad: 'courier', courier: 'starken', estado: 'por_preparar',
  numero_seguimiento: null, lineas: [{ po_id: 'oc-1', mpn: 'A', cantidad: 2 }],
};

describe('POST /api/despachos', () => {
  const cuerpo = { quote_id: 'q', quote_version: '1', modalidad: 'courier', courier: 'starken', comuna: 'Ñuñoa', lineas: [{ po_id: 'oc-1', mpn: 'A', cantidad: 1 }] };
  it('valida la asignacion con datos frescos y crea por RPC', async () => {
    cargarDatosPedido.mockResolvedValue({ filas: [FILA], recepciones: [], despachos: [] });
    supabaseRpc.mockResolvedValue({ id: 9 });
    const res = await crear(req(cuerpo));
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ ok: true, id: 9 });
    const [fn, args] = supabaseRpc.mock.calls[0];
    expect(fn).toBe('crear_despacho');
    expect(args.p_lineas).toEqual([{ po_id: 'oc-1', mpn: 'A', cantidad: 1 }]);
    expect(args.p_despacho).toMatchObject({ quote_id: 'q', modalidad: 'courier', courier: 'starken', comuna: 'Ñuñoa' });
  });
  it('409 si se asigna mas de lo pendiente o el pedido no esta pagado', async () => {
    cargarDatosPedido.mockResolvedValue({ filas: [FILA], recepciones: [], despachos: [{ ...DESPACHO, lineas: [{ po_id: 'oc-1', mpn: 'A', cantidad: 2 }] }] });
    expect((await crear(req(cuerpo))).status).toBe(409);
    cargarDatosPedido.mockResolvedValue({ filas: [{ ...FILA, estado_negocio: 'nuevo' }], recepciones: [], despachos: [] });
    expect((await crear(req(cuerpo))).status).toBe(409);
    expect(supabaseRpc).not.toHaveBeenCalled();
  });
  it('400 por modalidad invalida, courier faltante o cantidades no enteras', async () => {
    expect((await crear(req({ ...cuerpo, modalidad: 'dron' }))).status).toBe(400);
    expect((await crear(req({ ...cuerpo, courier: undefined }))).status).toBe(400);
    expect((await crear(req({ ...cuerpo, lineas: [{ po_id: 'oc-1', mpn: 'A', cantidad: 1.5 }] }))).status).toBe(400);
  });
});

describe('POST /api/despachos/transicion', () => {
  it('listo exige la mercaderia recibida', async () => {
    cargarDespacho.mockResolvedValue(DESPACHO);
    cargarDatosPedido.mockResolvedValue({ filas: [FILA], recepciones: [{ po_id: 'oc-1', mpn: 'A', cantidad: 1 }], despachos: [DESPACHO] });
    const res = await transicion(req({ id: 5, hacia: 'listo' }));
    expect(res.status).toBe(409);
    expect((await res.json()).faltan).toEqual(['A: faltan 1']);
    cargarDatosPedido.mockResolvedValue({ filas: [FILA], recepciones: [{ po_id: 'oc-1', mpn: 'A', cantidad: 2 }], despachos: [DESPACHO] });
    supabasePatch.mockResolvedValue([{}]);
    expect((await transicion(req({ id: 5, hacia: 'listo' }))).status).toBe(200);
    expect(supabasePatch.mock.calls[0][0]).toContain('estado=eq.por_preparar');
    expect(registrarEvento).toHaveBeenCalledWith(5, 'por_preparar', 'listo', null);
  });
  it('courier en ruta sin seguimiento -> 409 falta_dato', async () => {
    cargarDespacho.mockResolvedValue({ ...DESPACHO, estado: 'listo' });
    expect((await transicion(req({ id: 5, hacia: 'en_ruta' }))).status).toBe(409);
  });
  it('entregado estampa la fecha y evalua el pedido', async () => {
    cargarDespacho.mockResolvedValue({ ...DESPACHO, estado: 'en_ruta', numero_seguimiento: '1' });
    supabasePatch.mockResolvedValue([{}]);
    expect((await transicion(req({ id: 5, hacia: 'entregado' }))).status).toBe(200);
    expect(typeof supabasePatch.mock.calls[0][1].entregado_at).toBe('string');
    expect(evaluarPedidoEntregado).toHaveBeenCalledWith('q', '1');
  });
  it('404 si no existe, 409 por transicion invalida o carrera', async () => {
    cargarDespacho.mockResolvedValue(undefined);
    expect((await transicion(req({ id: 5, hacia: 'listo' }))).status).toBe(404);
    cargarDespacho.mockResolvedValue({ ...DESPACHO, estado: 'entregado' });
    expect((await transicion(req({ id: 5, hacia: 'anulado' }))).status).toBe(409);
    cargarDespacho.mockResolvedValue({ ...DESPACHO, estado: 'en_ruta', numero_seguimiento: '1' });
    supabasePatch.mockResolvedValue([]);
    expect((await transicion(req({ id: 5, hacia: 'fallido' }))).status).toBe(409);
  });
});

describe('POST /api/despachos/editar', () => {
  it('actualiza solo campos permitidos; costo y cobro se editan incluso entregado', async () => {
    cargarDespacho.mockResolvedValue({ ...DESPACHO, estado: 'entregado' });
    supabasePatch.mockResolvedValue([{}]);
    expect((await editar(req({ id: 5, cobro_pagado: true, cobrado_clp: 4000, estado: 'listo' }))).status).toBe(200);
    const cambio = supabasePatch.mock.calls[0][1];
    expect(cambio).toMatchObject({ cobro_pagado: true, cobrado_clp: 4000 });
    expect(cambio.estado).toBeUndefined();
    expect((await editar(req({ id: 5, direccion: 'Otra 123' }))).status).toBe(409);
  });
  it('400 con montos negativos o fecha invalida', async () => {
    cargarDespacho.mockResolvedValue(DESPACHO);
    expect((await editar(req({ id: 5, costo_clp: -1 }))).status).toBe(400);
    expect((await editar(req({ id: 5, fecha_programada: 'mañana' }))).status).toBe(400);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run apps/backoffice/tests/api-despachos.test.ts`
Expected: FAIL — rutas inexistentes.

- [ ] **Step 3: Implement**

```ts
// apps/backoffice/app/api/despachos/route.ts
import { cargarDatosPedido } from '../../../src/lib/datos-pedido.js';
import { MODALIDADES_DESPACHO, type ModalidadDespacho } from '../../../src/lib/despachos.js';
import { COURIERS, type CourierId } from '../../../src/lib/couriers.js';
import { lineasDePedido, resumirLineas, validarAsignacion, type DespachoLinea } from '../../../src/lib/lineas.js';
import { supabaseRpc } from '../../../src/lib/supabase.js';

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
const texto = (v: unknown) => (typeof v === 'string' && v.trim() ? v.trim() : '');
const FECHA = /^\d{4}-\d{2}-\d{2}$/;
const monto = (v: unknown) => (v === undefined || v === null || v === '' ? '' : Number(v));

export async function POST(req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const quoteId = texto(b?.quote_id), version = texto(b?.quote_version);
  const modalidad = texto(b?.modalidad) as ModalidadDespacho;
  const courier = texto(b?.courier) as CourierId | '';
  const lineas = Array.isArray(b?.lineas) ? (b!.lineas as DespachoLinea[]) : [];
  if (!quoteId || !version || !MODALIDADES_DESPACHO.includes(modalidad)) return json({ error: 'cuerpo_invalido' }, 400);
  if (modalidad === 'courier' && !(courier && courier in COURIERS)) return json({ error: 'falta_courier' }, 400);
  if (lineas.some((l) => !texto(l?.po_id) || !texto(l?.mpn) || !Number.isInteger(l?.cantidad) || l.cantidad <= 0)) {
    return json({ error: 'lineas_invalidas' }, 400);
  }
  const fecha = texto(b?.fecha_programada);
  if (fecha && !FECHA.test(fecha)) return json({ error: 'fecha_invalida' }, 400);
  const costo = monto(b?.costo_clp), cobrado = monto(b?.cobrado_clp);
  for (const m of [costo, cobrado]) if (m !== '' && (!Number.isInteger(m) || m < 0)) return json({ error: 'monto_invalido' }, 400);

  const datos = await cargarDatosPedido(quoteId, version);
  if (!datos) return json({ error: 'upstream' }, 503);
  if (datos.filas.length === 0) return json({ error: 'pedido_no_encontrado' }, 404);
  if (datos.filas[0].estado_negocio !== 'pagado') return json({ error: 'pedido_no_pagado' }, 409);
  const resumen = resumirLineas(lineasDePedido(datos.filas), datos.recepciones, datos.despachos);
  const detalle = validarAsignacion(resumen, lineas);
  if (detalle) return json({ error: 'asignacion_invalida', detalle }, 409);

  const creado = await supabaseRpc('crear_despacho', {
    p_despacho: {
      quote_id: quoteId, quote_version: version, modalidad,
      courier: modalidad === 'courier' ? courier : '',
      direccion: texto(b?.direccion), comuna: texto(b?.comuna), ciudad: texto(b?.ciudad),
      contacto_nombre: texto(b?.contacto_nombre), contacto_telefono: texto(b?.contacto_telefono),
      fecha_programada: fecha, responsable: texto(b?.responsable),
      costo_clp: costo === '' ? '' : String(costo), cobrado_clp: cobrado === '' ? '' : String(cobrado),
      nota: texto(b?.nota),
    },
    p_lineas: lineas.map((l) => ({ po_id: l.po_id, mpn: l.mpn, cantidad: l.cantidad })),
  });
  if (creado === null) return json({ error: 'upstream' }, 503);
  return json({ ok: true, id: Number((creado as { id: number }).id) }, 201);
}
```

```ts
// apps/backoffice/app/api/despachos/editar/route.ts
import { cargarDespacho } from '../../../../src/lib/datos-pedido.js';
import { COURIERS } from '../../../../src/lib/couriers.js';
import { supabasePatch } from '../../../../src/lib/supabase.js';

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });
const FECHA = /^\d{4}-\d{2}-\d{2}$/;

// Siempre editables (el cobro del envio puede pagarse despues de entregar).
const SIEMPRE = ['costo_clp', 'cobrado_clp', 'cobro_pagado', 'nota'] as const;
// Solo mientras el despacho no esta cerrado.
const MIENTRAS_ABIERTO = [
  'courier', 'direccion', 'comuna', 'ciudad', 'contacto_nombre', 'contacto_telefono',
  'fecha_programada', 'responsable', 'numero_seguimiento',
] as const;

export async function POST(req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const id = Number(b?.id);
  if (!Number.isInteger(id) || id <= 0) return json({ error: 'cuerpo_invalido' }, 400);

  const cambio: Record<string, unknown> = {};
  for (const campo of [...SIEMPRE, ...MIENTRAS_ABIERTO]) {
    if (!b || !(campo in b)) continue;
    const v = b[campo];
    if (campo === 'cobro_pagado') { cambio[campo] = v === true; continue; }
    if (campo === 'costo_clp' || campo === 'cobrado_clp') {
      if (v === null || v === '') { cambio[campo] = null; continue; }
      const n = Number(v);
      if (!Number.isInteger(n) || n < 0) return json({ error: 'monto_invalido', campo }, 400);
      cambio[campo] = n; continue;
    }
    const t = typeof v === 'string' && v.trim() ? v.trim() : null;
    if (campo === 'fecha_programada' && t && !FECHA.test(t)) return json({ error: 'fecha_invalida' }, 400);
    if (campo === 'courier' && t && !(t in COURIERS)) return json({ error: 'courier_invalido' }, 400);
    cambio[campo] = t;
  }
  if (Object.keys(cambio).length === 0) return json({ error: 'sin_cambios' }, 400);

  const d = await cargarDespacho(id);
  if (d === null) return json({ error: 'upstream' }, 503);
  if (d === undefined) return json({ error: 'despacho_no_encontrado' }, 404);
  const cerrado = d.estado === 'entregado' || d.estado === 'anulado';
  if (cerrado && Object.keys(cambio).some((c) => (MIENTRAS_ABIERTO as readonly string[]).includes(c))) {
    return json({ error: 'despacho_cerrado', estado: d.estado }, 409);
  }

  const res = await supabasePatch(`/despachos?id=eq.${id}`, { ...cambio, updated_at: new Date().toISOString() });
  if (res === null) return json({ error: 'upstream' }, 503);
  return json({ ok: true });
}
```

```ts
// apps/backoffice/app/api/despachos/transicion/route.ts
import { cargarDatosPedido, cargarDespacho, registrarEvento } from '../../../../src/lib/datos-pedido.js';
import { ESTADOS_DESPACHO, requisitoTransicion, transicionDespachoValida, type EstadoDespacho } from '../../../../src/lib/despachos.js';
import { evaluarPedidoEntregado } from '../../../../src/lib/entrega.js';
import { faltantesParaListo } from '../../../../src/lib/lineas.js';
import { supabasePatch } from '../../../../src/lib/supabase.js';

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

export async function POST(req: Request): Promise<Response> {
  const b = (await req.json().catch(() => null)) as { id?: number; hacia?: string; nota?: string } | null;
  const id = Number(b?.id);
  const hacia = String(b?.hacia ?? '') as EstadoDespacho;
  if (!Number.isInteger(id) || id <= 0 || !ESTADOS_DESPACHO.includes(hacia)) return json({ error: 'cuerpo_invalido' }, 400);
  const nota = typeof b?.nota === 'string' && b.nota.trim() ? b.nota.trim() : null;

  const d = await cargarDespacho(id);
  if (d === null) return json({ error: 'upstream' }, 503);
  if (d === undefined) return json({ error: 'despacho_no_encontrado' }, 404);
  if (d.estado === hacia) return json({ ok: true, estado: hacia });
  if (!transicionDespachoValida(d.estado, hacia, d.modalidad)) return json({ error: 'transicion_invalida', desde: d.estado }, 409);
  const falta = requisitoTransicion(d, hacia);
  if (falta) return json({ error: 'falta_dato', detalle: falta }, 409);

  if (hacia === 'listo') {
    const datos = await cargarDatosPedido(d.quote_id, d.quote_version);
    if (!datos) return json({ error: 'upstream' }, 503);
    const faltan = faltantesParaListo(d, datos.recepciones, datos.despachos);
    if (faltan.length > 0) return json({ error: 'falta_mercaderia', faltan }, 409);
  }

  const ahora = new Date().toISOString();
  const cambio: Record<string, unknown> = { estado: hacia, updated_at: ahora };
  if (hacia === 'en_ruta') cambio.despachado_at = ahora;
  if (hacia === 'entregado') cambio.entregado_at = ahora;
  const res = await supabasePatch(`/despachos?id=eq.${id}&estado=eq.${d.estado}`, cambio);
  if (res === null) return json({ error: 'upstream' }, 503);
  if (res.length === 0) return json({ error: 'transicion_invalida', desde: d.estado }, 409);

  await registrarEvento(id, d.estado, hacia, nota);
  if (hacia === 'entregado') await evaluarPedidoEntregado(d.quote_id, d.quote_version);
  return json({ ok: true, estado: hacia });
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/backoffice/tests/api-despachos.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backoffice/app/api/despachos apps/backoffice/tests/api-despachos.test.ts
git commit -m "feat(despachos): rutas para crear, editar y avanzar despachos"
```

---

### Task 7: Cargadores de las vistas

**Files:**
- Create: `apps/backoffice/src/lib/vista-compras.ts`, `apps/backoffice/src/lib/vista-despachos.ts`
- Test: `apps/backoffice/tests/vista-compras.test.ts`, `apps/backoffice/tests/vista-despachos.test.ts`

**Interfaces:**
- Consumes: `supabaseGet` (Task 2); `normalizarDespacho` (Task 4); `claveLinea`, `lineasDePedido`, `resumirLineas` (Task 3); `compraAtrasada`, `hoySantiago` (Task 3); `agruparPedidos` y `FilaPedido` (`pedidos.ts`).
- Produces:
  ```ts
  // vista-compras.ts
  export interface CompraVista {
    fila: FilaPedido; cliente: string; numeroCotizacion: number | null; atrasada: boolean;
    lineas: Array<{ clave: string; nombre: string; cantidad: number; recibida: number }>;
  }
  export interface VistaCompras { porComprar: CompraVista[]; enCurso: CompraVista[]; recibidas: CompraVista[]; atrasadas: number }
  export async function cargarVistaCompras(hoy?: string): Promise<VistaCompras | null>;
  // vista-despachos.ts
  export interface PedidoLogistica {
    quoteId: string; version: string; cliente: string; telefono: string | null; numeroCotizacion: number | null;
    estadoNegocio: string; resumen: ResumenLinea[]; despachos: Despacho[];
    facturacion: { direccion: string | null; comuna: string | null; ciudad: string | null };
  }
  export interface VistaDespachos {
    porAsignar: PedidoLogistica[];
    activos: Array<{ despacho: Despacho; pedido: PedidoLogistica }>;
    cobrosPendientes: Array<{ despacho: Despacho; pedido: PedidoLogistica }>;
    entregadosRecientes: Array<{ despacho: Despacho; pedido: PedidoLogistica }>;
  }
  export async function cargarVistaDespachos(): Promise<VistaDespachos | null>;
  ```

- [ ] **Step 1: Write the failing tests**

```ts
// apps/backoffice/tests/vista-compras.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarVistaCompras } from '../src/lib/vista-compras.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const PEDIDOS = [
  { po_id: 'oc-1', quote_id: 'q1', quote_version: '1', proveedor: 'intcomex', razon_social: 'Acme', telefono: '569', estado_negocio: 'pagado', estado_compra: 'por_comprar', modalidad_compra: null, llegada_estimada: null, created_at: '2026-09-25T10:00:00Z', lineas: [{ mpn: 'A', nombre: 'Toner A', cantidad: 2 }] },
  { po_id: 'oc-2', quote_id: 'q1', quote_version: '1', proveedor: 'tecnoglobal', razon_social: 'Acme', telefono: '569', estado_negocio: 'pagado', estado_compra: 'en_camino', modalidad_compra: 'despacho_mayorista', llegada_estimada: '2026-09-20', created_at: '2026-09-25T10:00:00Z', lineas: [{ mpn: 'B', nombre: 'Toner B', cantidad: 1 }] },
  { po_id: 'oc-3', quote_id: 'q2', quote_version: '1', proveedor: 'ingram', razon_social: null, telefono: '570', estado_negocio: 'pagado', estado_compra: 'recibida', modalidad_compra: 'retiro', llegada_estimada: null, created_at: '2026-09-24T10:00:00Z', lineas: [{ mpn: 'C', cantidad: 1 }] },
];

describe('cargarVistaCompras', () => {
  it('agrupa por estado, suma lo recibido por linea y cuenta las atrasadas', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test'); vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/pedidos?')) return new Response(JSON.stringify(PEDIDOS));
      if (u.includes('/recepciones?')) return new Response(JSON.stringify([{ po_id: 'oc-3', mpn: 'C', cantidad: 1 }]));
      return new Response(JSON.stringify([{ quote_id: 'q1', version: '1', numero: 1600020 }]));
    }));
    const v = await cargarVistaCompras('2026-09-25');
    expect(v?.porComprar.map((c) => c.fila.po_id)).toEqual(['oc-1']);
    expect(v?.enCurso.map((c) => c.fila.po_id)).toEqual(['oc-2']);
    expect(v?.recibidas.map((c) => c.fila.po_id)).toEqual(['oc-3']);
    expect(v?.atrasadas).toBe(1);
    expect(v?.enCurso[0].atrasada).toBe(true);
    expect(v?.porComprar[0].numeroCotizacion).toBe(1600020);
    expect(v?.porComprar[0].cliente).toBe('Acme');
    expect(v?.recibidas[0].lineas[0]).toMatchObject({ clave: 'C', recibida: 1 });
  });
  it('null si falla la base', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test'); vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 500 })));
    expect(await cargarVistaCompras('2026-09-25')).toBeNull();
  });
});
```

```ts
// apps/backoffice/tests/vista-despachos.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cargarVistaDespachos } from '../src/lib/vista-despachos.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const PEDIDOS = [
  { po_id: 'oc-1', quote_id: 'q1', quote_version: '1', proveedor: 'intcomex', razon_social: 'Acme', telefono: '569', estado_negocio: 'pagado', estado_compra: 'recibida', modalidad_compra: 'retiro', created_at: '2026-09-25T10:00:00Z', lineas: [{ mpn: 'A', nombre: 'Toner A', cantidad: 2 }] },
  { po_id: 'oc-2', quote_id: 'q2', quote_version: '1', proveedor: 'ingram', razon_social: 'Beta', telefono: '570', estado_negocio: 'pagado', estado_compra: 'recibida', modalidad_compra: 'retiro', created_at: '2026-09-24T10:00:00Z', lineas: [{ mpn: 'B', cantidad: 1 }] },
];
const DESPACHOS = [
  { id: 1, quote_id: 'q2', quote_version: '1', modalidad: 'courier', courier: 'starken', estado: 'en_ruta', cobrado_clp: 4000, cobro_pagado: false, created_at: 'x', despacho_lineas: [{ po_id: 'oc-2', mpn: 'B', cantidad: 1 }] },
  { id: 2, quote_id: 'q1', quote_version: '1', modalidad: 'propio', courier: null, estado: 'entregado', cobrado_clp: null, cobro_pagado: false, created_at: 'x', despacho_lineas: [{ po_id: 'oc-1', mpn: 'A', cantidad: 1 }] },
];

describe('cargarVistaDespachos', () => {
  it('pedidos con lineas por asignar, despachos activos, cobros pendientes y entregados', async () => {
    vi.stubEnv('SUPABASE_URL', 'https://supabase.test'); vi.stubEnv('SUPABASE_SERVICE_KEY', 'clave');
    vi.stubGlobal('fetch', vi.fn(async (url: string) => {
      const u = String(url);
      if (u.includes('/pedidos?')) return new Response(JSON.stringify(PEDIDOS));
      if (u.includes('/despachos?')) return new Response(JSON.stringify(DESPACHOS));
      if (u.includes('/recepciones?')) return new Response(JSON.stringify([]));
      if (u.includes('/clientes?')) return new Response(JSON.stringify([{ telefono: '569', direccion: 'Calle 1', comuna: 'Ñuñoa', ciudad: 'Santiago' }]));
      return new Response(JSON.stringify([{ quote_id: 'q1', version: '1', numero: 1600030 }]));
    }));
    const v = await cargarVistaDespachos();
    expect(v?.porAsignar.map((p) => p.quoteId)).toEqual(['q1']);
    expect(v?.porAsignar[0].resumen[0].pendiente).toBe(1);
    expect(v?.porAsignar[0].facturacion).toEqual({ direccion: 'Calle 1', comuna: 'Ñuñoa', ciudad: 'Santiago' });
    expect(v?.porAsignar[0].numeroCotizacion).toBe(1600030);
    expect(v?.activos.map((a) => a.despacho.id)).toEqual([1]);
    expect(v?.cobrosPendientes.map((a) => a.despacho.id)).toEqual([1]);
    expect(v?.entregadosRecientes.map((a) => a.despacho.id)).toEqual([2]);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run apps/backoffice/tests/vista-compras.test.ts apps/backoffice/tests/vista-despachos.test.ts`
Expected: FAIL — módulos inexistentes.

- [ ] **Step 3: Implement**

```ts
// apps/backoffice/src/lib/vista-compras.ts
import { supabaseGet } from './supabase.js';
import type { FilaPedido } from './pedidos.js';
import { claveLinea } from './lineas.js';
import { compraAtrasada, hoySantiago } from './compras.js';

export interface CompraVista {
  fila: FilaPedido; cliente: string; numeroCotizacion: number | null; atrasada: boolean;
  lineas: Array<{ clave: string; nombre: string; cantidad: number; recibida: number }>;
}
export interface VistaCompras { porComprar: CompraVista[]; enCurso: CompraVista[]; recibidas: CompraVista[]; atrasadas: number }

const LIMITE = 200;
const enLista = (valores: string[]) => encodeURIComponent([...new Set(valores)].map((v) => `"${v}"`).join(','));

// Las compras de pedidos pagados: lo que falta comprar, lo que viene en
// camino y lo recibido que todavia no se despacha.
export async function cargarVistaCompras(hoy: string = hoySantiago()): Promise<VistaCompras | null> {
  const filas = await supabaseGet(`/pedidos?select=*&estado_negocio=eq.pagado&order=created_at.asc&limit=${LIMITE}`);
  if (filas === null) return null;
  const pedidos = filas as FilaPedido[];
  if (pedidos.length === 0) return { porComprar: [], enCurso: [], recibidas: [], atrasadas: 0 };

  const recepciones = await supabaseGet(`/recepciones?select=po_id,mpn,cantidad&po_id=in.(${enLista(pedidos.map((p) => p.po_id))})`);
  if (recepciones === null) return null;
  const cots = await supabaseGet(`/cotizaciones?select=quote_id,version,numero&quote_id=in.(${enLista(pedidos.map((p) => p.quote_id))})`);
  if (cots === null) return null;

  const recibido = new Map<string, number>();
  for (const r of recepciones as Array<{ po_id: string; mpn: string; cantidad: number }>) {
    recibido.set(`${r.po_id}|${r.mpn}`, (recibido.get(`${r.po_id}|${r.mpn}`) ?? 0) + Number(r.cantidad));
  }
  const numero = new Map((cots as Array<{ quote_id: string; version: string; numero: number | null }>).map((c) => [`${c.quote_id}:${c.version}`, c.numero]));

  const vistas: CompraVista[] = pedidos.map((f) => ({
    fila: f,
    cliente: f.razon_social ?? f.telefono ?? 'Sin cliente',
    numeroCotizacion: numero.get(`${f.quote_id}:${f.quote_version}`) ?? null,
    atrasada: compraAtrasada({ estado_compra: f.estado_compra ?? 'por_comprar', llegada_estimada: f.llegada_estimada ?? null }, hoy),
    lineas: (f.lineas ?? []).map((l, i) => {
      const clave = claveLinea(l, i);
      return { clave, nombre: l.nombre ?? l.mpn ?? 'Producto', cantidad: Number(l.cantidad ?? 0), recibida: recibido.get(`${f.po_id}|${clave}`) ?? 0 };
    }),
  }));
  const estado = (c: CompraVista) => c.fila.estado_compra ?? 'por_comprar';
  return {
    porComprar: vistas.filter((c) => estado(c) === 'por_comprar'),
    enCurso: vistas.filter((c) => ['comprada', 'por_retirar', 'en_camino', 'directo_al_cliente', 'recibida_parcial'].includes(estado(c))),
    recibidas: vistas.filter((c) => estado(c) === 'recibida'),
    atrasadas: vistas.filter((c) => c.atrasada).length,
  };
}
```

```ts
// apps/backoffice/src/lib/vista-despachos.ts
import { supabaseGet } from './supabase.js';
import { agruparPedidos, type FilaPedido } from './pedidos.js';
import { normalizarDespacho } from './datos-pedido.js';
import { lineasDePedido, resumirLineas, type Despacho, type Recepcion, type ResumenLinea } from './lineas.js';
import { ESTADOS_DESPACHO_ACTIVOS } from './despachos.js';

export interface PedidoLogistica {
  quoteId: string; version: string; cliente: string; telefono: string | null; numeroCotizacion: number | null;
  estadoNegocio: string; resumen: ResumenLinea[]; despachos: Despacho[];
  facturacion: { direccion: string | null; comuna: string | null; ciudad: string | null };
}
type ConPedido = { despacho: Despacho; pedido: PedidoLogistica };
export interface VistaDespachos {
  porAsignar: PedidoLogistica[]; activos: ConPedido[]; cobrosPendientes: ConPedido[]; entregadosRecientes: ConPedido[];
}

const LIMITE = 200;
const RECIENTES = 20;
const enLista = (valores: string[]) => encodeURIComponent([...new Set(valores)].map((v) => `"${v}"`).join(','));

export async function cargarVistaDespachos(): Promise<VistaDespachos | null> {
  const filas = await supabaseGet(`/pedidos?select=*&estado_negocio=in.(pagado,entregado)&order=created_at.desc&limit=${LIMITE}`);
  if (filas === null) return null;
  const todas = filas as FilaPedido[];
  if (todas.length === 0) return { porAsignar: [], activos: [], cobrosPendientes: [], entregadosRecientes: [] };

  const quotes = todas.map((f) => f.quote_id);
  const telefonos = todas.map((f) => f.telefono ?? '').filter(Boolean);
  const [despachos, recepciones, cots, clientes] = await Promise.all([
    supabaseGet(`/despachos?select=*,despacho_lineas(po_id,mpn,cantidad)&quote_id=in.(${enLista(quotes)})&order=id.desc`),
    supabaseGet(`/recepciones?select=po_id,mpn,cantidad&po_id=in.(${enLista(todas.map((f) => f.po_id))})`),
    supabaseGet(`/cotizaciones?select=quote_id,version,numero&quote_id=in.(${enLista(quotes)})`),
    // PostgREST rechaza `in.()` vacio: sin telefonos no se consulta.
    telefonos.length > 0
      ? supabaseGet(`/clientes?select=telefono,direccion,comuna,ciudad&telefono=in.(${enLista(telefonos)})`)
      : Promise.resolve([] as unknown[]),
  ]);
  if (despachos === null || recepciones === null || cots === null || clientes === null) return null;

  const listaDespachos = (despachos as Record<string, unknown>[]).map(normalizarDespacho);
  const listaRecepciones = recepciones as Recepcion[];
  const numero = new Map((cots as Array<{ quote_id: string; version: string; numero: number | null }>).map((c) => [`${c.quote_id}:${c.version}`, c.numero]));
  const cliente = new Map((clientes as Array<{ telefono: string; direccion: string | null; comuna: string | null; ciudad: string | null }>).map((c) => [c.telefono, c]));

  const pedidos: PedidoLogistica[] = agruparPedidos(todas).map((g) => {
    const filasGrupo = todas.filter((f) => f.quote_id === g.quoteId && f.quote_version === g.version);
    const deEste = listaDespachos.filter((d) => d.quote_id === g.quoteId && d.quote_version === g.version);
    const c = g.telefono ? cliente.get(g.telefono) : undefined;
    return {
      quoteId: g.quoteId, version: g.version, cliente: g.razonSocial ?? g.telefono ?? 'Sin cliente',
      telefono: g.telefono, numeroCotizacion: numero.get(`${g.quoteId}:${g.version}`) ?? null,
      estadoNegocio: g.estadoNegocio,
      resumen: resumirLineas(lineasDePedido(filasGrupo), listaRecepciones, deEste),
      despachos: deEste,
      facturacion: { direccion: c?.direccion ?? null, comuna: c?.comuna ?? null, ciudad: c?.ciudad ?? null },
    };
  });
  const conPedido = (d: Despacho): ConPedido => ({
    despacho: d,
    pedido: pedidos.find((p) => p.quoteId === d.quote_id && p.version === d.quote_version)!,
  });
  const visibles = listaDespachos.filter((d) => pedidos.some((p) => p.quoteId === d.quote_id && p.version === d.quote_version));

  return {
    porAsignar: pedidos.filter((p) => p.estadoNegocio === 'pagado' && p.resumen.some((r) => r.pendiente > 0)),
    activos: visibles.filter((d) => ESTADOS_DESPACHO_ACTIVOS.includes(d.estado)).map(conPedido),
    cobrosPendientes: visibles.filter((d) => (d.cobrado_clp ?? 0) > 0 && !d.cobro_pagado && d.estado !== 'anulado').map(conPedido),
    entregadosRecientes: visibles.filter((d) => d.estado === 'entregado').slice(0, RECIENTES).map(conPedido),
  };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run apps/backoffice/tests/vista-compras.test.ts apps/backoffice/tests/vista-despachos.test.ts && npm run typecheck`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/backoffice/src/lib/vista-compras.ts apps/backoffice/src/lib/vista-despachos.ts apps/backoffice/tests/vista-compras.test.ts apps/backoffice/tests/vista-despachos.test.ts
git commit -m "feat(despachos): cargadores de las vistas de compras y despachos"
```

---

### Task 8: Vistas y componentes del backoffice

**Files:**
- Create: `apps/backoffice/app/compras/page.tsx`, `app/despachos/page.tsx`, `app/componentes/AccionesCompra.tsx`, `app/componentes/FormularioDespacho.tsx`, `app/componentes/AccionesDespacho.tsx`, `app/componentes/TarjetaDespacho.tsx`
- Modify: `apps/backoffice/app/componentes/Nav.tsx` (lista `VISTAS`), `apps/backoffice/app/globals.css` (al final)

**Interfaces:**
- Consumes: `cargarVistaCompras`, `cargarVistaDespachos` (Task 7); `mensajeCliente`, `COURIERS` (Task 3); rutas de Tasks 5 y 6; `fechaCorta`, `formatCLP` de `src/lib/formato.ts`.

No hay tests de componentes `.tsx` en este repo; la verificación es el typecheck aquí y la prueba real de la Task 9.

- [ ] **Step 1: Componentes cliente**

```tsx
// apps/backoffice/app/componentes/AccionesCompra.tsx
'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Linea = { clave: string; nombre: string; cantidad: number; recibida: number };
const SIGUIENTE: Record<string, { hacia: string; label: string }> = {
  retiro: { hacia: 'por_retirar', label: 'Listo para retiro' },
  despacho_mayorista: { hacia: 'en_camino', label: 'Despachado por el mayorista' },
  directo_cliente: { hacia: 'directo_al_cliente', label: 'Despachado directo al cliente' },
};
const RECIBE = ['comprada', 'por_retirar', 'en_camino', 'recibida_parcial'];

async function enviar(ruta: string, body: unknown): Promise<string | null> {
  const res = await fetch(ruta, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  if (res?.ok) return null;
  const data = await res?.json().catch(() => ({})) ?? {};
  return String(data.detalle ?? data.error ?? 'No se pudo guardar. Intenta de nuevo.');
}

export function AccionesCompra({ poId, estado, modalidad, lineas }: { poId: string; estado: string; modalidad: string | null; lineas: Linea[] }) {
  const router = useRouter();
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');

  async function correr(ruta: string, body: unknown) {
    setOcupado(true); setError('');
    const e = await enviar(ruta, body);
    setOcupado(false);
    if (e) setError(e);
    router.refresh();
  }

  function registrar(form: FormData) {
    const datos: Record<string, string> = { po_id: poId };
    for (const [k, v] of form.entries()) if (String(v).trim()) datos[k] = String(v);
    void correr('/api/compras/registrar', datos);
  }

  return (
    <div className="acciones">
      {estado === 'por_comprar' ? (
        <form className="formulario" action={registrar}>
          <label>Modalidad
            <select name="modalidad" required defaultValue="">
              <option value="" disabled>Elegir…</option>
              <option value="retiro">Hay que retirarlo</option>
              <option value="despacho_mayorista">El mayorista nos lo despacha</option>
              <option value="directo_cliente">El mayorista despacha directo al cliente</option>
            </select>
          </label>
          <label>N° pedido del mayorista<input name="numero_pedido_mayorista" required /></label>
          <label>Llegada estimada<input name="llegada_estimada" type="date" /></label>
          <label>Guía del mayorista<input name="guia_mayorista" /></label>
          <label className="ancho">Nota<input name="nota_compra" /></label>
          <button disabled={ocupado}>Registrar compra</button>
        </form>
      ) : null}

      <div className="botonera">
        {estado === 'comprada' && modalidad && SIGUIENTE[modalidad] ? (
          <button disabled={ocupado} onClick={() => correr('/api/compras/transicion', { po_id: poId, hacia: SIGUIENTE[modalidad].hacia })}>
            {SIGUIENTE[modalidad].label}
          </button>
        ) : null}
        {estado === 'directo_al_cliente' ? (
          <button disabled={ocupado} onClick={() => correr('/api/compras/transicion', { po_id: poId, hacia: 'entregada_al_cliente' })}>Entregado al cliente</button>
        ) : null}
        {['por_comprar', 'comprada', 'por_retirar', 'en_camino', 'directo_al_cliente'].includes(estado) ? (
          <button disabled={ocupado} className="peligro" onClick={() => { if (confirm('¿Anular esta compra?')) void correr('/api/compras/transicion', { po_id: poId, hacia: 'anulada' }); }}>Anular</button>
        ) : null}
      </div>

      {RECIBE.includes(estado) && modalidad !== 'directo_cliente' ? (
        <div className="recepcion">
          {lineas.filter((l) => l.recibida < l.cantidad).map((l) => (
            <form key={l.clave} className="fila-recepcion" action={(form) => correr('/api/compras/recepcion', { po_id: poId, mpn: l.clave, cantidad: Number(form.get('cantidad')) })}>
              <span>{l.nombre} <small>({l.recibida}/{l.cantidad})</small></span>
              <input name="cantidad" type="number" min={1} max={l.cantidad - l.recibida} defaultValue={l.cantidad - l.recibida} aria-label={`Cantidad recibida de ${l.nombre}`} />
              <button disabled={ocupado}>Recibir</button>
            </form>
          ))}
        </div>
      ) : null}

      {error ? <span className="aviso-error">{error}</span> : null}
    </div>
  );
}
```

```tsx
// apps/backoffice/app/componentes/FormularioDespacho.tsx
'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Pendiente = { poId: string; clave: string; nombre: string; pendiente: number; recibida: number };

export function FormularioDespacho({ quoteId, version, pendientes, facturacion, contacto }: {
  quoteId: string; version: string; pendientes: Pendiente[];
  facturacion: { direccion: string | null; comuna: string | null; ciudad: string | null };
  contacto: { nombre: string | null; telefono: string | null };
}) {
  const router = useRouter();
  const [modalidad, setModalidad] = useState('courier');
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');

  async function crear(form: FormData) {
    const lineas = pendientes
      .map((p) => ({ po_id: p.poId, mpn: p.clave, cantidad: Number(form.get(`cant-${p.poId}-${p.clave}`) ?? 0) }))
      .filter((l) => l.cantidad > 0);
    const campos: Record<string, unknown> = { quote_id: quoteId, quote_version: version, modalidad, lineas };
    for (const k of ['courier', 'direccion', 'comuna', 'ciudad', 'contacto_nombre', 'contacto_telefono', 'fecha_programada', 'responsable', 'costo_clp', 'cobrado_clp', 'nota']) {
      const v = String(form.get(k) ?? '').trim();
      if (v) campos[k] = k.endsWith('_clp') ? Number(v) : v;
    }
    setOcupado(true); setError('');
    const res = await fetch('/api/despachos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(campos) }).catch(() => null);
    setOcupado(false);
    if (!res?.ok) {
      const data = await res?.json().catch(() => ({})) ?? {};
      setError(String(data.detalle ?? data.error ?? 'No se pudo crear el despacho.'));
    }
    router.refresh();
  }

  return (
    <details className="crear-despacho">
      <summary>Crear despacho</summary>
      <form className="formulario" action={crear}>
        <table className="lineas">
          <thead><tr><th>Producto</th><th>Recibido</th><th>Por asignar</th><th>En este despacho</th></tr></thead>
          <tbody>
            {pendientes.map((p) => (
              <tr key={`${p.poId}-${p.clave}`}>
                <td>{p.nombre}</td>
                <td className="num">{p.recibida}</td>
                <td className="num">{p.pendiente}</td>
                <td className="num"><input name={`cant-${p.poId}-${p.clave}`} type="number" min={0} max={p.pendiente} defaultValue={p.pendiente} aria-label={`Cantidad de ${p.nombre}`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <label>Modalidad
          <select value={modalidad} onChange={(e) => setModalidad(e.target.value)}>
            <option value="courier">Courier</option>
            <option value="propio">Despacho propio</option>
            <option value="retiro_oficina">Retiro en oficina</option>
          </select>
        </label>
        {modalidad === 'courier' ? (
          <label>Courier
            <select name="courier" defaultValue="starken">
              <option value="starken">Starken</option>
              <option value="bluexpress">Blue Express</option>
              <option value="chilexpress">Chilexpress</option>
              <option value="otro">Otro</option>
            </select>
          </label>
        ) : null}
        {modalidad !== 'retiro_oficina' ? (
          <>
            <label className="ancho">Dirección<input name="direccion" defaultValue={facturacion.direccion ?? ''} /></label>
            <label>Comuna<input name="comuna" defaultValue={facturacion.comuna ?? ''} /></label>
            <label>Ciudad<input name="ciudad" defaultValue={facturacion.ciudad ?? ''} /></label>
          </>
        ) : null}
        <label>Contacto<input name="contacto_nombre" defaultValue={contacto.nombre ?? ''} /></label>
        <label>Teléfono<input name="contacto_telefono" defaultValue={contacto.telefono ?? ''} /></label>
        <label>Fecha programada<input name="fecha_programada" type="date" /></label>
        <label>Responsable<input name="responsable" /></label>
        <label>Costo del envío (CLP)<input name="costo_clp" type="number" min={0} /></label>
        <label>Cobrado al cliente (CLP)<input name="cobrado_clp" type="number" min={0} /></label>
        <label className="ancho">Nota<input name="nota" /></label>
        <button disabled={ocupado}>Crear despacho</button>
        {error ? <span className="aviso-error">{error}</span> : null}
      </form>
    </details>
  );
}
```

```tsx
// apps/backoffice/app/componentes/AccionesDespacho.tsx
'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

type Transicion = { hacia: string; label: string; peligro?: boolean };
function transiciones(estado: string, modalidad: string): Transicion[] {
  const retiro = modalidad === 'retiro_oficina';
  switch (estado) {
    case 'por_preparar': return [{ hacia: 'listo', label: retiro ? 'Listo para retiro' : 'Listo para despachar' }, { hacia: 'anulado', label: 'Anular', peligro: true }];
    case 'listo': return [retiro ? { hacia: 'entregado', label: 'Retirado por el cliente' } : { hacia: 'en_ruta', label: 'En ruta' }, { hacia: 'anulado', label: 'Anular', peligro: true }];
    case 'en_ruta': return [{ hacia: 'entregado', label: 'Entregado' }, { hacia: 'fallido', label: 'No se pudo entregar', peligro: true }];
    case 'fallido': return [{ hacia: 'listo', label: 'Reprogramar' }, { hacia: 'anulado', label: 'Anular', peligro: true }];
    default: return [];
  }
}

export function AccionesDespacho({ id, estado, modalidad, numeroSeguimiento, costo, cobrado, cobroPagado, mensaje }: {
  id: number; estado: string; modalidad: string; numeroSeguimiento: string | null;
  costo: number | null; cobrado: number | null; cobroPagado: boolean; mensaje: string | null;
}) {
  const router = useRouter();
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState('');

  async function post(ruta: string, body: unknown) {
    setOcupado(true); setAviso('');
    const res = await fetch(ruta, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    setOcupado(false);
    if (!res?.ok) {
      const data = await res?.json().catch(() => ({})) ?? {};
      setAviso(Array.isArray(data.faltan) ? `Falta recibir: ${data.faltan.join(', ')}` : String(data.detalle ?? data.error ?? 'No se pudo guardar.'));
    }
    router.refresh();
  }

  async function copiar() {
    if (!mensaje) return;
    try { await navigator.clipboard.writeText(mensaje); setAviso('Mensaje copiado'); }
    catch { setAviso(mensaje); }
  }

  function guardar(form: FormData) {
    const cambio: Record<string, unknown> = { id };
    for (const k of ['numero_seguimiento', 'costo_clp', 'cobrado_clp', 'responsable', 'fecha_programada', 'nota']) {
      if (!form.has(k)) continue;
      const v = String(form.get(k) ?? '').trim();
      cambio[k] = k.endsWith('_clp') ? (v ? Number(v) : null) : v;
    }
    cambio.cobro_pagado = form.get('cobro_pagado') === 'on';
    void post('/api/despachos/editar', cambio);
  }

  const cerrado = estado === 'entregado' || estado === 'anulado';
  return (
    <div className="acciones">
      <div className="botonera">
        {transiciones(estado, modalidad).map((t) => (
          <button key={t.hacia} disabled={ocupado} className={t.peligro ? 'peligro' : ''}
            onClick={() => { if (t.hacia === 'anulado' && !confirm('¿Anular este despacho?')) return; void post('/api/despachos/transicion', { id, hacia: t.hacia }); }}>
            {t.label}
          </button>
        ))}
        {mensaje ? <button disabled={ocupado} className="secundario" onClick={copiar}>Copiar mensaje</button> : null}
      </div>
      <form className="formulario compacto" action={guardar}>
        {!cerrado && modalidad === 'courier' ? <label>N° seguimiento<input name="numero_seguimiento" defaultValue={numeroSeguimiento ?? ''} /></label> : null}
        <label>Costo (CLP)<input name="costo_clp" type="number" min={0} defaultValue={costo ?? ''} /></label>
        <label>Cobrado (CLP)<input name="cobrado_clp" type="number" min={0} defaultValue={cobrado ?? ''} /></label>
        <label className="check"><input name="cobro_pagado" type="checkbox" defaultChecked={cobroPagado} /> Envío pagado</label>
        <button disabled={ocupado} className="secundario">Guardar</button>
      </form>
      {aviso ? <span className={aviso === 'Mensaje copiado' ? 'aviso-ok' : 'aviso-error'}>{aviso}</span> : null}
    </div>
  );
}
```

```tsx
// apps/backoffice/app/componentes/TarjetaDespacho.tsx
import { COURIERS, mensajeCliente } from '../../src/lib/couriers.js';
import { formatCLP } from '../../src/lib/formato.js';
import type { Despacho } from '../../src/lib/lineas.js';
import type { PedidoLogistica } from '../../src/lib/vista-despachos.js';
import { AccionesDespacho } from './AccionesDespacho.js';

const MODALIDAD: Record<string, string> = { retiro_oficina: 'Retiro en oficina', propio: 'Despacho propio', courier: 'Courier' };

export function TarjetaDespacho({ despacho: d, pedido }: { despacho: Despacho; pedido: PedidoLogistica }) {
  const courier = d.courier ? COURIERS[d.courier] : null;
  const seguimiento = courier && d.numero_seguimiento ? courier.urlSeguimiento(d.numero_seguimiento) : null;
  const nombre = (poId: string, mpn: string) => pedido.resumen.find((r) => r.poId === poId && r.clave === mpn)?.nombre ?? mpn;
  return (
    <div className="tarjeta despacho">
      <header>
        <span><b>Despacho N° {d.id}</b> · {pedido.cliente}{pedido.numeroCotizacion ? ` · Pedido N° ${pedido.numeroCotizacion}` : ''}</span>
        <span className={`badge ${d.estado}`}>{d.estado.replace('_', ' ')}</span>
      </header>
      <div className="meta">
        {MODALIDAD[d.modalidad]}{courier ? ` · ${courier.nombre}` : ''}
        {d.numero_seguimiento ? <> · N° {seguimiento ? <a href={seguimiento.url} target="_blank" rel="noreferrer">{d.numero_seguimiento}</a> : d.numero_seguimiento}</> : null}
        {d.comuna ? ` · ${d.comuna}` : ''}{d.fecha_programada ? ` · para el ${d.fecha_programada}` : ''}{d.responsable ? ` · ${d.responsable}` : ''}
        {d.cobrado_clp ? ` · envío ${formatCLP(d.cobrado_clp)}${d.cobro_pagado ? ' pagado' : ' por cobrar'}` : ''}
      </div>
      <ul className="items">
        {d.lineas.map((l) => <li key={`${l.po_id}-${l.mpn}`}>{l.cantidad} × {nombre(l.po_id, l.mpn)}</li>)}
      </ul>
      <AccionesDespacho
        id={d.id} estado={d.estado} modalidad={d.modalidad} numeroSeguimiento={d.numero_seguimiento}
        costo={d.costo_clp} cobrado={d.cobrado_clp} cobroPagado={d.cobro_pagado}
        mensaje={mensajeCliente(d, { numeroCotizacion: pedido.numeroCotizacion, contacto: d.contacto_nombre })}
      />
    </div>
  );
}
```

- [ ] **Step 2: Pages**

```tsx
// apps/backoffice/app/compras/page.tsx
import { cargarVistaCompras, type CompraVista } from '../../src/lib/vista-compras.js';
import { AccionesCompra } from '../componentes/AccionesCompra.js';

export const dynamic = 'force-dynamic';

const MODALIDAD: Record<string, string> = { retiro: 'Retiro', despacho_mayorista: 'Nos despacha el mayorista', directo_cliente: 'Directo al cliente' };

function Tarjeta({ c }: { c: CompraVista }) {
  const f = c.fila;
  const estado = f.estado_compra ?? 'por_comprar';
  return (
    <div className="tarjeta compra">
      <header>
        <span><b>{f.proveedor}</b> · {c.cliente}{c.numeroCotizacion ? ` · Pedido N° ${c.numeroCotizacion}` : ''}</span>
        <span>
          <span className={`badge ${estado}`}>{estado.replaceAll('_', ' ')}</span>{' '}
          {c.atrasada ? <span className="badge fallo">atrasada</span> : null}
        </span>
      </header>
      <div className="meta">
        {f.modalidad_compra ? MODALIDAD[f.modalidad_compra] : 'Sin comprar'}
        {f.numero_pedido_mayorista ? ` · N° ${f.numero_pedido_mayorista}` : ''}
        {f.llegada_estimada ? ` · llega ${f.llegada_estimada}` : ''}
        {f.guia_mayorista ? ` · guía ${f.guia_mayorista}` : ''}
        {f.nota_compra ? ` · ${f.nota_compra}` : ''}
      </div>
      <ul className="items">
        {c.lineas.map((l) => <li key={l.clave}>{l.nombre} · {l.recibida}/{l.cantidad} recibidos</li>)}
      </ul>
      <AccionesCompra poId={f.po_id} estado={estado} modalidad={f.modalidad_compra ?? null} lineas={c.lineas} />
    </div>
  );
}

export default async function Compras() {
  const v = await cargarVistaCompras();
  if (!v) return <div className="aviso-error">No se pudo cargar desde la base. <a href="/compras">Reintentar</a></div>;
  return (
    <>
      <h1>Compras</h1>
      <div className="contadores">
        <div className="contador destacado"><b>{v.porComprar.length}</b><span>por comprar</span></div>
        <div className="contador"><b>{v.enCurso.length}</b><span>en curso</span></div>
        <div className={v.atrasadas > 0 ? 'contador problema' : 'contador'}><b>{v.atrasadas}</b><span>atrasadas</span></div>
      </div>
      <h2>Por comprar</h2>
      {v.porComprar.length === 0 ? <p className="vacio">Nada por comprar.</p> : v.porComprar.map((c) => <Tarjeta key={c.fila.po_id} c={c} />)}
      <h2>En curso</h2>
      {v.enCurso.length === 0 ? <p className="vacio">Nada en camino.</p> : v.enCurso.map((c) => <Tarjeta key={c.fila.po_id} c={c} />)}
      <h2>Recibidas, por despachar</h2>
      {v.recibidas.length === 0 ? <p className="vacio">Nada recibido pendiente.</p> : v.recibidas.map((c) => <Tarjeta key={c.fila.po_id} c={c} />)}
    </>
  );
}
```

```tsx
// apps/backoffice/app/despachos/page.tsx
import { cargarVistaDespachos } from '../../src/lib/vista-despachos.js';
import { FormularioDespacho } from '../componentes/FormularioDespacho.js';
import { TarjetaDespacho } from '../componentes/TarjetaDespacho.js';

export const dynamic = 'force-dynamic';

export default async function Despachos() {
  const v = await cargarVistaDespachos();
  if (!v) return <div className="aviso-error">No se pudo cargar desde la base. <a href="/despachos">Reintentar</a></div>;
  return (
    <>
      <h1>Despachos</h1>
      <div className="contadores">
        <div className="contador destacado"><b>{v.porAsignar.length}</b><span>pedidos por despachar</span></div>
        <div className="contador"><b>{v.activos.length}</b><span>despachos en curso</span></div>
        <div className={v.cobrosPendientes.length > 0 ? 'contador problema' : 'contador'}><b>{v.cobrosPendientes.length}</b><span>envíos por cobrar</span></div>
      </div>

      <h2>Pedidos por despachar</h2>
      {v.porAsignar.length === 0 ? <p className="vacio">Todo lo pagado ya tiene despacho.</p> : v.porAsignar.map((p) => (
        <div key={`${p.quoteId}:${p.version}`} className="tarjeta">
          <header><span><b>{p.cliente}</b>{p.numeroCotizacion ? ` · Pedido N° ${p.numeroCotizacion}` : ''}</span></header>
          <table className="lineas">
            <thead><tr><th>Producto</th><th>Comprado</th><th>Recibido</th><th>Asignado</th><th>Entregado</th></tr></thead>
            <tbody>
              {p.resumen.map((r) => (
                <tr key={`${r.poId}-${r.clave}`}>
                  <td>{r.nombre}{r.directo ? ' (directo del mayorista)' : ''}</td>
                  <td className="num">{r.cantidad}</td><td className="num">{r.recibida}</td>
                  <td className="num">{r.asignada}</td><td className="num">{r.directo ? (r.entregadaDirecto ? r.cantidad : 0) : r.entregada}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <FormularioDespacho
            quoteId={p.quoteId} version={p.version}
            pendientes={p.resumen.filter((r) => r.pendiente > 0).map((r) => ({ poId: r.poId, clave: r.clave, nombre: r.nombre, pendiente: r.pendiente, recibida: r.recibida }))}
            facturacion={p.facturacion} contacto={{ nombre: p.cliente, telefono: p.telefono }}
          />
        </div>
      ))}

      <h2>En curso</h2>
      {v.activos.length === 0 ? <p className="vacio">No hay despachos en curso.</p> : v.activos.map((a) => <TarjetaDespacho key={a.despacho.id} despacho={a.despacho} pedido={a.pedido} />)}

      <h2>Envíos por cobrar</h2>
      {v.cobrosPendientes.length === 0 ? <p className="vacio">Nada por cobrar.</p> : v.cobrosPendientes.map((a) => <TarjetaDespacho key={`c-${a.despacho.id}`} despacho={a.despacho} pedido={a.pedido} />)}

      <h2>Entregados recientes</h2>
      {v.entregadosRecientes.length === 0 ? <p className="vacio">Todavía no hay entregas.</p> : v.entregadosRecientes.map((a) => <TarjetaDespacho key={`e-${a.despacho.id}`} despacho={a.despacho} pedido={a.pedido} />)}
    </>
  );
}
```

- [ ] **Step 3: Menú y estilos**

En `apps/backoffice/app/componentes/Nav.tsx`, en `VISTAS`, después de la entrada de Pedidos:

```tsx
  { href: '/compras', label: 'Compras', icon: <path d="M4 5h2l2 10h9l2-7H7.2M10 19.5a1 1 0 1 1-2 0 1 1 0 0 1 2 0Zm8 0a1 1 0 1 1-2 0 1 1 0 0 1 2 0Z" /> },
  { href: '/despachos', label: 'Despachos', icon: <path d="M3 6h11v10H3V6Zm11 4h4l3 3v3h-7v-6ZM7 18.5a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Zm12 0a1.5 1.5 0 1 1-3 0 1.5 1.5 0 0 1 3 0Z" /> },
```

Al final de `apps/backoffice/app/globals.css`:

```css
/* ---- compras y despachos ---- */
h2 { font-size: 15px; margin: 22px 0 10px; color: var(--gris); font-weight: 600; }
.tarjeta.compra, .tarjeta.despacho { display: block; }
.items { margin: 8px 0; padding-left: 18px; font-size: 13px; }
.acciones { margin-top: 10px; display: grid; gap: 10px; }
.formulario { display: grid; grid-template-columns: repeat(auto-fill, minmax(190px, 1fr)); gap: 10px; align-items: end; }
.formulario label { display: grid; gap: 4px; font-size: 12px; color: var(--gris); }
.formulario label.ancho { grid-column: 1 / -1; }
.formulario label.check { display: flex; align-items: center; gap: 6px; }
.formulario input, .formulario select { font: inherit; font-size: 14px; padding: 7px 9px; border: 1px solid var(--borde); border-radius: 8px; background: #fff; color: var(--tinta); }
.formulario .lineas { grid-column: 1 / -1; }
.formulario .lineas input { width: 72px; text-align: right; }
.formulario.compacto { grid-template-columns: repeat(auto-fill, minmax(150px, 1fr)); }
.formulario button, .fila-recepcion button { font: inherit; font-size: 13px; padding: 8px 12px; border-radius: 8px; border: 1px solid var(--azul); background: var(--azul); color: #fff; cursor: pointer; }
.formulario button.secundario, .botonera button.secundario { background: transparent; color: var(--azul); }
.recepcion { display: grid; gap: 6px; }
.fila-recepcion { display: grid; grid-template-columns: 1fr 80px auto; gap: 8px; align-items: center; font-size: 13px; }
.fila-recepcion input { font: inherit; padding: 6px 8px; border: 1px solid var(--borde); border-radius: 8px; }
.crear-despacho summary { cursor: pointer; color: var(--azul); font-weight: 600; font-size: 13px; margin: 6px 0; }
.aviso-ok { color: var(--ok); font-size: 13px; }
.badge.por_comprar, .badge.por_preparar, .badge.fallido { background: var(--alerta-suave); color: var(--alerta); }
.badge.comprada, .badge.por_retirar, .badge.en_camino, .badge.directo_al_cliente, .badge.recibida_parcial,
.badge.listo, .badge.en_ruta { background: var(--azul-suave); color: var(--azul); }
.badge.recibida, .badge.entregada_al_cliente { background: var(--ok-suave); color: var(--ok); }
.badge.anulada { background: var(--fondo); color: var(--gris); }
@media (max-width: 640px) { .fila-recepcion { grid-template-columns: 1fr 70px; } .fila-recepcion button { grid-column: 1 / -1; } }
```

Antes de escribir los estilos, leer `app/globals.css` completo: si alguna variable usada (`--azul`, `--azul-suave`, `--alerta`, `--alerta-suave`, `--ok`, `--ok-suave`, `--fondo`, `--borde`, `--gris`, `--tinta`) no existe con ese nombre, usar la equivalente del archivo.

- [ ] **Step 4: Typecheck, suite y build**

Run: `npm run typecheck && npx vitest run apps/backoffice && npm run build -w @rr/backoffice`
Expected: typecheck limpio, tests en verde y build de Next sin errores.

- [ ] **Step 5: Commit**

```bash
git add apps/backoffice/app/compras apps/backoffice/app/despachos apps/backoffice/app/componentes apps/backoffice/app/globals.css
git commit -m "feat(despachos): vistas de compras y despachos en el backoffice"
```

---

### Task 9: Verificación real

**Files:** ninguno nuevo; ejecución y comprobación.

- [ ] **Step 1: Aplicar el SQL**

El usuario abre el SQL Editor de Supabase y corre `docs/sql/2026-09-25-despachos.sql` completo. Verificar después, por PostgREST con la service key (solo lectura), que respondan `GET /rest/v1/despachos?limit=1`, `GET /rest/v1/recepciones?limit=1` y `GET /rest/v1/pedidos?select=estado_compra&limit=1`.

- [ ] **Step 2: Backoffice local con la base real**

Levantar `npm run dev -w @rr/backoffice` con `SUPABASE_URL`, `SUPABASE_SERVICE_KEY` y `BACKOFFICE_PASSWORD` del `.env.local`. Con el navegador automatizado (Playwright + Edge, como en las pruebas de pago), iniciar sesión y usar un pedido de prueba pagado (p. ej. el 1600011, pagado en modo prueba), sobre sus órdenes de compra:
1. En **Compras**, registrar la compra con modalidad "retiro" y número de pedido de prueba; marcar "Listo para retiro".
2. Recibir una parte de una línea: la compra queda `recibida_parcial`.
3. En **Despachos**, crear un despacho parcial con lo recibido (courier Starken, costo y cobrado).
4. Intentar marcarlo "Listo" con cantidades que no alcanzan y ver el aviso "Falta recibir"; completar la recepción y marcarlo "Listo", "En ruta" (con número de seguimiento) y "Entregado".
5. Crear y entregar el despacho con el resto; comprobar que el pedido pasa solo a `entregado` en la vista **Pedidos**.
6. "Copiar mensaje" devuelve el texto esperado.

Expected: cada paso responde como describe la spec; nada queda a medias en la base.

- [ ] **Step 3: Limpiar los datos de prueba**

Borrar por PostgREST (DELETE con la service key) las recepciones, despachos (cascade a líneas y eventos) creados en el paso 2, y devolver las órdenes de compra y el pedido de prueba a su estado anterior (`estado_compra = por_comprar`, campos de compra en null, `estado_negocio` al que tenía). Confirmar con el usuario antes de borrar.
