# Tienda Dr. Computación Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Tienda web pública (`apps/tienda`, marca Dr. Computación) que busca el catálogo con precios finales y convierte el carro en pedidos reales reutilizando las functions de Kapso.

**Architecture:** Next.js App Router (quinto proyecto Vercel). El catálogo viene de la pricing-api server-side (que entrega COSTOS en USD: la tienda aplica la misma conversión a venta del bot y jamás expone el costo). Al confirmar, el servidor invoca `generar-cotizacion-v2` y `emitir-ordenes-compra` vía la Platform API de Kapso con contexto sintético — cero lógica de negocio duplicada.

**Tech Stack:** Next.js ^15, React ^19, TypeScript, vitest (config raíz), next/font (Fraunces + Instrument Sans).

**Spec:** `docs/superpowers/specs/2026-09-03-tienda-dr-computacion-design.md`

## Global Constraints

- **La pricing-api entrega COSTOS del mayorista en USD** (campo `precio` + `moneda` en cada producto de `/search`). El spec decía "venta neta" — es incorrecto y este plan manda: la tienda convierte con la fórmula EXACTA del bot (`Math.round(costoUsd * (1 + MARGEN) * TIPO_CAMBIO_CLP_USD)` = venta neta CLP) y muestra `Math.round(ventaNeta * (1 + IVA_RATE))` con leyenda "IVA incluido". **Ningún costo USD ni `moneda` cruza al navegador** — hay test de invariante.
- Env vars server-side exactas: `PRICING_API_URL` (`https://api.pyxis-latam.cl/rr/captador-precios`), `PRICING_API_KEY`, `KAPSO_API_KEY`, `MARGEN` (0.13), `TIPO_CAMBIO_CLP_USD` (950), `IVA_RATE` (0.19). Pública: `NEXT_PUBLIC_RAYO_WA` (teléfono del bot para wa.me; si falta, el botón no se muestra). Ninguna key viaja al navegador.
- Kapso Platform API: base `https://api.kapso.ai/platform/v1`, header `X-API-Key`. IDs de functions resueltos por nombre vía `GET /functions` y cacheados en memoria. Invocación: `POST /functions/{id}/invoke`.
- Contrato `generar-cotizacion-v2`: body `{execution_context: {vars: {cart_items: [{sku, mpn, marca, cantidad}]}, context: {phone_number}}}`; responde `{estado:'ok', quote:{quote_id, lineas, neto_clp, iva_clp, total_clp, valid_until?}, vars:{...}}` o error 400/409/500 con `{estado, mensaje}`. Máx 50 items, cantidad entera 1..10000.
- Contrato `emitir-ordenes-compra`: vars `{quote_result: quote, quote_confirmed: true, quote_customer_name, billing_rut, billing_razon_social, billing_giro, billing_direccion, billing_comuna, billing_ciudad, billing_email}` (billing solo si los 7 están) + `context.phone_number`; responde `{ok, ordenes, vars:{purchase_orders_ok}}`.
- Checkout: 3 obligatorios (nombre, teléfono a dígitos, email) + facturación opcional TODO-o-NADA (los 7 o ninguno). Carro y datos del comprador en localStorage. Topes: máx 10 líneas, máx 20 unidades por línea.
- Anti-abuso: honeypot (campo `sitio_web` debe venir vacío) + rate limit en memoria por IP (máx 5 confirmaciones por 10 min) — best-effort, aceptado.
- El servidor NUNCA acepta una `quote` del navegador (adulterable): ante diferencia de precio se recotiza de nuevo server-side.
- **Desviación aprobada por este plan:** NO hay página `/producto/[proveedor]/[sku]` — sin fotos ni descripciones en el catálogo, la tarjeta de resultado ya muestra todo (nombre, marca, MPN, precio, stock) con su botón "Agregar". Páginas: `/`, `/buscar`, `/carro`, `/pedido/[id]`.
- `/carro` y `/pedido/*` con `noindex`. UI en español. Modo claro único. Responsive (compra desde el teléfono).
- Identidad Dr. Computación: verde clínico + papel cálido + ámbar en CTA; Fraunces (marca/títulos) + Instrument Sans (texto) vía next/font; logo tipográfico "Dr. C"; nada del azul corporativo; sin emojis como iconografía.
- Tests en `apps/tienda/tests/*.test.ts` (vitest raíz los recoge), `fetch` stub via `vi.stubGlobal`, envs via `vi.stubEnv`. Sin `git add -A`. Commits con trailer `Co-Authored-By: Claude Fable 5 <noreply@anthropic.com>`.

---

### Task 1: Scaffold + identidad visual

**Files:**
- Create: `apps/tienda/package.json`, `apps/tienda/tsconfig.json`, `apps/tienda/next.config.ts`, `apps/tienda/.gitignore`, `apps/tienda/app/layout.tsx`, `apps/tienda/app/globals.css`, `apps/tienda/app/page.tsx` (placeholder; Task 7 lo reemplaza), `apps/tienda/app/componentes/Header.tsx`
- Modify: `tsconfig.json` (raíz), `package.json` (raíz)

**Interfaces:**
- Produces: layout con `<Header/>` (logo, link Carro con contador) y footer; clases CSS `.tarjeta-producto`, `.boton-compra`, `.boton-secundario`, `.chips`, `.buscador`, `.hero`, `.aviso`, `.vacio`, `.precio`, `.leyenda-iva` que las tareas 7-10 usan. Variable CSS `--font-marca` / `--font-texto`.

- [ ] **Step 1: package.json**

```json
{
  "name": "@rr/tienda",
  "version": "0.0.0",
  "private": true,
  "scripts": { "dev": "next dev", "build": "next build", "start": "next start" },
  "dependencies": { "next": "^15", "react": "^19", "react-dom": "^19" },
  "devDependencies": { "@types/react": "^19", "@types/react-dom": "^19" }
}
```

- [ ] **Step 2:** `npm install` desde la raíz.

- [ ] **Step 3: tsconfig propio** — copiar VERBATIM el de `apps/backoffice/tsconfig.json` (moduleResolution bundler, jsx preserve, plugin next).

- [ ] **Step 4: raíz** — en `tsconfig.json` raíz agregar `"apps/tienda"` al `exclude`; en `package.json` raíz: `"typecheck": "tsc --noEmit && tsc --noEmit -p apps/backoffice/tsconfig.json && tsc --noEmit -p apps/tienda/tsconfig.json"`.

- [ ] **Step 5: next.config.ts y .gitignore** — copiar VERBATIM de `apps/backoffice` (`next.config.ts` con `webpack.resolve.extensionAlias` para imports `.js`→`.ts`; `.gitignore` con `.next/`, `.vercel`, `*.tsbuildinfo`).

- [ ] **Step 6: layout, header y CSS**

`app/layout.tsx`:
```tsx
import './globals.css';
import { Fraunces, Instrument_Sans } from 'next/font/google';
import { Header } from './componentes/Header.js';

const marca = Fraunces({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-marca' });
const texto = Instrument_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-texto' });

export const metadata = {
  title: 'Dr. Computación',
  description: 'Tecnología con diagnóstico experto: busca, compara y compra con el mejor precio de tres mayoristas.',
};
export const viewport = { themeColor: '#0f6b5e' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const rayoWa = process.env.NEXT_PUBLIC_RAYO_WA ?? '';
  return (
    <html lang="es" className={`${marca.variable} ${texto.variable}`}>
      <body>
        <Header />
        <main>{children}</main>
        <footer className="pie">
          <span>Dr. Computación — venta de tecnología con respaldo formal.</span>
          {rayoWa ? (
            <a href={`https://wa.me/${rayoWa}`} target="_blank" rel="noreferrer">
              ¿Dudas? Háblale al Rayo por WhatsApp
            </a>
          ) : null}
        </footer>
      </body>
    </html>
  );
}
```

`app/componentes/Header.tsx` (client: el contador del carro lee localStorage):
```tsx
'use client';
import { useEffect, useState } from 'react';
import { contarUnidades, leerCarro } from '../../src/lib/carro.js';

export function Header() {
  const [unidades, setUnidades] = useState(0);
  useEffect(() => {
    const refrescar = () => setUnidades(contarUnidades(leerCarro()));
    refrescar();
    window.addEventListener('carro-cambio', refrescar);
    window.addEventListener('storage', refrescar);
    return () => { window.removeEventListener('carro-cambio', refrescar); window.removeEventListener('storage', refrescar); };
  }, []);
  return (
    <header className="cabecera">
      <a href="/" className="marca">Dr. Computación</a>
      <a href="/carro" className="link-carro">Carro{unidades > 0 ? <span className="conteo">{unidades}</span> : null}</a>
    </header>
  );
}
```

(Nota: `leerCarro`/`contarUnidades` llegan en la Task 4; para que este scaffold compile solo, crear en este task `src/lib/carro.ts` con el stub mínimo tipado que la Task 4 reemplaza con TDD:)
```ts
export interface ItemCarro { sku: string; mpn: string | null; marca: string | null; nombre: string; cantidad: number; precioTiendaClp: number; }
export function leerCarro(): ItemCarro[] { return []; }
export function contarUnidades(items: ItemCarro[]): number { return items.reduce((n, i) => n + i.cantidad, 0); }
```

`app/page.tsx` placeholder:
```tsx
export default function Home() { return <h1>Dr. Computación</h1>; }
```

`app/globals.css` (completo — identidad Dr. Computación, modo claro único con colores explícitos):
```css
* { box-sizing: border-box; margin: 0; }
:root {
  --verde: #0f6b5e; --verde-osc: #0a4c43; --verde-suave: #e4f0ec;
  --papel: #faf7f0; --blanco: #ffffff; --tinta: #21272a; --gris: #66707a;
  --ambar: #b45309; --ambar-vivo: #d97706; --ambar-suave: #fdf1e0;
  --borde: #e6e1d5; --error: #b42318; --error-suave: #fdeaea;
  --sombra: 0 1px 2px rgba(30, 50, 40, 0.06), 0 6px 18px rgba(30, 50, 40, 0.07);
  --radio: 12px;
}
body { font-family: var(--font-texto), system-ui, sans-serif; background: var(--papel); color: var(--tinta); font-size: 15px; line-height: 1.55; }
h1, h2 { font-family: var(--font-marca), Georgia, serif; font-weight: 600; letter-spacing: -0.01em; }
h1 { font-size: 26px; margin: 8px 0 16px; }
main { max-width: 1020px; margin: 0 auto; padding: 20px 16px 48px; }
a { color: var(--verde); }

.cabecera { display: flex; align-items: center; justify-content: space-between; padding: 14px 20px; background: var(--verde); }
.cabecera .marca { font-family: var(--font-marca), Georgia, serif; font-weight: 700; font-size: 21px; color: #fff; text-decoration: none; }
.cabecera .link-carro { color: #fff; text-decoration: none; font-weight: 600; font-size: 14px; display: flex; gap: 7px; align-items: center; }
.cabecera .conteo { background: var(--ambar-vivo); color: #fff; border-radius: 99px; padding: 1px 8px; font-size: 12px; }

.hero { text-align: center; padding: 34px 0 26px; }
.hero h1 { font-size: 34px; }
.hero p { color: var(--gris); max-width: 34rem; margin: 8px auto 0; }

.buscador { display: flex; gap: 8px; max-width: 560px; margin: 22px auto; }
.buscador input { flex: 1; font: inherit; padding: 13px 16px; border: 1.5px solid var(--borde); border-radius: var(--radio); background: var(--blanco); color: var(--tinta); }
.buscador input:focus { outline: 2px solid var(--verde); border-color: var(--verde); }
.buscador button { font: inherit; font-weight: 600; padding: 13px 22px; border: none; border-radius: var(--radio); background: var(--verde); color: #fff; cursor: pointer; }
.buscador button:hover { background: var(--verde-osc); }

.chips { display: flex; gap: 8px; flex-wrap: wrap; margin: 14px 0; justify-content: center; }
.chips a { color: var(--verde); text-decoration: none; font-size: 13px; font-weight: 500; padding: 7px 14px; border: 1px solid var(--borde); border-radius: 99px; background: var(--blanco); }
.chips a:hover { border-color: var(--verde); }
.chips a.activo { background: var(--verde); border-color: var(--verde); color: #fff; }

.grilla { display: grid; grid-template-columns: repeat(auto-fill, minmax(230px, 1fr)); gap: 14px; }
.tarjeta-producto { background: var(--blanco); border: 1px solid var(--borde); border-radius: var(--radio); padding: 16px; box-shadow: var(--sombra); display: flex; flex-direction: column; gap: 6px; }
.tarjeta-producto .marca-prod { color: var(--verde); font-size: 12px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.06em; }
.tarjeta-producto .nombre { font-weight: 500; flex: 1; }
.tarjeta-producto .mpn { color: var(--gris); font-size: 12px; }
.precio { font-family: var(--font-marca), Georgia, serif; font-size: 22px; font-weight: 600; font-variant-numeric: tabular-nums; }
.leyenda-iva { color: var(--gris); font-size: 11px; }
.agotado { color: var(--gris); font-size: 12px; font-weight: 600; }

.boton-compra { font: inherit; font-weight: 600; padding: 10px 16px; border: none; border-radius: 10px; background: var(--ambar-vivo); color: #fff; cursor: pointer; }
.boton-compra:hover { background: var(--ambar); }
.boton-compra:disabled { opacity: 0.5; cursor: default; }
.boton-secundario { font: inherit; font-weight: 600; padding: 10px 16px; border: 1.5px solid var(--verde); border-radius: 10px; background: transparent; color: var(--verde); cursor: pointer; }

.aviso { background: var(--ambar-suave); color: var(--ambar); border-radius: var(--radio); padding: 12px 16px; margin: 12px 0; }
.aviso.error { background: var(--error-suave); color: var(--error); }
.vacio { color: var(--gris); text-align: center; padding: 40px 0; }

.tabla-carro { width: 100%; border-collapse: collapse; margin-bottom: 16px; }
.tabla-carro td { padding: 10px 8px; border-bottom: 1px solid var(--borde); vertical-align: top; }
.tabla-carro .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
.tabla-carro input[type='number'] { width: 64px; font: inherit; padding: 6px; border: 1px solid var(--borde); border-radius: 8px; background: var(--blanco); color: var(--tinta); }

.formulario { background: var(--blanco); border: 1px solid var(--borde); border-radius: var(--radio); box-shadow: var(--sombra); padding: 18px; display: grid; gap: 12px; max-width: 480px; }
.formulario label { font-size: 13px; font-weight: 600; display: grid; gap: 4px; }
.formulario input { font: inherit; padding: 10px 12px; border: 1px solid var(--borde); border-radius: 10px; background: var(--papel); color: var(--tinta); width: 100%; }
.formulario input:focus { outline: 2px solid var(--verde); border-color: var(--verde); }
.formulario details { border: 1px dashed var(--borde); border-radius: 10px; padding: 10px 12px; }
.formulario summary { cursor: pointer; font-size: 13px; font-weight: 600; color: var(--verde); }
.formulario .honeypot { position: absolute; left: -9999px; opacity: 0; height: 0; overflow: hidden; }

.pie { max-width: 1020px; margin: 0 auto; padding: 22px 16px 34px; color: var(--gris); font-size: 13px; display: flex; justify-content: space-between; gap: 12px; flex-wrap: wrap; border-top: 1px solid var(--borde); }
.pie a { color: var(--verde); font-weight: 600; }

a:focus-visible, button:focus-visible { outline: 2px solid var(--ambar-vivo); outline-offset: 2px; }
@media (max-width: 600px) { .hero h1 { font-size: 27px; } main { padding: 14px 12px 40px; } }
```

- [ ] **Step 7: verificar** — `npm run build -w @rr/tienda`, `npm run typecheck` raíz, `npm test` sigue verde.

- [ ] **Step 8: Commit** — `git add apps/tienda package.json package-lock.json tsconfig.json && git commit -m "feat(tienda): scaffold e identidad Dr. Computacion"`.

---

### Task 2: Conversión de precios (`src/lib/precios.ts`)

**Files:**
- Create: `apps/tienda/src/lib/precios.ts`
- Test: `apps/tienda/tests/precios.test.ts`

**Interfaces:**
- Produces: `interface CfgPrecios { margen: number; tipoCambio: number; iva: number }`; `cfgPrecios(): CfgPrecios | null` (lee env `MARGEN`/`TIPO_CAMBIO_CLP_USD`/`IVA_RATE` en cada llamada; null si inválida — mismos guards del bot: margen > 0, tipoCambio > 0, iva ≥ 0); `ventaNetaClp(costoUsd: number, cfg: CfgPrecios): number`; `precioTiendaClp(costoUsd: number, cfg: CfgPrecios): number` (IVA incluido); `costoMaxUsd(precioTiendaClp: number, cfg: CfgPrecios): number` (inversa, para `precio_max` de la API); `formatCLP(n: number): string`.

- [ ] **Step 1: pruebas que fallan** (`tests/precios.test.ts`):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cfgPrecios, costoMaxUsd, formatCLP, precioTiendaClp, ventaNetaClp } from '../src/lib/precios.js';

afterEach(() => vi.unstubAllEnvs());
const CFG = { margen: 0.13, tipoCambio: 950, iva: 0.19 };

describe('precios', () => {
  it('venta neta = formula EXACTA del bot: round(costo * 1.13 * 950)', () => {
    expect(ventaNetaClp(1.18, CFG)).toBe(1267); // el caso real del smoke test del bot
    expect(ventaNetaClp(100, CFG)).toBe(107350);
  });
  it('precio tienda = venta neta con IVA, redondeado', () => {
    expect(precioTiendaClp(100, CFG)).toBe(Math.round(107350 * 1.19)); // 127747
  });
  it('costoMaxUsd invierte el precio tienda (ida y vuelta no sube el tope)', () => {
    const costo = costoMaxUsd(127747, CFG);
    expect(precioTiendaClp(costo, CFG)).toBeLessThanOrEqual(127747 + 1);
  });
  it('formatCLP con puntos de miles', () => {
    expect(formatCLP(127747)).toBe('$127.747');
  });
  it('cfgPrecios lee env y valida: margen 0 o vacio => null (venderiamos a costo)', () => {
    vi.stubEnv('MARGEN', '0.13'); vi.stubEnv('TIPO_CAMBIO_CLP_USD', '950'); vi.stubEnv('IVA_RATE', '0.19');
    expect(cfgPrecios()).toEqual(CFG);
    vi.stubEnv('MARGEN', '0');
    expect(cfgPrecios()).toBeNull();
    vi.stubEnv('MARGEN', '');
    expect(cfgPrecios()).toBeNull();
  });
});
```

- [ ] **Step 2: ver fallar** — `npx vitest run apps/tienda/tests/precios.test.ts` desde la raíz.

- [ ] **Step 3: implementar** (`src/lib/precios.ts`):

```ts
// Conversion costo->venta IDENTICA a la del bot (buscar-productos-v2):
// la pricing-api entrega COSTOS del mayorista en USD; lo que ve el cliente
// es venta con margen, en CLP, con IVA. Si esta formula divergiera de la del
// bot, los dos canales mostrarian precios distintos para el mismo producto.
export interface CfgPrecios { margen: number; tipoCambio: number; iva: number }

export function cfgPrecios(): CfgPrecios | null {
  const margen = Number(process.env.MARGEN ?? '');
  const tipoCambio = Number(process.env.TIPO_CAMBIO_CLP_USD ?? '');
  const iva = Number(process.env.IVA_RATE ?? '');
  if (![margen, tipoCambio, iva].every(Number.isFinite)) return null;
  if (margen <= 0 || tipoCambio <= 0 || iva < 0) return null; // margen 0 = vender a costo
  return { margen, tipoCambio, iva };
}

export function ventaNetaClp(costoUsd: number, cfg: CfgPrecios): number {
  return Math.round(costoUsd * (1 + cfg.margen) * cfg.tipoCambio);
}

export function precioTiendaClp(costoUsd: number, cfg: CfgPrecios): number {
  return Math.round(ventaNetaClp(costoUsd, cfg) * (1 + cfg.iva));
}

// Inversa para el filtro precio_max de la API (que espera costo en USD).
export function costoMaxUsd(precioTienda: number, cfg: CfgPrecios): number {
  return precioTienda / (1 + cfg.iva) / (1 + cfg.margen) / cfg.tipoCambio;
}

export function formatCLP(n: number): string {
  return '$' + Math.round(n).toLocaleString('es-CL');
}
```

- [ ] **Step 4: ver pasar. Step 5: Commit** — `git add apps/tienda/src/lib/precios.ts apps/tienda/tests/precios.test.ts && git commit -m "feat(tienda): conversion de precios costo->tienda"`.

---

### Task 3: Cliente del catálogo (`src/lib/catalogo.ts`)

**Files:**
- Create: `apps/tienda/src/lib/catalogo.ts`
- Test: `apps/tienda/tests/catalogo.test.ts`

**Interfaces:**
- Consumes: `cfgPrecios`, `precioTiendaClp`, `costoMaxUsd`, `formatCLP` (Task 2).
- Produces:
  - `interface ProductoTienda { sku: string; mpn: string | null; marca: string | null; nombre: string; categoria: string | null; precioClp: number; precioFmt: string; disponible: boolean }`
  - `interface ResultadoBusqueda { productos: ProductoTienda[]; total: number; parcial: boolean; categorias: string[]; marcas: string[] }`
  - `buscarCatalogo(params: { q: string; categoria?: string; marca?: string; precioMaxClp?: number; limite?: number }): Promise<ResultadoBusqueda | null>` (null = API caída o config faltante)
  - `cargarPortada(): Promise<{ categorias: string[] } | null>` (de `/facets`)

- [ ] **Step 1: pruebas que fallan** (`tests/catalogo.test.ts`):

```ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import { buscarCatalogo, cargarPortada } from '../src/lib/catalogo.js';

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

function conEnv() {
  vi.stubEnv('PRICING_API_URL', 'https://oficina.test/api');
  vi.stubEnv('PRICING_API_KEY', 'clave-api');
  vi.stubEnv('MARGEN', '0.13'); vi.stubEnv('TIPO_CAMBIO_CLP_USD', '950'); vi.stubEnv('IVA_RATE', '0.19');
}
// La API entrega COSTO en USD; 100 USD costo => 107.350 neto => 127.747 tienda.
const RESPUESTA = {
  total: 40, evaluados: 12,
  productos: [
    { sku: 'INT-1', mpn: 'X-100', nombre: 'Notebook Pro', marca: 'HP', categoria: 'Computadores', precio: 100, moneda: 'USD', stock: 5 },
    { sku: 'INT-2', mpn: null, nombre: 'Mouse', marca: 'Logitech', categoria: 'Accesorios', precio: 2, moneda: 'USD', stock: 0 },
  ],
  facetas: { categorias: ['Computadores', 'Accesorios'], marcas: ['HP', 'Logitech'], precio: { min: 2, max: 100 } },
};

describe('buscarCatalogo', () => {
  it('convierte a precio tienda y NUNCA expone costo USD ni moneda', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(RESPUESTA), { status: 200 })));
    const r = await buscarCatalogo({ q: 'notebook' });
    expect(r?.productos[0].precioClp).toBe(127747);
    expect(r?.productos[0].precioFmt).toBe('$127.747');
    expect(r?.productos[0].disponible).toBe(true);
    expect(r?.productos[1].disponible).toBe(false);
    // Invariante anti-fuga: ni claves ni valores del costo crudo.
    const json = JSON.stringify(r);
    expect(json).not.toContain('moneda');
    expect(json).not.toContain('"precio":');
    expect(json).not.toContain('USD');
    for (const p of r!.productos) expect(Object.keys(p).sort()).toEqual(['categoria', 'disponible', 'marca', 'mpn', 'nombre', 'precioClp', 'precioFmt', 'sku']);
  });
  it('manda la api key y traduce precioMaxClp al costo USD que la API espera', async () => {
    conEnv();
    const spy = vi.fn(async () => new Response(JSON.stringify(RESPUESTA), { status: 200 }));
    vi.stubGlobal('fetch', spy);
    await buscarCatalogo({ q: 'notebook', precioMaxClp: 127747, marca: 'HP' });
    const [url, init] = spy.mock.calls[0] as unknown as [string, RequestInit];
    expect((init.headers as Record<string, string>)['x-api-key']).toBe('clave-api');
    expect(url).toContain('https://oficina.test/api/search?');
    expect(url).toContain('marca=HP');
    const precioMax = Number(new URL(url).searchParams.get('precio_max'));
    expect(precioMax).toBeGreaterThan(99); expect(precioMax).toBeLessThanOrEqual(100.01);
  });
  it('parcial:true se propaga; API caida o sin env => null', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ ...RESPUESTA, parcial: true }), { status: 200 })));
    expect((await buscarCatalogo({ q: 'x' }))?.parcial).toBe(true);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('tunel caido'); }));
    expect(await buscarCatalogo({ q: 'x' })).toBeNull();
    vi.unstubAllEnvs();
    expect(await buscarCatalogo({ q: 'x' })).toBeNull();
  });
});

describe('cargarPortada', () => {
  it('devuelve las categorias de /facets', async () => {
    conEnv();
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ total_productos: 100, categorias: ['A', 'B'] }), { status: 200 })));
    expect(await cargarPortada()).toEqual({ categorias: ['A', 'B'] });
  });
});
```

- [ ] **Step 2: ver fallar. Step 3: implementar** (`src/lib/catalogo.ts`):

```ts
import { cfgPrecios, costoMaxUsd, formatCLP, precioTiendaClp } from './precios.js';

// Cliente server-side de la pricing-api. La API entrega COSTOS en USD: este
// modulo es la frontera donde se convierten a precio tienda y donde el costo
// MUERE — ProductoTienda no tiene campo para el, y el test de invariante
// vigila que ni claves ni valores crudos sobrevivan.
const TIMEOUT_MS = 21000; // presupuesto de la API (20s) + margen

export interface ProductoTienda {
  sku: string; mpn: string | null; marca: string | null; nombre: string;
  categoria: string | null; precioClp: number; precioFmt: string; disponible: boolean;
}
export interface ResultadoBusqueda {
  productos: ProductoTienda[]; total: number; parcial: boolean;
  categorias: string[]; marcas: string[];
}

function base(): { url: string; key: string } | null {
  const url = process.env.PRICING_API_URL;
  const key = process.env.PRICING_API_KEY;
  if (!url || !key) return null;
  return { url: url.replace(/\/+$/, ''), key };
}

async function apiGet(path: string): Promise<Record<string, unknown> | null> {
  const cfg = base();
  if (!cfg) return null;
  try {
    const r = await fetch(`${cfg.url}${path}`, {
      headers: { 'x-api-key': cfg.key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
      cache: 'no-store',
    });
    if (!r.ok) return null;
    return (await r.json()) as Record<string, unknown>;
  } catch {
    return null;
  }
}

export async function buscarCatalogo(params: {
  q: string; categoria?: string; marca?: string; precioMaxClp?: number; limite?: number;
}): Promise<ResultadoBusqueda | null> {
  const precios = cfgPrecios();
  if (!precios) return null;
  const query = new URLSearchParams({ q: params.q, limite: String(params.limite ?? 24) });
  if (params.categoria) query.set('categoria', params.categoria);
  if (params.marca) query.set('marca', params.marca);
  if (params.precioMaxClp) query.set('precio_max', costoMaxUsd(params.precioMaxClp, precios).toFixed(4));

  const data = await apiGet(`/search?${query.toString()}`);
  if (!data || !Array.isArray(data.productos)) return null;

  const facetas = (data.facetas ?? {}) as { categorias?: string[]; marcas?: string[] };
  return {
    total: Number(data.total ?? 0),
    parcial: data.parcial === true,
    categorias: facetas.categorias ?? [],
    marcas: facetas.marcas ?? [],
    productos: (data.productos as Array<Record<string, unknown>>).map((p) => ({
      sku: String(p.sku ?? ''),
      mpn: p.mpn == null ? null : String(p.mpn),
      marca: p.marca == null ? null : String(p.marca),
      nombre: String(p.nombre ?? ''),
      categoria: p.categoria == null ? null : String(p.categoria),
      precioClp: precioTiendaClp(Number(p.precio), precios),
      precioFmt: formatCLP(precioTiendaClp(Number(p.precio), precios)),
      disponible: Number(p.stock ?? 0) > 0,
    })),
  };
}

export async function cargarPortada(): Promise<{ categorias: string[] } | null> {
  const data = await apiGet('/facets');
  if (!data) return null;
  return { categorias: Array.isArray(data.categorias) ? (data.categorias as string[]) : [] };
}
```

- [ ] **Step 4: ver pasar. Step 5: Commit** — `git add apps/tienda/src/lib/catalogo.ts apps/tienda/tests/catalogo.test.ts && git commit -m "feat(tienda): cliente del catalogo sin fuga de costos"`.

---

### Task 4: Carro (`src/lib/carro.ts`, reemplaza el stub)

**Files:**
- Modify: `apps/tienda/src/lib/carro.ts` (stub de Task 1)
- Test: `apps/tienda/tests/carro.test.ts`

**Interfaces:**
- Produces (todo puro salvo las dos de storage): `ItemCarro` (ya tipado en Task 1); `MAX_LINEAS = 10`; `MAX_UNIDADES = 20`; `agregar(items, nuevo): ItemCarro[] | { error: string }` (suma cantidades si el sku ya está; respeta topes); `cambiarCantidad(items, sku, cantidad): ItemCarro[]` (0 elimina; clamp 1..20); `totalIndicativo(items): number`; `contarUnidades(items): number`; `leerCarro(): ItemCarro[]` y `guardarCarro(items): void` (localStorage clave `drc-carro`, try/catch, y `guardarCarro` despacha `window.dispatchEvent(new Event('carro-cambio'))`).

- [ ] **Step 1: pruebas que fallan** (`tests/carro.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { agregar, cambiarCantidad, contarUnidades, MAX_LINEAS, MAX_UNIDADES, totalIndicativo, type ItemCarro } from '../src/lib/carro.js';

const item = (sku: string, cantidad = 1, precio = 1000): ItemCarro =>
  ({ sku, mpn: 'M', marca: 'HP', nombre: 'Prod', cantidad, precioTiendaClp: precio });

describe('carro', () => {
  it('agregar suma cantidades del mismo sku y respeta el tope por linea', () => {
    let items = agregar([], item('A', 2)) as ItemCarro[];
    items = agregar(items, item('A', 3)) as ItemCarro[];
    expect(items).toHaveLength(1);
    expect(items[0].cantidad).toBe(5);
    const tope = agregar([item('A', MAX_UNIDADES)], item('A', 1));
    expect(tope).toHaveProperty('error');
  });
  it('maximo 10 lineas', () => {
    const diez = Array.from({ length: MAX_LINEAS }, (_, i) => item(`S${i}`));
    expect(agregar(diez, item('OTRO'))).toHaveProperty('error');
  });
  it('cambiarCantidad clampa 1..20 y 0 elimina', () => {
    expect(cambiarCantidad([item('A', 5)], 'A', 0)).toHaveLength(0);
    expect(cambiarCantidad([item('A', 5)], 'A', 99)[0].cantidad).toBe(MAX_UNIDADES);
  });
  it('total indicativo y unidades', () => {
    const items = [item('A', 2, 1000), item('B', 1, 500)];
    expect(totalIndicativo(items)).toBe(2500);
    expect(contarUnidades(items)).toBe(3);
  });
});
```

- [ ] **Step 2: ver fallar. Step 3: implementar** (reemplaza el stub completo):

```ts
// Carro client-side. Las funciones puras se testean; las dos de storage son
// envoltorios finos con try/catch (localStorage puede no existir o lanzar).
export interface ItemCarro {
  sku: string; mpn: string | null; marca: string | null; nombre: string;
  cantidad: number; precioTiendaClp: number;
}

export const MAX_LINEAS = 10;
export const MAX_UNIDADES = 20;
const CLAVE = 'drc-carro';

export function agregar(items: ItemCarro[], nuevo: ItemCarro): ItemCarro[] | { error: string } {
  const existente = items.find((i) => i.sku === nuevo.sku);
  if (existente) {
    if (existente.cantidad + nuevo.cantidad > MAX_UNIDADES) {
      return { error: `Máximo ${MAX_UNIDADES} unidades por producto.` };
    }
    return items.map((i) => (i.sku === nuevo.sku ? { ...i, cantidad: i.cantidad + nuevo.cantidad } : i));
  }
  if (items.length >= MAX_LINEAS) return { error: `Máximo ${MAX_LINEAS} productos distintos por pedido.` };
  return [...items, nuevo];
}

export function cambiarCantidad(items: ItemCarro[], sku: string, cantidad: number): ItemCarro[] {
  if (cantidad <= 0) return items.filter((i) => i.sku !== sku);
  const clamped = Math.min(Math.max(1, Math.round(cantidad)), MAX_UNIDADES);
  return items.map((i) => (i.sku === sku ? { ...i, cantidad: clamped } : i));
}

export function totalIndicativo(items: ItemCarro[]): number {
  return items.reduce((s, i) => s + i.cantidad * i.precioTiendaClp, 0);
}

export function contarUnidades(items: ItemCarro[]): number {
  return items.reduce((n, i) => n + i.cantidad, 0);
}

export function leerCarro(): ItemCarro[] {
  try {
    const crudo = localStorage.getItem(CLAVE);
    const parsed = crudo ? JSON.parse(crudo) : [];
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

export function guardarCarro(items: ItemCarro[]): void {
  try {
    localStorage.setItem(CLAVE, JSON.stringify(items));
    window.dispatchEvent(new Event('carro-cambio'));
  } catch {
    /* storage bloqueado: el carro vive solo en memoria de la pagina */
  }
}
```

- [ ] **Step 4: ver pasar + `npm run build -w @rr/tienda`. Step 5: Commit** — `git add apps/tienda/src/lib/carro.ts apps/tienda/tests/carro.test.ts && git commit -m "feat(tienda): carro con topes y storage defensivo"`.

---

### Task 5: Cliente de Kapso (`src/lib/kapso.ts`)

**Files:**
- Create: `apps/tienda/src/lib/kapso.ts`
- Test: `apps/tienda/tests/kapso.test.ts`

**Interfaces:**
- Produces: `invocarFunction(nombre: string, payload: unknown): Promise<{ status: number; data: Record<string, unknown> } | null>` (null = sin `KAPSO_API_KEY`, red caída, o function no encontrada). Base `https://api.kapso.ai/platform/v1`, header `X-API-Key`. Los IDs se resuelven con `GET /functions` (respuesta `{data: [{id, name}]}`) y se cachean en un `Map` de módulo; `_limpiarCacheKapso()` exportada solo para tests.

- [ ] **Step 1: pruebas que fallan** (`tests/kapso.test.ts`):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invocarFunction, _limpiarCacheKapso } from '../src/lib/kapso.js';

beforeEach(() => { _limpiarCacheKapso(); vi.stubEnv('KAPSO_API_KEY', 'kapso-key'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const FUNCTIONS = { data: [{ id: 'id-generar', name: 'generar-cotizacion-v2' }, { id: 'id-emitir', name: 'emitir-ordenes-compra' }] };

describe('invocarFunction', () => {
  it('resuelve el id por nombre, cachea el listado y postea el payload', async () => {
    const spy = vi.fn(async (url: any, init?: RequestInit) => {
      if (String(url).endsWith('/functions')) return new Response(JSON.stringify(FUNCTIONS), { status: 200 });
      expect(String(url)).toContain('/functions/id-generar/invoke');
      expect((init?.headers as Record<string, string>)['X-API-Key']).toBe('kapso-key');
      expect(JSON.parse(String(init?.body)).execution_context.vars.cart_items[0].sku).toBe('A');
      return new Response(JSON.stringify({ estado: 'ok' }), { status: 200 });
    });
    vi.stubGlobal('fetch', spy);
    const payload = { execution_context: { vars: { cart_items: [{ sku: 'A', mpn: null, marca: null, cantidad: 1 }] }, context: {} } };
    const r1 = await invocarFunction('generar-cotizacion-v2', payload);
    const r2 = await invocarFunction('generar-cotizacion-v2', payload);
    expect(r1?.status).toBe(200);
    expect((r1?.data as any).estado).toBe('ok');
    // 1 listado + 2 invokes = 3 fetches (el listado se cacheo)
    expect(spy).toHaveBeenCalledTimes(3);
    expect(r2?.status).toBe(200);
  });
  it('un status no-2xx del invoke SE DEVUELVE (el caller decide), red caida => null', async () => {
    vi.stubGlobal('fetch', vi.fn(async (url: any) =>
      String(url).endsWith('/functions')
        ? new Response(JSON.stringify(FUNCTIONS), { status: 200 })
        : new Response(JSON.stringify({ estado: 'error', mensaje: 'carro invalido' }), { status: 400 })));
    const r = await invocarFunction('generar-cotizacion-v2', {});
    expect(r?.status).toBe(400);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caida'); }));
    _limpiarCacheKapso();
    expect(await invocarFunction('generar-cotizacion-v2', {})).toBeNull();
  });
  it('function inexistente o sin api key => null', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(FUNCTIONS), { status: 200 })));
    expect(await invocarFunction('no-existe', {})).toBeNull();
    vi.unstubAllEnvs();
    expect(await invocarFunction('generar-cotizacion-v2', {})).toBeNull();
  });
});
```

- [ ] **Step 2: ver fallar. Step 3: implementar** (`src/lib/kapso.ts`):

```ts
// Puente a la Platform API de Kapso: la tienda invoca las MISMAS functions
// que usa el workflow del bot, con un execution context sintetico. Los IDs
// se resuelven por nombre (sobreviven a un recreate de la function) y se
// cachean en memoria del proceso.
const BASE = 'https://api.kapso.ai/platform/v1';
const TIMEOUT_MS = 30000; // generar-cotizacion cotiza en vivo: puede tardar

const cacheIds = new Map<string, string>();

export function _limpiarCacheKapso(): void {
  cacheIds.clear();
}

async function idPorNombre(nombre: string, key: string): Promise<string | null> {
  const cacheado = cacheIds.get(nombre);
  if (cacheado) return cacheado;
  try {
    const r = await fetch(`${BASE}/functions`, {
      headers: { 'X-API-Key': key },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!r.ok) return null;
    const { data } = (await r.json()) as { data: Array<{ id: string; name: string }> };
    for (const f of data ?? []) cacheIds.set(f.name, f.id);
    return cacheIds.get(nombre) ?? null;
  } catch {
    return null;
  }
}

export async function invocarFunction(
  nombre: string,
  payload: unknown,
): Promise<{ status: number; data: Record<string, unknown> } | null> {
  const key = process.env.KAPSO_API_KEY;
  if (!key) return null;
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
    return { status: r.status, data };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: ver pasar. Step 5: Commit** — `git add apps/tienda/src/lib/kapso.ts apps/tienda/tests/kapso.test.ts && git commit -m "feat(tienda): puente a las functions de Kapso"`.

---

### Task 6: Validación y armado del pedido (`src/lib/pedido.ts`)

**Files:**
- Create: `apps/tienda/src/lib/pedido.ts`
- Test: `apps/tienda/tests/pedido.test.ts`

**Interfaces:**
- Consumes: `ItemCarro`, `MAX_LINEAS`, `MAX_UNIDADES` (Task 4).
- Produces:
  - `interface Comprador { nombre: string; telefono: string; email: string }`
  - `interface Facturacion { rut: string; razonSocial: string; giro: string; direccion: string; comuna: string; ciudad: string; emailFactura: string }`
  - `validarPedido(body: unknown): { items: ItemCarro[]; comprador: Comprador; facturacion: Facturacion | null; totalConfirmadoClp: number } | { error: string }` — valida: honeypot `sitio_web` vacío; nombre ≥ 2 chars; teléfono normalizado a dígitos, largo 8–15; email con `@` y `.`; items 1..10 líneas, cantidades enteras 1..20, cada item con `sku` no vacío; facturación TODO-o-NADA (si algún campo viene con texto, se exigen los 7).
  - `armarPayloadCotizacion(items, telefono): unknown` — `{execution_context: {vars: {cart_items: items.map(i => ({sku, mpn, marca, cantidad}))}, context: {phone_number: telefono}}}`
  - `armarPayloadEmision(quote, comprador, facturacion, telefono): unknown` — vars con `quote_result: quote`, `quote_confirmed: true`, `quote_customer_name: comprador.nombre`, y los 7 `billing_*` SOLO si `facturacion` no es null (mapeo: rut→billing_rut, razonSocial→billing_razon_social, giro→billing_giro, direccion→billing_direccion, comuna→billing_comuna, ciudad→billing_ciudad, emailFactura→billing_email); `context: {phone_number: telefono}`.

- [ ] **Step 1: pruebas que fallan** (`tests/pedido.test.ts`):

```ts
import { describe, expect, it } from 'vitest';
import { armarPayloadCotizacion, armarPayloadEmision, validarPedido } from '../src/lib/pedido.js';

const ITEM = { sku: 'A', mpn: 'M-1', marca: 'HP', nombre: 'Prod', cantidad: 2, precioTiendaClp: 1000 };
const BASE = {
  items: [ITEM],
  comprador: { nombre: 'Vicente', telefono: '+56 9 4175 7584', email: 'v@a.cl' },
  sitio_web: '',
  totalConfirmadoClp: 2000,
};

describe('validarPedido', () => {
  it('caso feliz: normaliza el telefono a digitos', () => {
    const r = validarPedido(BASE);
    if ('error' in r) throw new Error(r.error);
    expect(r.comprador.telefono).toBe('56941757584');
    expect(r.facturacion).toBeNull();
  });
  it('honeypot con texto => error (y no dice por que)', () => {
    expect(validarPedido({ ...BASE, sitio_web: 'spam.com' })).toHaveProperty('error');
  });
  it.each([
    ['nombre corto', { nombre: 'V', telefono: '56941757584', email: 'v@a.cl' }],
    ['telefono corto', { nombre: 'Vicente', telefono: '123', email: 'v@a.cl' }],
    ['email sin arroba', { nombre: 'Vicente', telefono: '56941757584', email: 'va.cl' }],
  ])('rechaza %s', (_caso, comprador) => {
    expect(validarPedido({ ...BASE, comprador })).toHaveProperty('error');
  });
  it('facturacion parcial => error; completa => pasa', () => {
    const parcial = { rut: '1-9', razonSocial: '', giro: '', direccion: '', comuna: '', ciudad: '', emailFactura: '' };
    expect(validarPedido({ ...BASE, facturacion: parcial })).toHaveProperty('error');
    const completa = { rut: '1-9', razonSocial: 'Acme', giro: 'Ventas', direccion: 'Calle 1', comuna: 'Ñuñoa', ciudad: 'Santiago', emailFactura: 'f@a.cl' };
    const r = validarPedido({ ...BASE, facturacion: completa });
    if ('error' in r) throw new Error(r.error);
    expect(r.facturacion?.razonSocial).toBe('Acme');
  });
  it('rechaza carro vacio, >10 lineas, cantidad 0 o >20, item sin sku', () => {
    expect(validarPedido({ ...BASE, items: [] })).toHaveProperty('error');
    expect(validarPedido({ ...BASE, items: Array.from({ length: 11 }, (_, i) => ({ ...ITEM, sku: `S${i}` })) })).toHaveProperty('error');
    expect(validarPedido({ ...BASE, items: [{ ...ITEM, cantidad: 0 }] })).toHaveProperty('error');
    expect(validarPedido({ ...BASE, items: [{ ...ITEM, cantidad: 21 }] })).toHaveProperty('error');
    expect(validarPedido({ ...BASE, items: [{ ...ITEM, sku: '' }] })).toHaveProperty('error');
  });
});

describe('payloads', () => {
  it('cotizacion: cart_items con la forma exacta del bot y phone en context', () => {
    const p = armarPayloadCotizacion([ITEM], '56941757584') as any;
    expect(p.execution_context.vars.cart_items).toEqual([{ sku: 'A', mpn: 'M-1', marca: 'HP', cantidad: 2 }]);
    expect(p.execution_context.context.phone_number).toBe('56941757584');
  });
  it('emision: quote_confirmed true; billing_* solo con facturacion', () => {
    const quote = { quote_id: 'q-1', lineas: [], total_clp: 2000 };
    const sin = armarPayloadEmision(quote, { nombre: 'V', telefono: 'x', email: 'e' }, null, '569') as any;
    expect(sin.execution_context.vars.quote_confirmed).toBe(true);
    expect(sin.execution_context.vars.quote_result).toBe(quote);
    expect(sin.execution_context.vars.billing_rut).toBeUndefined();
    const conF = armarPayloadEmision(quote, { nombre: 'V', telefono: 'x', email: 'e' },
      { rut: '1-9', razonSocial: 'Acme', giro: 'G', direccion: 'D', comuna: 'C', ciudad: 'S', emailFactura: 'f@a.cl' }, '569') as any;
    expect(conF.execution_context.vars.billing_razon_social).toBe('Acme');
    expect(conF.execution_context.vars.billing_email).toBe('f@a.cl');
  });
});
```

- [ ] **Step 2: ver fallar. Step 3: implementar** (`src/lib/pedido.ts`):

```ts
import { MAX_LINEAS, MAX_UNIDADES, type ItemCarro } from './carro.js';

export interface Comprador { nombre: string; telefono: string; email: string }
export interface Facturacion {
  rut: string; razonSocial: string; giro: string; direccion: string;
  comuna: string; ciudad: string; emailFactura: string;
}

const CAMPOS_FACT: Array<keyof Facturacion> = ['rut', 'razonSocial', 'giro', 'direccion', 'comuna', 'ciudad', 'emailFactura'];

// Valida el POST del checkout. El honeypot devuelve un error generico a
// proposito: a un bot no se le explica que fallo.
export function validarPedido(body: unknown):
  | { items: ItemCarro[]; comprador: Comprador; facturacion: Facturacion | null; totalConfirmadoClp: number }
  | { error: string } {
  const b = body as Record<string, unknown> | null;
  if (!b || typeof b !== 'object') return { error: 'Pedido inválido.' };
  if (String(b.sitio_web ?? '') !== '') return { error: 'No pudimos procesar tu pedido.' };

  const c = (b.comprador ?? {}) as Record<string, unknown>;
  const nombre = String(c.nombre ?? '').trim();
  const telefono = String(c.telefono ?? '').replace(/\D/g, '');
  const email = String(c.email ?? '').trim();
  if (nombre.length < 2) return { error: 'Cuéntanos tu nombre.' };
  if (telefono.length < 8 || telefono.length > 15) return { error: 'Revisa el teléfono (con código de país, ej. +56 9 ...).' };
  if (!email.includes('@') || !email.includes('.')) return { error: 'Revisa el email.' };

  const crudos = Array.isArray(b.items) ? b.items : [];
  if (crudos.length === 0) return { error: 'El carro está vacío.' };
  if (crudos.length > MAX_LINEAS) return { error: `Máximo ${MAX_LINEAS} productos distintos.` };
  const items: ItemCarro[] = [];
  for (const crudo of crudos as Array<Record<string, unknown>>) {
    const cantidad = Number(crudo.cantidad);
    const sku = String(crudo.sku ?? '').trim();
    if (!sku) return { error: 'Una línea del carro no es válida.' };
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > MAX_UNIDADES) {
      return { error: 'Una cantidad no es válida.' };
    }
    items.push({
      sku,
      mpn: crudo.mpn == null ? null : String(crudo.mpn),
      marca: crudo.marca == null ? null : String(crudo.marca),
      nombre: String(crudo.nombre ?? ''),
      cantidad,
      precioTiendaClp: Number(crudo.precioTiendaClp ?? 0),
    });
  }

  let facturacion: Facturacion | null = null;
  const f = b.facturacion as Record<string, unknown> | undefined;
  if (f && CAMPOS_FACT.some((k) => String(f[k] ?? '').trim() !== '')) {
    const completos = CAMPOS_FACT.every((k) => String(f[k] ?? '').trim() !== '');
    if (!completos) return { error: 'Los datos de facturación van completos o vacíos (los 7 campos).' };
    facturacion = Object.fromEntries(CAMPOS_FACT.map((k) => [k, String(f[k]).trim()])) as unknown as Facturacion;
  }

  return { items, comprador: { nombre, telefono, email }, facturacion, totalConfirmadoClp: Number(b.totalConfirmadoClp ?? 0) };
}

export function armarPayloadCotizacion(items: ItemCarro[], telefono: string): unknown {
  return {
    execution_context: {
      vars: { cart_items: items.map((i) => ({ sku: i.sku, mpn: i.mpn, marca: i.marca, cantidad: i.cantidad })) },
      context: { phone_number: telefono },
    },
  };
}

export function armarPayloadEmision(
  quote: unknown, comprador: Comprador, facturacion: Facturacion | null, telefono: string,
): unknown {
  return {
    execution_context: {
      vars: {
        quote_result: quote,
        quote_confirmed: true,
        quote_customer_name: comprador.nombre,
        ...(facturacion
          ? {
              billing_rut: facturacion.rut,
              billing_razon_social: facturacion.razonSocial,
              billing_giro: facturacion.giro,
              billing_direccion: facturacion.direccion,
              billing_comuna: facturacion.comuna,
              billing_ciudad: facturacion.ciudad,
              billing_email: facturacion.emailFactura,
            }
          : {}),
      },
      context: { phone_number: telefono },
    },
  };
}
```

- [ ] **Step 4: ver pasar. Step 5: Commit** — `git add apps/tienda/src/lib/pedido.ts apps/tienda/tests/pedido.test.ts && git commit -m "feat(tienda): validacion y payloads del pedido"`.

---

### Task 7: API de confirmación (`app/api/confirmar/route.ts`)

**Files:**
- Create: `apps/tienda/app/api/confirmar/route.ts`, `apps/tienda/src/lib/rate-limit.ts`
- Test: `apps/tienda/tests/confirmar.test.ts`

**Interfaces:**
- Consumes: `validarPedido`, `armarPayloadCotizacion`, `armarPayloadEmision` (Task 6); `invocarFunction` (Task 5).
- Produces: `POST /api/confirmar` con el body que valida Task 6. Respuestas:
  - `200 {ok: true, quoteId, totalClp, avisoOc?: true}` — cotizado Y emitido (avisoOc cuando `purchase_orders_ok` vino false: pedido recibido igual).
  - `409 {recotizado: true, totalClp, totalAnteriorClp}` — el total en vivo difiere de `totalConfirmadoClp`; NADA se emitió; el front reintenta con el total nuevo (el server recotiza de nuevo — jamás acepta una quote del navegador; la cotización huérfana en Supabase es inocua).
  - `400 {error}` validación; `422 {error}` la function respondió error de negocio (producto sin precio, carro inválido); `429 {error}` rate limit; `503 {error}` Kapso/red caída.
  - `src/lib/rate-limit.ts`: `permitir(ip: string, ahoraMs: number): boolean` (ventana 10 min, máx 5; Map de módulo; `_limpiarRateLimit()` para tests).

- [ ] **Step 1: pruebas que fallan** (`tests/confirmar.test.ts`):

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { POST } from '../app/api/confirmar/route.js';
import { _limpiarCacheKapso } from '../src/lib/kapso.js';
import { _limpiarRateLimit, permitir } from '../src/lib/rate-limit.js';

beforeEach(() => { _limpiarCacheKapso(); _limpiarRateLimit(); vi.stubEnv('KAPSO_API_KEY', 'k'); });
afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });

const FUNCTIONS = { data: [{ id: 'id-g', name: 'generar-cotizacion-v2' }, { id: 'id-e', name: 'emitir-ordenes-compra' }] };
const QUOTE = { quote_id: 'q-1', lineas: [{ sku_proveedor: 'A' }], neto_clp: 1000, iva_clp: 190, total_clp: 1190, valid_until: '2027-01-01T00:00:00Z' };

function req(body: unknown, ip = '1.2.3.4'): Request {
  return new Request('http://localhost/api/confirmar', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-forwarded-for': ip },
    body: JSON.stringify(body),
  });
}
const BODY = {
  items: [{ sku: 'A', mpn: 'M', marca: 'HP', nombre: 'P', cantidad: 1, precioTiendaClp: 1190 }],
  comprador: { nombre: 'Vicente', telefono: '56941757584', email: 'v@a.cl' },
  sitio_web: '',
  totalConfirmadoClp: 1190,
};

// Enruta: listado de functions, generar (cotiza), emitir.
function stubKapso(opciones: { totalVivo?: number; emitirOk?: boolean; generarStatus?: number } = {}) {
  const llamadas: string[] = [];
  vi.stubGlobal('fetch', vi.fn(async (url: any, init?: RequestInit) => {
    const u = String(url);
    if (u.endsWith('/functions')) return new Response(JSON.stringify(FUNCTIONS), { status: 200 });
    if (u.includes('/id-g/invoke')) {
      llamadas.push('generar');
      if (opciones.generarStatus) return new Response(JSON.stringify({ estado: 'error', mensaje: 'sin precio' }), { status: opciones.generarStatus });
      const quote = { ...QUOTE, total_clp: opciones.totalVivo ?? QUOTE.total_clp };
      return new Response(JSON.stringify({ estado: 'ok', quote }), { status: 200 });
    }
    llamadas.push('emitir');
    return new Response(JSON.stringify({ ok: true, vars: { purchase_orders_ok: opciones.emitirOk !== false } }), { status: 200 });
  }));
  return llamadas;
}

describe('POST /api/confirmar', () => {
  it('flujo feliz: cotiza, emite y responde ok con el quote_id', async () => {
    const llamadas = stubKapso();
    const res = await POST(req(BODY));
    expect(res.status).toBe(200);
    const data = await res.json();
    expect(data.ok).toBe(true);
    expect(data.quoteId).toBe('q-1');
    expect(llamadas).toEqual(['generar', 'emitir']);
  });
  it('total distinto al confirmado: 409 recotizado y NO emite', async () => {
    const llamadas = stubKapso({ totalVivo: 1500 });
    const res = await POST(req(BODY));
    expect(res.status).toBe(409);
    const data = await res.json();
    expect(data.recotizado).toBe(true);
    expect(data.totalClp).toBe(1500);
    expect(llamadas).toEqual(['generar']);
  });
  it('emitir con purchase_orders_ok false: 200 igual, con avisoOc', async () => {
    stubKapso({ emitirOk: false });
    const data = await (await POST(req(BODY))).json();
    expect(data.ok).toBe(true);
    expect(data.avisoOc).toBe(true);
  });
  it('error de negocio de generar (409/400 de la function) => 422 con el mensaje', async () => {
    stubKapso({ generarStatus: 409 });
    const res = await POST(req(BODY));
    expect(res.status).toBe(422);
    expect((await res.json()).error).toContain('sin precio');
  });
  it('validacion mala => 400; red caida => 503', async () => {
    stubKapso();
    expect((await POST(req({ ...BODY, comprador: { nombre: 'V', telefono: '1', email: 'x' } }))).status).toBe(400);
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('caida'); }));
    _limpiarCacheKapso();
    expect((await POST(req(BODY))).status).toBe(503);
  });
  it('sexta confirmacion de la misma IP en la ventana => 429', async () => {
    stubKapso();
    for (let i = 0; i < 5; i++) expect((await POST(req(BODY, '9.9.9.9'))).status).toBe(200);
    expect((await POST(req(BODY, '9.9.9.9'))).status).toBe(429);
    expect((await POST(req(BODY, '8.8.8.8'))).status).toBe(200); // otra IP sigue pasando
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

- [ ] **Step 2: ver fallar. Step 3: implementar**

`src/lib/rate-limit.ts`:
```ts
// Limite de confirmaciones por IP, en memoria del proceso. Best-effort en
// serverless (cada instancia su mapa) — decision del spec, aceptada: la
// proteccion de fondo es que nada se factura automaticamente.
const VENTANA_MS = 10 * 60 * 1000;
const MAX_POR_VENTANA = 5;
const golpes = new Map<string, number[]>();

export function _limpiarRateLimit(): void {
  golpes.clear();
}

export function permitir(ip: string, ahoraMs: number): boolean {
  const recientes = (golpes.get(ip) ?? []).filter((t) => ahoraMs - t < VENTANA_MS);
  if (recientes.length >= MAX_POR_VENTANA) {
    golpes.set(ip, recientes);
    return false;
  }
  recientes.push(ahoraMs);
  golpes.set(ip, recientes);
  return true;
}
```

`app/api/confirmar/route.ts`:
```ts
import { invocarFunction } from '../../../src/lib/kapso.js';
import { armarPayloadCotizacion, armarPayloadEmision, validarPedido } from '../../../src/lib/pedido.js';
import { permitir } from '../../../src/lib/rate-limit.js';

const json = (payload: unknown, status = 200) =>
  new Response(JSON.stringify(payload), { status, headers: { 'content-type': 'application/json' } });

export async function POST(req: Request): Promise<Response> {
  const ip = (req.headers.get('x-forwarded-for') ?? 'sin-ip').split(',')[0].trim();
  if (!permitir(ip, Date.now())) {
    return json({ error: 'Demasiados intentos. Espera unos minutos.' }, 429);
  }

  const body = await req.json().catch(() => null);
  const pedido = validarPedido(body);
  if ('error' in pedido) return json({ error: pedido.error }, 400);

  // 1) Recotizar en vivo: el precio del carro es indicativo; la verdad la
  // pone generar-cotizacion-v2 (mismo motor que el bot). NUNCA se acepta una
  // quote del navegador — seria adulterable.
  const cotizacion = await invocarFunction(
    'generar-cotizacion-v2',
    armarPayloadCotizacion(pedido.items, pedido.comprador.telefono),
  );
  if (cotizacion === null) return json({ error: 'No pudimos procesar tu pedido. Intenta de nuevo.' }, 503);
  const quote = (cotizacion.data as { quote?: { quote_id?: string; total_clp?: number } }).quote;
  if (cotizacion.status !== 200 || !quote?.quote_id) {
    const mensaje = String((cotizacion.data as { mensaje?: string }).mensaje ?? 'Un producto ya no está disponible.');
    return json({ error: mensaje }, 422);
  }

  // 2) El cliente confirmo un total: si el vivo difiere, se le muestra ANTES
  // de emitir nada. La cotizacion recien creada queda huerfana en Supabase —
  // inocua: las cotizaciones son inmutables y sin pedido asociado.
  const totalClp = Number(quote.total_clp ?? 0);
  if (totalClp !== pedido.totalConfirmadoClp) {
    return json({ recotizado: true, totalClp, totalAnteriorClp: pedido.totalConfirmadoClp }, 409);
  }

  // 3) Emitir: OCs por mayorista, persistencia, backoffice. Un fallo parcial
  // de OC no rebota el pedido (contrato honesto del bot: se declara).
  const emision = await invocarFunction(
    'emitir-ordenes-compra',
    armarPayloadEmision(quote, pedido.comprador, pedido.facturacion, pedido.comprador.telefono),
  );
  if (emision === null || emision.status >= 500) {
    // La cotizacion existe pero la emision no corrio: el pedido NO quedo
    // registrado. Honesto: pedir reintento (la idempotencia de emitir
    // absorbe cualquier duplicado).
    return json({ error: 'No pudimos registrar el pedido. Intenta de nuevo en un momento.' }, 503);
  }
  const ok = (emision.data as { ok?: boolean }).ok === true;
  if (!ok) return json({ error: 'No pudimos registrar el pedido. Intenta de nuevo.' }, 503);

  const purchaseOk = (emision.data as { vars?: { purchase_orders_ok?: boolean } }).vars?.purchase_orders_ok === true;
  return json({ ok: true, quoteId: quote.quote_id, totalClp, ...(purchaseOk ? {} : { avisoOc: true }) });
}
```

- [ ] **Step 4: ver pasar + build. Step 5: Commit** — `git add apps/tienda/app/api apps/tienda/src/lib/rate-limit.ts apps/tienda/tests/confirmar.test.ts && git commit -m "feat(tienda): confirmacion que recotiza y emite via Kapso"`.

---

### Task 8: Portada y búsqueda (`/` y `/buscar`)

**Files:**
- Modify: `apps/tienda/app/page.tsx` (reemplaza placeholder)
- Create: `apps/tienda/app/buscar/page.tsx`, `apps/tienda/app/componentes/TarjetaProducto.tsx`, `apps/tienda/app/componentes/BotonAgregar.tsx`
- Test: (las libs ya están testeadas; estas páginas se validan con build — sin tests de componentes, convención del repo)

**Interfaces:**
- Consumes: `buscarCatalogo`, `cargarPortada`, `ProductoTienda` (Task 3); `agregar`, `leerCarro`, `guardarCarro` (Task 4).

- [ ] **Step 1: `app/page.tsx`**

```tsx
import { cargarPortada } from '../src/lib/catalogo.js';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const portada = await cargarPortada();
  return (
    <>
      <section className="hero">
        <h1>El doctor de los computadores</h1>
        <p>Busca entre miles de productos de tecnología: comparamos el precio de tres mayoristas y te damos el mejor, con respaldo formal.</p>
        <form className="buscador" action="/buscar" method="get">
          <input type="search" name="q" placeholder="¿Qué necesitas? Ej: notebook 16GB" required minLength={2} />
          <button type="submit">Buscar</button>
        </form>
      </section>
      {portada && portada.categorias.length > 0 ? (
        <div className="chips">
          {portada.categorias.slice(0, 12).map((c) => (
            <a key={c} href={`/buscar?q=${encodeURIComponent(c)}&categoria=${encodeURIComponent(c)}`}>{c}</a>
          ))}
        </div>
      ) : null}
    </>
  );
}
```

- [ ] **Step 2: `app/componentes/BotonAgregar.tsx`** (client):

```tsx
'use client';
import { useState } from 'react';
import { agregar, guardarCarro, leerCarro } from '../../src/lib/carro.js';
import type { ProductoTienda } from '../../src/lib/catalogo.js';

export function BotonAgregar({ producto }: { producto: ProductoTienda }) {
  const [estado, setEstado] = useState<'listo' | 'agregado' | string>('listo');
  function alCarro() {
    const resultado = agregar(leerCarro(), {
      sku: producto.sku, mpn: producto.mpn, marca: producto.marca,
      nombre: producto.nombre, cantidad: 1, precioTiendaClp: producto.precioClp,
    });
    if ('error' in resultado) { setEstado(resultado.error); return; }
    guardarCarro(resultado);
    setEstado('agregado');
    setTimeout(() => setEstado('listo'), 1500);
  }
  if (!producto.disponible) return <span className="agotado">Sin stock inmediato</span>;
  return (
    <>
      <button className="boton-compra" onClick={alCarro}>
        {estado === 'agregado' ? 'Agregado ✓' : 'Agregar al carro'}
      </button>
      {estado !== 'listo' && estado !== 'agregado' ? <span className="agotado">{estado}</span> : null}
    </>
  );
}
```

- [ ] **Step 3: `app/componentes/TarjetaProducto.tsx`** (server):

```tsx
import type { ProductoTienda } from '../../src/lib/catalogo.js';
import { BotonAgregar } from './BotonAgregar.js';

export function TarjetaProducto({ producto }: { producto: ProductoTienda }) {
  return (
    <div className="tarjeta-producto">
      <span className="marca-prod">{producto.marca ?? 'Sin marca'}</span>
      <span className="nombre">{producto.nombre}</span>
      {producto.mpn ? <span className="mpn">Modelo {producto.mpn}</span> : null}
      <div>
        <div className="precio">{producto.precioFmt}</div>
        <div className="leyenda-iva">IVA incluido</div>
      </div>
      <BotonAgregar producto={producto} />
    </div>
  );
}
```

- [ ] **Step 4: `app/buscar/page.tsx`**

```tsx
import { buscarCatalogo } from '../../src/lib/catalogo.js';
import { TarjetaProducto } from '../componentes/TarjetaProducto.js';

export const dynamic = 'force-dynamic';

export default async function Buscar({ searchParams }: {
  searchParams: Promise<{ q?: string; categoria?: string; marca?: string }>;
}) {
  const { q, categoria, marca } = await searchParams;
  if (!q || q.trim().length < 2) {
    return <p className="vacio">Escribe qué buscas en el buscador de la portada.</p>;
  }
  const r = await buscarCatalogo({ q: q.trim(), categoria, marca });
  if (!r) {
    return <div className="aviso error">No pudimos cargar el catálogo. <a href={`/buscar?q=${encodeURIComponent(q)}`}>Reintentar</a></div>;
  }
  const link = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ q, ...(categoria ? { categoria } : {}), ...(marca ? { marca } : {}), ...extra });
    return `/buscar?${p.toString()}`;
  };
  return (
    <>
      <h1>Resultados para “{q}”</h1>
      {r.marcas.length > 1 ? (
        <div className="chips">
          {marca ? <a href={link({ marca: '' })}>Todas las marcas</a> : null}
          {r.marcas.slice(0, 10).map((m) => (
            <a key={m} href={link({ marca: m })} className={m === marca ? 'activo' : ''}>{m}</a>
          ))}
        </div>
      ) : null}
      {r.parcial ? <div className="aviso">Mostramos lo alcanzado a revisar — puede haber más resultados; intenta acotar la búsqueda.</div> : null}
      {r.productos.length === 0
        ? <p className="vacio">No encontramos productos con precio vigente para esa búsqueda.</p>
        : <div className="grilla">{r.productos.map((p) => <TarjetaProducto key={p.sku} producto={p} />)}</div>}
    </>
  );
}
```

(Nota: el link "Todas las marcas" con `marca: ''` deja el parámetro vacío — `buscarCatalogo` solo agrega `marca` si es truthy, así que equivale a quitarlo.)

- [ ] **Step 5: `npm run build -w @rr/tienda` + `npx vitest run apps/tienda/tests/` verdes. Step 6: Commit** — `git add apps/tienda/app && git commit -m "feat(tienda): portada y busqueda con tarjetas"`.

---

### Task 9: Carro y checkout (`/carro`)

**Files:**
- Create: `apps/tienda/app/carro/page.tsx`, `apps/tienda/app/carro/Checkout.tsx`
- Test: (la lógica está en Tasks 4/6/7; la página se valida con build)

**Interfaces:**
- Consumes: carro (Task 4), `formatCLP` (Task 2 — importable server/client), contrato de `/api/confirmar` (Task 7). Datos del comprador en localStorage clave `drc-comprador` (JSON `{comprador, facturacion}`).

- [ ] **Step 1: `app/carro/page.tsx`**

```tsx
import type { Metadata } from 'next';
import { Checkout } from './Checkout.js';

export const metadata: Metadata = { title: 'Tu carro — Dr. Computación', robots: { index: false } };

export default function Carro() {
  return <Checkout />;
}
```

- [ ] **Step 2: `app/carro/Checkout.tsx`** (client, el componente grande de la tienda):

```tsx
'use client';
import { useEffect, useState } from 'react';
import { cambiarCantidad, guardarCarro, leerCarro, totalIndicativo, type ItemCarro } from '../../src/lib/carro.js';
import { formatCLP } from '../../src/lib/precios.js';

interface DatosGuardados {
  comprador: { nombre: string; telefono: string; email: string };
  facturacion: Record<string, string>;
}
const CLAVE_DATOS = 'drc-comprador';
const FACT_VACIA = { rut: '', razonSocial: '', giro: '', direccion: '', comuna: '', ciudad: '', emailFactura: '' };

function leerDatos(): DatosGuardados {
  try {
    const crudo = localStorage.getItem(CLAVE_DATOS);
    const parsed = crudo ? JSON.parse(crudo) : null;
    return {
      comprador: { nombre: '', telefono: '', email: '', ...(parsed?.comprador ?? {}) },
      facturacion: { ...FACT_VACIA, ...(parsed?.facturacion ?? {}) },
    };
  } catch {
    return { comprador: { nombre: '', telefono: '', email: '' }, facturacion: { ...FACT_VACIA } };
  }
}

export function Checkout() {
  const [items, setItems] = useState<ItemCarro[]>([]);
  const [datos, setDatos] = useState<DatosGuardados>({ comprador: { nombre: '', telefono: '', email: '' }, facturacion: { ...FACT_VACIA } });
  const [estado, setEstado] = useState<'listo' | 'enviando'>('listo');
  const [error, setError] = useState('');
  const [recotizado, setRecotizado] = useState<{ totalClp: number } | null>(null);

  useEffect(() => { setItems(leerCarro()); setDatos(leerDatos()); }, []);

  function actualizar(sku: string, cantidad: number) {
    const nuevos = cambiarCantidad(items, sku, cantidad);
    setItems(nuevos);
    guardarCarro(nuevos);
    setRecotizado(null);
  }

  async function confirmar(totalConfirmadoClp: number) {
    setEstado('enviando'); setError(''); setRecotizado(null);
    try { localStorage.setItem(CLAVE_DATOS, JSON.stringify(datos)); } catch { /* sin memoria, no bloquea */ }
    const res = await fetch('/api/confirmar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items,
        comprador: datos.comprador,
        facturacion: datos.facturacion,
        sitio_web: '', // honeypot: los humanos no lo ven; un bot que lo llena rebota
        totalConfirmadoClp,
      }),
    }).catch(() => null);
    setEstado('listo');
    if (!res) { setError('Sin conexión. Intenta de nuevo.'); return; }
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.recotizado) { setRecotizado({ totalClp: data.totalClp }); return; }
    if (!res.ok) { setError(String(data.error ?? 'No pudimos procesar tu pedido.')); return; }
    guardarCarro([]);
    try { sessionStorage.setItem(`drc-pedido-${data.quoteId}`, JSON.stringify({ totalClp: data.totalClp, avisoOc: data.avisoOc === true })); } catch { /* opcional */ }
    window.location.href = `/pedido/${data.quoteId}`;
  }

  if (items.length === 0) {
    return <p className="vacio">Tu carro está vacío. <a href="/">Busca algo rico en tecnología</a>.</p>;
  }
  const total = totalIndicativo(items);
  const c = datos.comprador;
  const f = datos.facturacion;
  const setC = (campo: string, valor: string) => setDatos({ ...datos, comprador: { ...c, [campo]: valor } });
  const setF = (campo: string, valor: string) => setDatos({ ...datos, facturacion: { ...f, [campo]: valor } });

  return (
    <>
      <h1>Tu carro</h1>
      <table className="tabla-carro">
        <tbody>
          {items.map((i) => (
            <tr key={i.sku}>
              <td><b>{i.nombre}</b><div className="mpn">{i.marca ?? ''}{i.mpn ? ` · ${i.mpn}` : ''}</div></td>
              <td><input type="number" min={0} max={20} value={i.cantidad} onChange={(e) => actualizar(i.sku, Number(e.target.value))} aria-label={`Cantidad de ${i.nombre}`} /></td>
              <td className="num">{formatCLP(i.cantidad * i.precioTiendaClp)}</td>
            </tr>
          ))}
          <tr><td /><td className="num"><b>Total</b></td><td className="num"><b>{formatCLP(total)}</b><div className="leyenda-iva">IVA incluido · se confirma al pedir</div></td></tr>
        </tbody>
      </table>

      <h2>Tus datos</h2>
      <form className="formulario" onSubmit={(e) => { e.preventDefault(); confirmar(recotizado ? recotizado.totalClp : total); }}>
        <label>Nombre<input value={c.nombre} onChange={(e) => setC('nombre', e.target.value)} required minLength={2} /></label>
        <label>WhatsApp<input value={c.telefono} onChange={(e) => setC('telefono', e.target.value)} placeholder="+56 9 ..." required /></label>
        <label>Email<input type="email" value={c.email} onChange={(e) => setC('email', e.target.value)} required /></label>
        <details open={Object.values(f).some((v) => v !== '')}>
          <summary>Datos de facturación (opcional — los 7, o déjalo vacío)</summary>
          <label>RUT<input value={f.rut} onChange={(e) => setF('rut', e.target.value)} /></label>
          <label>Razón social<input value={f.razonSocial} onChange={(e) => setF('razonSocial', e.target.value)} /></label>
          <label>Giro<input value={f.giro} onChange={(e) => setF('giro', e.target.value)} /></label>
          <label>Dirección<input value={f.direccion} onChange={(e) => setF('direccion', e.target.value)} /></label>
          <label>Comuna<input value={f.comuna} onChange={(e) => setF('comuna', e.target.value)} /></label>
          <label>Ciudad<input value={f.ciudad} onChange={(e) => setF('ciudad', e.target.value)} /></label>
          <label>Email factura<input value={f.emailFactura} onChange={(e) => setF('emailFactura', e.target.value)} /></label>
        </details>
        <div className="honeypot" aria-hidden="true">
          <label>Sitio web<input tabIndex={-1} autoComplete="off" name="sitio_web" /></label>
        </div>
        {recotizado ? (
          <div className="aviso">
            Los precios se actualizaron: el total ahora es <b>{formatCLP(recotizado.totalClp)}</b> (antes {formatCLP(total)}).
            Aprieta de nuevo para confirmar con el precio vigente.
          </div>
        ) : null}
        {error ? <div className="aviso error">{error}</div> : null}
        <button className="boton-compra" type="submit" disabled={estado === 'enviando'}>
          {estado === 'enviando' ? 'Procesando…' : recotizado ? `Confirmar por ${formatCLP(recotizado.totalClp)}` : 'Confirmar pedido'}
        </button>
        <p className="leyenda-iva">Sin pago online todavía: te contactamos por WhatsApp para coordinar pago (contado) y entrega.</p>
      </form>
    </>
  );
}
```

(Nota sobre el honeypot: el input NO es controlado a propósito — un humano jamás lo ve ni lo toca y viaja siempre `''` porque `confirmar()` manda `sitio_web: ''` fijo... **Corrección**: para que el honeypot sirva, debe mandarse lo que el input contenga. Implementar así: darle `id="sitio_web"` y en `confirmar()` leerlo del DOM: `const hp = (document.getElementById('sitio_web') as HTMLInputElement | null)?.value ?? '';` y mandar `sitio_web: hp`. Un bot que llena todos los campos lo llena; un humano no puede verlo.)

- [ ] **Step 3: aplicar la corrección del honeypot de la nota** (id + lectura del DOM en `confirmar()`).

- [ ] **Step 4: build + suite verdes. Step 5: Commit** — `git add apps/tienda/app/carro && git commit -m "feat(tienda): carro y checkout con recotizacion visible"`.

---

### Task 10: Confirmación (`/pedido/[id]`)

**Files:**
- Create: `apps/tienda/app/pedido/[id]/page.tsx`, `apps/tienda/app/pedido/[id]/Resumen.tsx`

**Interfaces:**
- Consumes: `formatCLP`; `sessionStorage` clave `drc-pedido-<quoteId>` (Task 9); relé `https://rr-mailing.vercel.app/api/cotizacion/<quoteId>` (PDF).

- [ ] **Step 1: `page.tsx`**

```tsx
import type { Metadata } from 'next';
import { Resumen } from './Resumen.js';

export const metadata: Metadata = { title: 'Pedido recibido — Dr. Computación', robots: { index: false } };

export default async function Pedido({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  return <Resumen quoteId={id} />;
}
```

- [ ] **Step 2: `Resumen.tsx`** (client — el detalle vive en sessionStorage; sin él, la página igual sirve):

```tsx
'use client';
import { useEffect, useState } from 'react';
import { formatCLP } from '../../../src/lib/precios.js';

const RELAY = 'https://rr-mailing.vercel.app';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function Resumen({ quoteId }: { quoteId: string }) {
  const [detalle, setDetalle] = useState<{ totalClp: number; avisoOc: boolean } | null>(null);
  useEffect(() => {
    try {
      const crudo = sessionStorage.getItem(`drc-pedido-${quoteId}`);
      if (crudo) setDetalle(JSON.parse(crudo));
    } catch { /* sin detalle igual mostramos la confirmacion */ }
  }, [quoteId]);

  if (!UUID_RE.test(quoteId)) return <p className="vacio">Pedido no encontrado.</p>;
  return (
    <div className="hero">
      <h1>¡Pedido recibido!</h1>
      <p>
        Gracias por comprar en Dr. Computación.
        {detalle ? <> Tu total es <b>{formatCLP(detalle.totalClp)}</b> (IVA incluido).</> : null}
        {' '}Te contactaremos por WhatsApp para coordinar el pago (contado) y la entrega.
      </p>
      <p><a className="boton-secundario" href={`${RELAY}/api/cotizacion/${quoteId}`} target="_blank" rel="noreferrer">Descargar cotización formal (PDF)</a></p>
      <p className="leyenda-iva">Guarda esta página o el PDF como comprobante de tu pedido.</p>
      <p><a href="/">Volver a la tienda</a></p>
    </div>
  );
}
```

- [ ] **Step 3: build + suite verdes. Step 4: Commit** — `git add apps/tienda/app/pedido && git commit -m "feat(tienda): pagina de pedido recibido"`.

---

### Task 11: README, suite completa y despliegue

**Files:**
- Create: `apps/tienda/README.md`

- [ ] **Step 1: README**

```markdown
# Dr. Computación (tienda web)

E-commerce dropshipping sobre el motor del bot: catálogo desde la
pricing-api (server-side), pedidos vía las functions de Kapso.
Spec: `docs/superpowers/specs/2026-09-03-tienda-dr-computacion-design.md`.

## Variables (proyecto Vercel dr-computacion)

| Variable | Qué es |
|---|---|
| `PRICING_API_URL` | `https://api.pyxis-latam.cl/rr/captador-precios` |
| `PRICING_API_KEY` | la API_SECRET_KEY de la pricing-api |
| `KAPSO_API_KEY` | la misma key de la Platform API que usan los scripts |
| `MARGEN` | `0.13` — DEBE calzar con el del bot |
| `TIPO_CAMBIO_CLP_USD` | `950` — DEBE calzar con el del bot |
| `IVA_RATE` | `0.19` |
| `NEXT_PUBLIC_RAYO_WA` | teléfono del bot para wa.me (solo dígitos); opcional |

## Deploy

1. `cd apps/tienda && npx vercel link --yes --project dr-computacion`
2. En el dashboard: Root Directory `apps/tienda` + las variables de arriba.
3. Desde la RAÍZ: `VERCEL_ORG_ID=<org> VERCEL_PROJECT_ID=<prj> npx vercel --prod --yes`
   (ids en `apps/tienda/.vercel/project.json`). Tras el primer deploy, los
   merges a main despliegan solos (git conectado).

## Desarrollo local

`npm run dev -w @rr/tienda` con las variables en `apps/tienda/.env.local`.
```

- [ ] **Step 2:** `npm test` y `npm run typecheck` desde la raíz, verdes (todo el monorepo).

- [ ] **Step 3: pasos del usuario** (el ejecutor los pide, no los corre — los deploys y el link los bloquea el clasificador): link del proyecto `dr-computacion`, Root Directory, variables, deploy con IDs.

- [ ] **Step 4: verificación e2e** (con el usuario): buscar producto real → agregar → confirmar con datos de prueba → página "Pedido recibido" + PDF; el pedido aparece `nuevo` en el backoffice y las OC llegan al correo; segunda visita: datos precargados; y el link "Háblale al Rayo" abre WhatsApp.

- [ ] **Step 5: Commit** — `git add apps/tienda/README.md && git commit -m "docs(tienda): runbook de deploy"`.
