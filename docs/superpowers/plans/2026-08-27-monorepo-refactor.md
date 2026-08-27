# Refactor a monorepo `rr-platform` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Convertir el repositorio en un monorepo con `apps/`, `packages/` e `infra/`, con nombres en inglés y npm workspaces, sin cambiar una sola línea de comportamiento.

**Architecture:** npm workspaces con paquetes "just-in-time": cada paquete expone su código TypeScript directamente por el campo `exports` de su `package.json`, sin build. `tsx` y `vitest` lo resuelven por resolución de Node; `tsc --noEmit` desde la raíz cubre todo el árbol. Los movimientos van primero, los renombres de identificadores después, y cada tarea termina con la suite completa en verde.

**Tech Stack:** npm workspaces, TypeScript 5 con `moduleResolution: NodeNext`, tsx, vitest 3.

**Spec:** `docs/superpowers/specs/2026-08-27-monorepo-refactor-design.md`

## Global Constraints

- **Cero cambios de comportamiento.** Ninguna ruta HTTP, ningún cuerpo de respuesta, ningún nombre de function de Kapso, ningún prompt.
- **Las claves JSON son contrato, no identificadores.** `proveedor`, `ofertas`, `incompleta`, `productos`, `facetas`, `precio`, `moneda`, `stock`, `marca`, `categoria`, `mpn`, `sku` y compañía aparecen en respuestas HTTP y en parámetros de query. **Nunca se renombran**, ni siquiera cuando son propiedades de un tipo TypeScript que sí se renombra. Un renombre de identificador que toque una clave de objeto literal serializado es un cambio de contrato disfrazado.
- **Los archivos bajo `api/` conservan su nombre**: cada uno define una ruta pública (`mejor-precio.ts` → `/mejor-precio`).
- **Los `.js` de Kapso conservan su nombre**: es el nombre de la function desplegada, que el script busca y el grafo referencia.
- **Prosa en español**: prompts, documentación, mensajes de error al cliente, comentarios.
- **Los imports llevan extensión `.js`** (el proyecto usa `moduleResolution: NodeNext`). Un import relativo sin extensión no compila.
- **La suite tiene exactamente 671 pruebas y debe seguir teniendo 671.** Una prueba que desaparece en una mudanza es una prueba que se perdió.
- **`npm run typecheck` limpio** después de cada tarea. Es la red que caza los imports rotos.
- Nombres de paquetes: `@rr/domain`, `@rr/providers`, `@rr/pricing-api`, `@rr/kapso-agent`.
- **`tests/docs.test.ts` lee nueve archivos de código por ruta**, y lo hace al cargar el módulo: una ruta mal deja toda la suite en rojo antes de correr una sola prueba. Cada tarea que mueve uno de esos archivos **actualiza `docs.test.ts` en el mismo commit**. Son `lib/server.ts`, `lib/handlers/{busqueda,producto,facetas,mejor-precio}.ts`, `lib/types.ts`, `lib/search.ts`, `lib/providers/intcomex.ts`, `lib/catalog.ts` y `server.ts`.

---

## Estructura de archivos

Destino final:

```
rr-platform/
├── apps/
│   ├── pricing-api/
│   │   ├── api/            # rutas públicas, nombres intactos
│   │   ├── src/            # auth, http, server, handlers
│   │   ├── scripts/        # check, docs-vocabulario, mock-ingram
│   │   ├── tests/
│   │   ├── server.ts
│   │   ├── vercel.json
│   │   └── package.json
│   └── kapso-agent/
│       ├── functions/      # .js desplegables, nombres intactos
│       ├── prompts/        # v2 vigentes
│       ├── prompts-v1/     # históricos
│       ├── functions-v1-backup/
│       ├── scripts/        # client, deploy-functions, deploy-workflow
│       ├── tests/
│       └── package.json
├── packages/
│   ├── domain/src/         # product, currency, comparator, text, refresh, catalog, search, types
│   └── providers/src/      # intcomex, ingram, tecnoglobal, index
├── infra/office-node/      # los .ps1 y la operación del túnel
├── tests/docs.test.ts      # verifica documentación del repo completo
├── docs/
├── CONTRIBUTING.md
├── vitest.config.ts
├── tsconfig.json
└── package.json            # workspaces + scripts que delegan
```

---

### Task 1: Probar el mecanismo antes de mover 40 archivos

**Files:**
- Modify: `package.json` (workspaces, name, scripts)
- Create: `vitest.config.ts`
- Create: `packages/domain/package.json`
- Create: `packages/domain/src/currency.ts` (movido desde `lib/moneda.ts`)
- Create: `packages/domain/tests/currency.test.ts` (movido desde `tests/moneda.test.ts`)
- Modify: `tsconfig.json`
- Modify: los archivos que importan `lib/moneda.js`

**Interfaces:**
- Consumes: nada.
- Produces: el mecanismo de resolución que usan todas las tareas siguientes — un paquete se declara con `"exports": { "./*": "./src/*.ts" }` y se consume como `@rr/domain/currency`. Y el `vitest.config.ts` cuyo `include` deben respetar las mudanzas posteriores.

Esta tarea existe para responder una pregunta antes de apostar el refactor completo a ella: **¿resuelven `tsx`, `vitest` y `tsc` un paquete del workspace que expone TypeScript sin compilar?** Se prueba con un módulo chico y sin dependencias. Si falla, falla barato.

- [ ] **Step 1: Ver quién importa el módulo que vamos a mover**

Run: `grep -rn "moneda.js" --include="*.ts" .`
Expected: los consumidores. Anótalos; hay que actualizarlos todos en el paso 5.

- [ ] **Step 2: Convertir la raíz en workspace**

En `package.json`, cambiar `"name"` y agregar `"workspaces"`. Los scripts quedan delegando:

```json
{
  "name": "rr-platform",
  "private": true,
  "type": "module",
  "workspaces": ["apps/*", "packages/*"],
  "engines": { "node": ">=20" },
  "scripts": {
    "test": "vitest run",
    "typecheck": "tsc --noEmit"
  }
}
```

Los scripts `check`, `docs:vocabulario`, `serve`, `kapso:functions` y `kapso:workflow` **se mantienen tal cual por ahora** — apuntan a archivos que todavía no se mueven. Se migran en las tareas que mueven esos archivos.

- [ ] **Step 3: Crear el paquete y mover el módulo**

`packages/domain/package.json`:

```json
{
  "name": "@rr/domain",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    "./*": "./src/*.ts"
  }
}
```

Mover el archivo conservando el historial:

```bash
mkdir -p packages/domain/src packages/domain/tests
git mv lib/moneda.ts packages/domain/src/currency.ts
git mv tests/moneda.test.ts packages/domain/tests/currency.test.ts
```

- [ ] **Step 4: Configurar vitest para el árbol nuevo**

`vitest.config.ts` en la raíz — un solo archivo, sin workspaces de vitest, porque un `include` explícito es más fácil de leer que la magia:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'tests/**/*.test.ts',
      'apps/**/tests/**/*.test.ts',
      'packages/**/tests/**/*.test.ts',
    ],
  },
});
```

En `tsconfig.json`, el `include` pasa a cubrir el árbol nuevo:

```json
"include": ["apps/**/*.ts", "packages/**/*.ts", "tests/**/*.ts", "scripts/**/*.ts", "api/**/*.ts", "lib/**/*.ts", "server.ts"]
```

Las entradas viejas (`api`, `lib`, `server.ts`, `scripts`) se van quitando a medida que esas carpetas se vacían.

- [ ] **Step 5: Actualizar los imports**

En `packages/domain/tests/currency.test.ts` y en cada consumidor del paso 1:

```ts
// antes
import { normalizarMoneda } from '../lib/moneda.js';
// después
import { normalizarMoneda } from '@rr/domain/currency';
```

Ojo: el import del paquete **no lleva `.js`**. La extensión es obligatoria solo en imports relativos.

- [ ] **Step 6: Instalar para que npm cree el enlace del workspace**

Run: `npm install`
Expected: `node_modules/@rr/domain` existe como enlace simbólico a `packages/domain`.

- [ ] **Step 7: Probar los tres resolvedores**

```bash
npm run typecheck                                  # tsc
npx vitest run packages/domain/tests/currency.test.ts   # vitest
npx tsx --env-file=.env.local -e "import('@rr/domain/currency').then(m => console.log(typeof m.normalizarMoneda))"   # tsx
```

Expected: typecheck limpio; la prueba pasa; el último imprime `function`.

**Si alguno falla, para y repórtalo.** El plan completo depende de este mecanismo; si no funciona hay que elegir otro (alias de vitest más `paths` de tsconfig) antes de seguir, y esa decisión no es tuya.

- [ ] **Step 8: La suite completa sigue igual**

Run: `npm test`
Expected: 671 pruebas, 30 archivos, todo verde.

- [ ] **Step 9: Commit**

```bash
git add -A
git commit -m "refactor: workspaces npm y primer paquete @rr/domain"
```

---

### Task 2: Mover el resto de `packages/domain`

**Files:**
- Create (movidos): `packages/domain/src/{product,comparator,text,refresh,catalog,search,types}.ts`
- Create (movidos): `packages/domain/tests/{product,comparator,catalog,refresh,search}.test.ts`
- Modify: todos los consumidores

**Interfaces:**
- Consumes: el mecanismo de Task 1 (`@rr/domain/<módulo>`).
- Produces: los módulos de dominio en sus rutas finales. Las tareas 3 y 4 importan desde aquí.

- [ ] **Step 1: Mover archivos y pruebas**

```bash
git mv lib/producto.ts   packages/domain/src/product.ts
git mv lib/comparador.ts packages/domain/src/comparator.ts
git mv lib/texto.ts      packages/domain/src/text.ts
git mv lib/refresco.ts   packages/domain/src/refresh.ts
git mv lib/catalog.ts    packages/domain/src/catalog.ts
git mv lib/search.ts     packages/domain/src/search.ts
git mv lib/types.ts      packages/domain/src/types.ts

git mv tests/producto.test.ts   packages/domain/tests/product.test.ts
git mv tests/comparador.test.ts packages/domain/tests/comparator.test.ts
git mv tests/catalog.test.ts    packages/domain/tests/catalog.test.ts
git mv tests/refresco.test.ts   packages/domain/tests/refresh.test.ts
git mv tests/search.test.ts     packages/domain/tests/search.test.ts
```

- [ ] **Step 2: Arreglar los imports internos del paquete**

Entre módulos del mismo paquete siguen siendo relativos **con extensión**:

```ts
// packages/domain/src/comparator.ts
import type { ProductoNormalizado } from './product.js';
import { claveUnion } from './text.js';
```

- [ ] **Step 3: Arreglar los imports de los consumidores**

Run: `grep -rln "lib/\(producto\|comparador\|texto\|refresco\|catalog\|search\|types\)" --include="*.ts" .`

Cada uno pasa a `@rr/domain/<módulo>`. Ojo con dos que se prestan a confusión: `lib/search.ts` es el buscador del dominio, y `lib/handlers/busqueda.ts` es el handler HTTP — el segundo se mueve en Task 4, no aquí.

- [ ] **Step 4: Ojo con las pruebas que mockean por ruta**

`packages/domain/tests/comparator.test.ts` tiene un `vi.mock('../lib/catalog.js', ...)`. La ruta del mock **tiene que ser exactamente el mismo especificador que usa el código bajo prueba**, o el mock no se aplica y la prueba pasa por la razón equivocada.

```ts
// antes
vi.mock('../lib/catalog.js', async () => { ... });
// después — comparator.ts importa './catalog.js', así que el mock apunta ahí
vi.mock('../src/catalog.js', async () => { ... });
```

Después de arreglarlo, verifica que el mock sigue vivo: rompe a propósito el `obtenerCatalogo` mockeado (haz que lance) y confirma que la prueba **falla**. Devuélvelo y confirma que vuelve a pasar. Un mock que no aplica es la falla silenciosa más cara de esta tarea.

- [ ] **Step 5: Verificar**

```bash
npm run typecheck
npm test
```
Expected: typecheck limpio, 671 pruebas verdes.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: mover el dominio a packages/domain"
```

---

### Task 3: `packages/providers`

**Files:**
- Create (movidos): `packages/providers/src/{index,intcomex,ingram,tecnoglobal}.ts`
- Create: `packages/providers/package.json`
- Create (movidos): `packages/providers/tests/{intcomex-auth,intcomex-batch,intcomex-catalogo,intcomex-provider,ingram,tecnoglobal,providers,provider-parity}.test.ts`
- Modify: consumidores

**Interfaces:**
- Consumes: `@rr/domain/*` (Task 2).
- Produces: `@rr/providers` y `@rr/providers/<proveedor>`. `apps/pricing-api` los consume en Task 4.

- [ ] **Step 1: Crear el paquete**

`packages/providers/package.json`:

```json
{
  "name": "@rr/providers",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "exports": {
    ".": "./src/index.ts",
    "./*": "./src/*.ts"
  }
}
```

A diferencia de `@rr/domain`, este sí tiene raíz (`.`): `index.ts` es el registro de proveedores y se importa como unidad.

- [ ] **Step 2: Mover**

```bash
mkdir -p packages/providers/src packages/providers/tests
git mv lib/providers/index.ts       packages/providers/src/index.ts
git mv lib/providers/intcomex.ts    packages/providers/src/intcomex.ts
git mv lib/providers/ingram.ts      packages/providers/src/ingram.ts
git mv lib/providers/tecnoglobal.ts packages/providers/src/tecnoglobal.ts

git mv tests/intcomex-auth.test.ts      packages/providers/tests/intcomex-auth.test.ts
git mv tests/intcomex-batch.test.ts     packages/providers/tests/intcomex-batch.test.ts
git mv tests/intcomex-catalogo.test.ts  packages/providers/tests/intcomex-catalog.test.ts
git mv tests/intcomex-provider.test.ts  packages/providers/tests/intcomex-provider.test.ts
git mv tests/ingram.test.ts             packages/providers/tests/ingram.test.ts
git mv tests/tecnoglobal.test.ts        packages/providers/tests/tecnoglobal.test.ts
git mv tests/proveedores.test.ts        packages/providers/tests/providers.test.ts
git mv tests/paridad-proveedores.test.ts packages/providers/tests/provider-parity.test.ts
```

- [ ] **Step 3: Arreglar imports**

Dentro del paquete, relativos con `.js`. Hacia el dominio, `@rr/domain/types`, `@rr/domain/product`, etc.

Run: `grep -rln "lib/providers" --include="*.ts" .` y pasa cada consumidor a `@rr/providers`.

- [ ] **Step 4: La fixture de Ingram se mueve con su prueba**

`tests/fixtures/ingram-catalog.json` y `ingram-priceandavailability.json` los lee `packages/providers/tests/ingram.test.ts`, y `tecnoglobal-price.json` su prueba. Muévelos a `packages/providers/tests/fixtures/` y actualiza las rutas de lectura.

`tests/fixtures/tecnoglobal-price.json` — mismo tratamiento.

Las fixtures de Kapso (`ingram-catalog.json` no, pero `mejor-precio-*.json` y `search-intcomex.json` sí) las usan las pruebas de Kapso: **esas se quedan** y se mueven en Task 5.

Run: `grep -rn "fixtures/" --include="*.ts" packages/ tests/ | sort` para ver qué prueba lee qué fixture antes de mover nada.

- [ ] **Step 5: Verificar**

```bash
npm run typecheck
npm test
```
Expected: 671 verdes.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: mover los proveedores a packages/providers"
```

---

### Task 4: `apps/pricing-api`

**Files:**
- Create: `apps/pricing-api/package.json`
- Create (movidos): `apps/pricing-api/api/**` (nombres intactos), `apps/pricing-api/src/{auth,http,server}.ts`, `apps/pricing-api/src/handlers/{search,facets,guards,best-price,product,types}.ts`, `apps/pricing-api/server.ts`, `apps/pricing-api/vercel.json`, `apps/pricing-api/scripts/*`, `apps/pricing-api/tests/*`
- Modify: `package.json` de la raíz (scripts `serve`, `check`, `docs:vocabulario`)

**Interfaces:**
- Consumes: `@rr/domain/*`, `@rr/providers`.
- Produces: la app desplegable. Task 8 documenta su Root Directory en Vercel.

- [ ] **Step 1: Crear el paquete de la app**

`apps/pricing-api/package.json`:

```json
{
  "name": "@rr/pricing-api",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "serve": "tsx --env-file=../../.env.local server.ts",
    "check": "tsx --env-file=../../.env.local scripts/check.ts",
    "docs:vocabulario": "tsx --env-file=../../.env.local scripts/docs-vocabulario.ts"
  }
}
```

- [ ] **Step 2: Mover, con los handlers renombrados**

```bash
mkdir -p apps/pricing-api/src/handlers apps/pricing-api/scripts apps/pricing-api/tests
git mv api apps/pricing-api/api
git mv server.ts apps/pricing-api/server.ts
git mv vercel.json apps/pricing-api/vercel.json
git mv lib/auth.ts   apps/pricing-api/src/auth.ts
git mv lib/http.ts   apps/pricing-api/src/http.ts
git mv lib/server.ts apps/pricing-api/src/app.ts
git mv lib/handlers/busqueda.ts     apps/pricing-api/src/handlers/search.ts
git mv lib/handlers/facetas.ts      apps/pricing-api/src/handlers/facets.ts
git mv lib/handlers/guardas.ts      apps/pricing-api/src/handlers/guards.ts
git mv lib/handlers/mejor-precio.ts apps/pricing-api/src/handlers/best-price.ts
git mv lib/handlers/producto.ts     apps/pricing-api/src/handlers/product.ts
git mv lib/handlers/tipos.ts        apps/pricing-api/src/handlers/types.ts

git mv scripts/check.ts            apps/pricing-api/scripts/check.ts
git mv scripts/docs-vocabulario.ts apps/pricing-api/scripts/docs-vocabulario.ts
git mv scripts/mock-ingram.ts      apps/pricing-api/scripts/mock-ingram.ts

git mv tests/auth.test.ts             apps/pricing-api/tests/auth.test.ts
git mv tests/http.test.ts             apps/pricing-api/tests/http.test.ts
git mv tests/server.test.ts           apps/pricing-api/tests/server.test.ts
git mv tests/price-endpoint.test.ts   apps/pricing-api/tests/price-endpoint.test.ts
git mv tests/search-endpoint.test.ts  apps/pricing-api/tests/search-endpoint.test.ts
git mv tests/product-endpoint.test.ts apps/pricing-api/tests/product-endpoint.test.ts
git mv tests/mejor-precio-endpoint.test.ts apps/pricing-api/tests/best-price-endpoint.test.ts
git mv tests/contrato-errores.test.ts apps/pricing-api/tests/error-contract.test.ts
git mv tests/proveedor-rutas.test.ts  apps/pricing-api/tests/provider-routes.test.ts
git mv tests/credito-mock.test.ts     apps/pricing-api/tests/credit-mock.test.ts
```

`lib/server.ts` pasa a `src/app.ts` porque exporta `createApp` y ya hay un `server.ts` en la raíz de la app: dos archivos llamados `server` en el mismo paquete es exactamente la clase de confusión que este refactor existe para eliminar.

- [ ] **Step 3: Arreglar imports**

`api/*.ts` importa sus handlers con `../src/handlers/<nombre>.js`. `server.ts` importa `./src/app.js` y los paquetes. Todo lo que venía de `lib/` y ahora es paquete pasa a `@rr/domain/*` o `@rr/providers`.

- [ ] **Step 4: El caché ya no está donde el proceso cree**

`packages/domain/src/catalog.ts` resuelve el directorio de caché así:

```ts
return process.env.CATALOG_CACHE_DIR ?? 'cache';
```

Es relativo al directorio de trabajo. Hoy `npm run serve` corre desde la raíz y el caché vive en `cache/` de la raíz. Con el script dentro de `apps/pricing-api`, npm ejecuta desde ahí y `'cache'` pasaría a significar `apps/pricing-api/cache` — el proceso se volvería a bajar los tres catálogos completos, y el de Tecnoglobal tiene cuota.

Arreglo sin dependencias nuevas: se resuelve en el arranque. En `apps/pricing-api/server.ts`, antes de cualquier import que toque el catálogo:

```ts
// El caché vive en la raíz del repositorio, no dentro de la app: los tres
// catalogos se comparten y bajarlos de nuevo cuesta cuota en Tecnoglobal.
process.env.CATALOG_CACHE_DIR ??= new URL('../../cache', import.meta.url).pathname;
```

Verifica que quedó bien **antes** de dar la tarea por buena: `ls cache/` en la raíz debe seguir teniendo los `catalog-*.json`, y `apps/pricing-api/cache/` no debe existir después de arrancar el servidor.

- [ ] **Step 5: Los scripts de la raíz delegan**

En el `package.json` de la raíz:

```json
"serve": "npm run serve -w @rr/pricing-api",
"check": "npm run check -w @rr/pricing-api",
"docs:vocabulario": "npm run docs:vocabulario -w @rr/pricing-api"
```

- [ ] **Step 6: Verificar, incluido un arranque real**

```bash
npm run typecheck
npm test
npm run serve
```

Con el servidor arriba, en otra terminal:

```bash
curl -s -H "x-api-key: $API_SECRET_KEY" "http://127.0.0.1:3000/api/mejor-precio?mpn=ERC-38B&marca=Epson" | head -c 300
```

Expected: 671 verdes, y la respuesta del `curl` con la misma forma de siempre (`clave`, `mpn`, `marca`, `mejor`, `ofertas`, `incompleta`). Si responde 503 `catalogo_no_disponible`, es que el paso 4 quedó mal y se perdió el caché.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: mover la API de precios a apps/pricing-api"
```

---

### Task 5: `apps/kapso-agent`

**Files:**
- Create: `apps/kapso-agent/package.json`
- Create (movidos): `functions/`, `prompts/`, `prompts-v1/`, `functions-v1-backup/`, `scripts/`, `tests/`, los README
- Modify: `apps/kapso-agent/tests/load.ts`, `prompts.test.ts`, `scripts/deploy-*.ts` (rutas)
- Modify: `package.json` de la raíz

**Interfaces:**
- Consumes: nada de los otros paquetes — es autónomo.
- Produces: los scripts `kapso:functions` y `kapso:workflow`.

Esta es la tarea con más rutas hardcodeadas del refactor. Tres archivos leen del disco por ruta relativa y **ninguno falla en typecheck si la ruta queda mal**: fallan en ejecución, o peor, en producción.

- [ ] **Step 1: Inventariar las rutas antes de mover**

Run: `grep -rn "docs/kapso" --include="*.ts" --include="*.md" . | grep -v "^./docs/superpowers"`
Expected: los tres scripts de despliegue, `tests/kapso/cargar.ts`, `tests/prompts.test.ts`, y referencias en documentación. Anótalas todas.

- [ ] **Step 2: Crear el paquete y mover**

`apps/kapso-agent/package.json`:

```json
{
  "name": "@rr/kapso-agent",
  "version": "0.0.0",
  "private": true,
  "type": "module",
  "scripts": {
    "deploy:functions": "tsx --env-file=../../.env.local scripts/deploy-functions.ts",
    "deploy:workflow": "tsx --env-file=../../.env.local scripts/deploy-workflow.ts"
  }
}
```

```bash
mkdir -p apps/kapso-agent/scripts apps/kapso-agent/tests
git mv docs/kapso/functions-v2       apps/kapso-agent/functions
git mv docs/kapso/prompts-v2         apps/kapso-agent/prompts
git mv docs/kapso/prompts            apps/kapso-agent/prompts-v1
git mv docs/kapso/functions-v1-backup apps/kapso-agent/functions-v1-backup
git mv docs/kapso/buscar-productos.js  apps/kapso-agent/functions-v1-backup/buscar-productos-source.js
git mv docs/kapso/detalle-producto.js  apps/kapso-agent/functions-v1-backup/detalle-producto-source.js
git mv docs/kapso/README.md          apps/kapso-agent/README-v1.md
git mv docs/kapso/README-v2.md       apps/kapso-agent/README.md
git mv docs/kapso/prompts-rayo       apps/kapso-agent/prompts-rayo
git mv scripts/kapso.ts              apps/kapso-agent/scripts/client.ts
git mv scripts/kapso-functions.ts    apps/kapso-agent/scripts/deploy-functions.ts
git mv scripts/kapso-workflow-v2.ts  apps/kapso-agent/scripts/deploy-workflow.ts
git mv tests/kapso/cargar.ts         apps/kapso-agent/tests/load.ts
git mv tests/kapso/buscar-productos-v2.test.ts   apps/kapso-agent/tests/buscar-productos-v2.test.ts
git mv tests/kapso/generar-cotizacion-v2.test.ts apps/kapso-agent/tests/generar-cotizacion-v2.test.ts
git mv tests/kapso/emitir-ordenes-compra.test.ts apps/kapso-agent/tests/emitir-ordenes-compra.test.ts
git mv tests/kapso/routers-v2.test.ts            apps/kapso-agent/tests/routers-v2.test.ts
git mv tests/prompts.test.ts                     apps/kapso-agent/tests/prompts.test.ts
mkdir -p apps/kapso-agent/tests/fixtures
git mv tests/fixtures/mejor-precio-ok.json       apps/kapso-agent/tests/fixtures/mejor-precio-ok.json
git mv tests/fixtures/mejor-precio-ambiguo.json  apps/kapso-agent/tests/fixtures/mejor-precio-ambiguo.json
git mv tests/fixtures/search-intcomex.json       apps/kapso-agent/tests/fixtures/search-intcomex.json
```

Los dos `.js` sueltos de v1 llevan sufijo `-source` porque ya existe un archivo con ese nombre en `functions-v1-backup/`: el del repositorio era la fuente autoral y el del respaldo es lo que estaba desplegado, y habían divergido. Conservar ambos, distinguibles, es lo correcto.

- [ ] **Step 3: Arreglar las rutas de las pruebas**

`apps/kapso-agent/tests/load.ts` carga los `.js` por ruta relativa al directorio de trabajo (vitest corre desde la raíz del repo):

```ts
// antes: cargarHandler('docs/kapso/functions-v2/generar-cotizacion-v2.js')
// después: cargarHandler('apps/kapso-agent/functions/generar-cotizacion-v2.js')
```

Actualiza la constante en cada prueba que la use.

En `prompts.test.ts`, las raíces:

```ts
const RAICES = ['apps/kapso-agent/prompts-v1', 'apps/kapso-agent/prompts'];
```

Y las rutas de las fixtures en las tres pruebas que las leen.

- [ ] **Step 4: Arreglar las rutas de los scripts de despliegue**

`deploy-functions.ts` lee `docs/kapso/functions-v2/${nombre}.js` y `deploy-workflow.ts` lee `docs/kapso/prompts-v2/${agente}/`. Ambos corren con `tsx` desde `apps/kapso-agent`, así que las rutas pasan a ser relativas a ahí: `functions/${nombre}.js` y `prompts/${agente}/`.

**Deriva la ruta de `import.meta.url`, no del directorio de trabajo**, para que el script funcione igual si alguien lo corre desde la raíz:

```ts
const RAIZ_APP = new URL('..', import.meta.url).pathname;
const codigo = readFileSync(`${RAIZ_APP}functions/${nombre}.js`, 'utf8');
```

- [ ] **Step 5: Scripts de la raíz**

```json
"kapso:functions": "npm run deploy:functions -w @rr/kapso-agent",
"kapso:workflow": "npm run deploy:workflow -w @rr/kapso-agent"
```

- [ ] **Step 6: Verificar contra la cuenta real**

```bash
npm run typecheck
npm test
npm run kapso:functions
```

Expected: 671 verdes. Y el despliegue reporta las seis functions **sin cambios de código** — es la prueba de que las rutas siguen resolviendo al mismo contenido. Si reporta que actualizó código, alguna ruta apunta a otro archivo: para y revisa antes de commitear.

Límites: no toques functions de v1, no toques `Rayo Perez`, no actives nada, no borres nada.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "refactor: mover los artefactos de Kapso a apps/kapso-agent"
```

---

### Task 6: `infra/` y limpiar lo que quedó vacío

**Files:**
- Create (movidos): `infra/office-node/{install-autostart.ps1,verify-autostart.ps1}`
- Delete: `lib/`, `scripts/`, `tests/kapso/` (vacíos)
- Modify: `tsconfig.json`

- [ ] **Step 1: Mover los scripts de infraestructura**

```bash
mkdir -p infra/office-node
git mv scripts/install-autostart.ps1 infra/office-node/install-autostart.ps1
git mv scripts/verify-autostart.ps1  infra/office-node/verify-autostart.ps1
```

- [ ] **Step 2: Ajustar la ruta de uso en los `.ps1`**

Los dos scripts registran una Tarea Programada que hace `cd` a la raíz del proyecto y corre `npm run serve`. Eso **sigue funcionando tal cual**: el script de la raíz ahora delega al workspace, así que el comando no cambia.

Lo único que hay que corregir es el comentario de uso de la cabecera, que dice cómo invocarlos:

```powershell
# antes:   powershell -ExecutionPolicy Bypass -File scripts/install-autostart.ps1
# después: powershell -ExecutionPolicy Bypass -File infra/office-node/install-autostart.ps1
```

Run: `grep -n scripts infra/office-node/*.ps1`
Expected: solo las líneas de comentario que acabas de corregir.

- [ ] **Step 3: Confirmar que no quedó nada atrás**

```bash
find lib scripts tests/kapso -type f 2>/dev/null
```
Expected: sin salida. Si aparece algo, muévelo a donde corresponda antes de borrar los directorios.

```bash
rmdir lib/handlers lib/providers lib scripts tests/kapso 2>/dev/null
```

- [ ] **Step 4: Limpiar `tsconfig.json`**

El `include` queda solo con lo que existe:

```json
"include": ["apps/**/*.ts", "packages/**/*.ts", "tests/**/*.ts", "infra/**/*.ts"]
```

- [ ] **Step 5: Verificar**

```bash
npm run typecheck
npm test
```
Expected: 671 verdes.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "refactor: mover la operacion del PC de oficina a infra/"
```

---

### Task 7: Identificadores al inglés

**Files:**
- Modify: todo `packages/` y `apps/pricing-api/`

**Interfaces:**
- Consumes: la estructura completa de las tareas 1-6.
- Produces: los nombres definitivos. Nada posterior depende de esto.

Este es el paso con más riesgo de romper el contrato sin darse cuenta, así que la regla manda antes que la lista.

**Qué se renombra:** nombres de funciones, tipos, constantes y variables de TypeScript.

**Qué NO se renombra, jamás:**
- Claves de objetos que se serializan a JSON en una respuesta HTTP: `proveedor`, `ofertas`, `incompleta`, `mejor`, `criterio`, `productos`, `facetas`, `total`, `evaluados`, `precio`, `moneda`, `stock`, `marca`, `categoria`, `mpn`, `sku`, `nombre`, `clave`, `sin_resultados`, `motivo`, `alternativa`, `error`, `detail`.
- Nombres de parámetros de query: `q`, `marca`, `categoria`, `precio_max`, `solo_con_stock`, `limite`, `proveedor`, `sku`, `mpn`, `upc`.
- Valores de enums que viajan en respuestas: `mas_barato_con_stock`, `stock_desconocido`, `mas_barato_sin_stock`, `catalogo_no_disponible`, `proveedor_no_configurado`, `sin_precio`, `upstream`, `sobre_presupuesto`, `sin_stock`, `not_found`, `ambiguo`, `no_comparable`.
- Nombres de variables de entorno.

Un tipo TypeScript se puede renombrar aunque sus propiedades no: `interface Oferta` puede pasar a `interface Offer` conservando `proveedor`, `sku`, `precio`, `moneda`, `stock` como propiedades.

- [ ] **Step 1: Renombrar los tipos**

| Hoy | Queda |
|---|---|
| `Proveedor` | `Provider` |
| `ProveedorAusente` | `MissingProvider` |
| `Oferta` | `Offer` |
| `OfertaGanadora` | `WinningOffer` |
| `Comparacion` | `Comparison` |
| `Criterio` | `Criterion` |
| `Facetas` | `Facets` |
| `ProductoNormalizado` | `NormalizedProduct` |
| `ProductoIntcomex` | `IntcomexProduct` |
| `ProductoIngram` | `IngramProduct` |
| `ProductoTecnoglobal` | `TecnoglobalProduct` |
| `ResolucionSku` | `SkuResolution` |

- [ ] **Step 2: Renombrar las funciones y constantes**

| Hoy | Queda |
|---|---|
| `PROVEEDORES` | `PROVIDERS` |
| `resolverProveedor` | `resolveProvider` |
| `proveedoresConfigurados` | `configuredProviders` |
| `estaConfigurado` | `isConfigured` |
| `timeoutProveedor` | `providerTimeout` |
| `MENSAJE_CUOTA` | `QUOTA_MESSAGE` |
| `MAX_SKUS_POR_LLAMADA` | `MAX_SKUS_PER_CALL` |
| `cargarCatalogo` | `loadCatalog` |
| `obtenerCatalogo` | `getCatalog` |
| `catalogosNoDisponibles` | `unavailableCatalogs` |
| `hayAlgunCatalogo` | `hasAnyCatalog` |
| `refrescarTodos` | `refreshAll` |
| `normalizarProducto` | `normalizeProduct` |
| `normalizarMoneda` | `normalizeCurrency` |
| `normalizar` | `normalize` |
| `tokenizar` | `tokenize` |
| `compactarMpn` | `compactMpn` |
| `claveUnion` | `unionKey` |
| `claveDeSku` | `skuKey` |
| `marcaCanonica` | `canonicalBrand` |
| `resolverClaves` | `resolveKeys` |
| `compararPorClave` | `compareByKey` |
| `buscar` | `search` |
| `calcularFacetas` | `computeFacets` |
| `crearHandlerBusqueda` | `createSearchHandler` |
| `crearHandlerBusquedaPorRuta` | `createSearchByRouteHandler` |
| `crearHandlerFacetas` | `createFacetsHandler` |
| `crearHandlerFacetasPorRuta` | `createFacetsByRouteHandler` |
| `crearHandlerMejorPrecio` | `createBestPriceHandler` |
| `crearHandlerProducto` | `createProductHandler` |
| `crearHandlerProductoPorRuta` | `createProductByRouteHandler` |
| `resolverOResponder` | `resolveOrRespond` |
| `_resetCatalogoParaTests` | `_resetCatalogForTests` |
| `_resetFotoParaTests` | `_resetSnapshotForTests` |
| `fetchConTimeout` | `fetchWithTimeout` |
| `olvidarToken` | `forgetToken` |

Los que ya están en inglés se quedan intactos: `isAuthorized`, `firstString`, `buildAuthToken`, `buildSignature`, `createApp`, `formatUtcTimestamp`, `ProviderError`, `ProviderErrorKind`, `CatalogUnavailableError`, `PriceInfo`, `PriceQuery`, `PriceResult`, `SearchFilters`, `ScoredProduct`, `Handler`.

- [ ] **Step 3: Renombrar variables locales y parámetros**

Los identificadores internos en español (`respuesta`, `datos`, `crudo`, `esperado`, `entorno`) también pasan a inglés. Es mecánico; el compilador te dice si te equivocas.

**No toques los comentarios**: siguen en español.

Y hay un consumidor que el compilador no va a atrapar: `tests/docs.test.ts` parsea interfaces **por nombre**, con `camposDeInterfaz(..., 'PriceResult')` y `camposDeInterfaz(..., 'Facetas')`. Al renombrar `Facetas` a `Facets`, ese literal tiene que cambiar también. Si no, la prueba busca una interfaz que ya no existe y pasa sin verificar nada.

- [ ] **Step 4: Verificar que no se coló un cambio de contrato**

Es el paso que justifica la tarea. Antes de commitear:

```bash
npm run typecheck
npm test
```

Y la prueba de verdad — arranca el servidor y compara una respuesta real contra la de antes del refactor:

```bash
npm run serve
# en otra terminal
curl -s -H "x-api-key: $API_SECRET_KEY" "http://127.0.0.1:3000/api/mejor-precio?mpn=ERC-38B&marca=Epson" > /tmp/despues.json
node -e "const d=require('/tmp/despues.json'); console.log(Object.keys(d).sort().join(','), '|', Object.keys(d.mejor).sort().join(','), '|', Object.keys(d.ofertas[0]).sort().join(','))"
```

Expected exactamente: `clave,incompleta,marca,mejor,mpn,nombre,ofertas | criterio,moneda,precio,proveedor,sku,stock | moneda,precio,proveedor,sku,stock`

Si alguna clave salió en inglés, se renombró algo que era contrato. Revierte esa parte.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "refactor: identificadores en ingles, contratos intactos"
```

---

### Task 8: Convenciones, documentación y renombre del repositorio

**Files:**
- Create: `CONTRIBUTING.md`
- Modify: `README.md`, `docs/kapso/README.md` (referencias movidas), `apps/kapso-agent/README.md`
- Modify: `tests/docs.test.ts`

- [ ] **Step 1: Escribir `CONTRIBUTING.md`**

Con las cinco reglas del diseño, cada una con su porqué en una línea:

```markdown
# Cómo se organiza este repositorio

## Dónde va cada cosa

**Una app es algo que se despliega. Un paquete es algo que se importa.**
Si tiene un destino de despliegue propio, va en `apps/`. Si lo consume otra
cosa del repositorio, va en `packages/`.

**No se extrae un paquete con un solo consumidor.** El segundo consumidor es
el que justifica la extracción; antes de eso es adivinar.

## Nombres

**Inglés adentro, contratos externos intactos.** Archivos e identificadores
en inglés. No se tocan: rutas HTTP, claves JSON de respuestas, parámetros de
query, valores de enum que viajan al cliente, nombres de functions en Kapso.

**Prosa en español.** Prompts, documentación, mensajes al cliente y
comentarios. El negocio se piensa en español chileno.

## Historial

El refactor de agosto 2026 movió y renombró casi todo. `git blame` sobre esos
archivos muestra ese commit; usa `git log --follow <archivo>` para el
historial real.
```

- [ ] **Step 2: Confirmar que `tests/docs.test.ts` quedó al día**

Las tareas 2 a 5 ya debieron actualizar sus nueve rutas. Confirma que ninguna quedó apuntando al árbol viejo:

Run: `grep -nE "'(lib|api|scripts|docs/kapso)/" tests/docs.test.ts`
Expected: sin salida.

Si aparece algo, el destino de cada una: `lib/server.ts` → `apps/pricing-api/src/app.ts`; `lib/handlers/busqueda.ts` → `apps/pricing-api/src/handlers/search.ts`; `producto` → `product`; `facetas` → `facets`; `mejor-precio` → `best-price`; `lib/types.ts` → `packages/domain/src/types.ts`; `lib/search.ts` → `packages/domain/src/search.ts`; `lib/providers/intcomex.ts` → `packages/providers/src/intcomex.ts`; `lib/catalog.ts` → `packages/domain/src/catalog.ts`; `server.ts` → `apps/pricing-api/server.ts`.

- [ ] **Step 3: Actualizar el README de la raíz**

El README describe la estructura vieja y cómo levantar el servidor. Reescribe la sección de estructura con el árbol nuevo, y verifica que cada comando que menciona siga siendo válido (`npm run serve`, `npm test`, `npm run check`).

Agrega un mapa de una línea por app y paquete: qué es, qué expone, dónde se despliega.

- [ ] **Step 4: Verificar**

```bash
npm run typecheck
npm test
```
Expected: 671 verdes.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "docs: convenciones del monorepo y README del arbol nuevo"
```

- [ ] **Step 6: Renombrar el repositorio — lo hace una persona**

Estos pasos tocan servicios externos y **no** los ejecuta el implementador:

1. GitHub → Settings → Rename repository → `rr-platform`.
2. Actualizar el remoto local:
   ```bash
   git remote set-url origin git@github.com:Ricardo-Rodriguez-Cia-Ltda/rr-platform.git
   git remote -v
   ```
3. Vercel → proyecto `captador-precios-proveedores` → Settings → General → **Root Directory** = `apps/pricing-api`. Sin esto el despliegue apunta a una raíz que ya no tiene `api/`.
4. Renombrar la carpeta local a `rr-platform`. Es lo último: invalida el directorio de trabajo de cualquier proceso abierto.

Deja estos cuatro pasos escritos en el reporte final para que el humano los ejecute.

---

## Verificación final

```bash
npm test          # 671, ni una menos
npm run typecheck
npm run serve     # y una consulta real a /mejor-precio
npm run kapso:functions   # las seis functions, sin cambios de codigo
```

Y una revisión de que no quedó nada huérfano:

```bash
find . -path ./node_modules -prune -o -name "*.ts" -print | grep -vE "^\./(apps|packages|tests|infra)/" 
```
Expected: solo `vitest.config.ts`.
