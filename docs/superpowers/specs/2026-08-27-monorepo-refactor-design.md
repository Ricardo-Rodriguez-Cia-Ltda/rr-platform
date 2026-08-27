# Diseño: refactor a monorepo (`rr-platform`)

**Fecha:** 2026-08-27
**Estado:** Aprobado

## Problema

El repositorio nació como una sola cosa: una API que consulta precios en los catálogos de tres mayoristas. Ya no es solo eso. Hoy convive con los artefactos desplegables de un agente de WhatsApp en Kapso —functions, prompts, scripts de despliegue— que viven bajo `docs/`, que es el lugar equivocado para código que corre en producción.

Y va a crecer más: otras APIs, herramientas para el agente, una base de datos, un bucket donde guardar cada cotización, un e-commerce, un frontend de administración. La estructura actual no tiene dónde poner nada de eso.

El objetivo de este refactor no es agregar ninguna de esas piezas. Es construir la casa donde van a vivir, con nombres y límites claros, para que agregarlas después sea barato y para que un agente que lea el repositorio entienda cómo hablan entre sí.

**No cambia ninguna funcionalidad.** Ni una ruta, ni una respuesta, ni un nombre de function desplegada.

## Alcance

**Incluido:**

- Renombrar el repositorio de GitHub a `rr-platform` y alinear `package.json` y la carpeta local.
- Reorganizar en `apps/`, `packages/` e `infra/` con npm workspaces.
- Sacar los artefactos desplegables de Kapso de `docs/` a `apps/kapso-agent/`.
- Pasar a inglés todos los nombres de archivo e identificadores de código.
- Mover cada prueba junto al paquete que verifica.
- Documentar las convenciones y la dirección de infraestructura.

**Fuera de alcance:**

- Cualquier cambio de comportamiento: rutas HTTP, formas de respuesta, nombres de functions en Kapso, contenido de prompts.
- Mover el runtime a Vercel. Este refactor deja la costura; el movimiento es su propio proyecto (ver "Infraestructura").
- Agregar paquetes para piezas que todavía no existen (`quotes-store`, `ui`, `config`). Aparecen cuando haya un consumidor real.
- Turborepo. npm workspaces alcanza hasta que haya varias apps con builds lentos; hoy no hay ni un build.
- Traducir prompts, documentación o mensajes al cliente.

## Decisiones tomadas

### `rr-platform`, no `captador-precios-proveedores`

El nombre actual describe lo que el repositorio era. Con fronts y e-commerce adentro, queda corto y confunde. `rr-platform` es neutro y no se queda chico.

GitHub redirige el nombre viejo indefinidamente para clones y `git push`, así que el cambio no rompe a nadie de inmediato. Aun así hay que actualizar el remoto local, el proyecto de Vercel y cualquier enlace en la documentación.

La carpeta local sigue llamándose `scrapper-proveedores`. Renombrarla invalida el directorio de trabajo de cualquier proceso abierto, así que es el **último** paso y lo hace una persona, no el refactor.

### npm workspaces

Viene con npm, no agrega dependencias, y `apps/*` + `packages/*` es la convención que cualquiera reconoce. Turborepo se monta encima el día que se justifique, sin rehacer la estructura.

### Inglés adentro, contratos externos intactos

Todo nombre de archivo y todo identificador de código pasa a inglés. Pero hay tres clases de nombres que **no** son código interno, y esas no se tocan:

1. **Rutas HTTP** (`/mejor-precio`, `/facetas`, `?proveedor=`). Las consumen functions ya desplegadas en Kapso. Renombrarlas es cambiar funcionalidad y exige un redespliegue coordinado.
2. **Nombres de functions en Kapso** (`generar-cotizacion-v2`, `emitir-ordenes-compra`). El script de despliegue las busca por nombre, y el grafo del workflow las referencia. Renombrarlas significa crear functions nuevas contra una cuota que ya está llena.
3. **Prosa**: prompts, documentación, mensajes al cliente. Es contenido de negocio en español chileno, no código.

Los archivos `.js` de las functions conservan el nombre de la function desplegada, precisamente porque ese nombre es el contrato.

### El runtime no se mueve en este refactor

Ver "Infraestructura". La dirección está decidida; el movimiento no es parte de esto.

## Arquitectura

```
rr-platform/
├── apps/
│   ├── pricing-api/          # la API de precios: rutas, servidor, auth
│   └── kapso-agent/          # lo que se despliega a Kapso
├── packages/
│   ├── providers/            # intcomex, ingram, tecnoglobal
│   └── domain/               # producto, moneda, comparación, catálogo, búsqueda
├── infra/
│   └── office-node/          # autoarranque y túnel del PC de la oficina
├── docs/
└── package.json              # workspaces, scripts que delegan
```

### Por qué esos límites

`packages/domain` y `packages/providers` son lo único genuinamente reutilizable hoy: un servicio de cotizaciones futuro los necesitaría igual. Todo lo demás —auth, helpers HTTP, guardas de request— tiene un solo consumidor, así que se queda dentro de `apps/pricing-api` hasta que aparezca el segundo. Extraer un paquete con un solo consumidor es adivinar.

`apps/kapso-agent` existe porque hoy los artefactos que corren en producción están mezclados con la documentación. Que las functions, los prompts y el script que arma el grafo vivan juntos es lo que hace obvio que son una unidad desplegable.

### Mapa de movimientos

**`apps/pricing-api/`** — la app conserva `api/` en su raíz porque es la convención que Vercel espera.

| Hoy | Queda en |
|---|---|
| `api/price.ts` | `apps/pricing-api/api/price.ts` |
| `api/search.ts` | `apps/pricing-api/api/search.ts` |
| `api/product.ts` | `apps/pricing-api/api/product.ts` |
| `api/facetas.ts` | `apps/pricing-api/api/facetas.ts` |
| `api/mejor-precio.ts` | `apps/pricing-api/api/mejor-precio.ts` |
| `api/[proveedor]/*.ts` | `apps/pricing-api/api/[proveedor]/*.ts` |
| `api/credito/mock.ts` | `apps/pricing-api/api/credito/mock.ts` |
| `lib/auth.ts` | `apps/pricing-api/src/auth.ts` |
| `lib/http.ts` | `apps/pricing-api/src/http.ts` |
| `lib/server.ts` | `apps/pricing-api/src/server.ts` |
| `server.ts` (raíz) | `apps/pricing-api/server.ts` |
| `lib/handlers/busqueda.ts` | `apps/pricing-api/src/handlers/search.ts` |
| `lib/handlers/facetas.ts` | `apps/pricing-api/src/handlers/facets.ts` |
| `lib/handlers/guardas.ts` | `apps/pricing-api/src/handlers/guards.ts` |
| `lib/handlers/mejor-precio.ts` | `apps/pricing-api/src/handlers/best-price.ts` |
| `lib/handlers/producto.ts` | `apps/pricing-api/src/handlers/product.ts` |
| `lib/handlers/tipos.ts` | `apps/pricing-api/src/handlers/types.ts` |
| `vercel.json` | `apps/pricing-api/vercel.json` |

Los nombres de archivo bajo `api/` **no cambian**: cada uno define una ruta pública.

**`packages/providers/`**

| Hoy | Queda en |
|---|---|
| `lib/providers/index.ts` | `packages/providers/src/index.ts` |
| `lib/providers/intcomex.ts` | `packages/providers/src/intcomex.ts` |
| `lib/providers/ingram.ts` | `packages/providers/src/ingram.ts` |
| `lib/providers/tecnoglobal.ts` | `packages/providers/src/tecnoglobal.ts` |

**`packages/domain/`**

| Hoy | Queda en |
|---|---|
| `lib/producto.ts` | `packages/domain/src/product.ts` |
| `lib/moneda.ts` | `packages/domain/src/currency.ts` |
| `lib/comparador.ts` | `packages/domain/src/comparator.ts` |
| `lib/texto.ts` | `packages/domain/src/text.ts` |
| `lib/refresco.ts` | `packages/domain/src/refresh.ts` |
| `lib/catalog.ts` | `packages/domain/src/catalog.ts` |
| `lib/search.ts` | `packages/domain/src/search.ts` |
| `lib/types.ts` | `packages/domain/src/types.ts` |

**`apps/kapso-agent/`**

| Hoy | Queda en |
|---|---|
| `docs/kapso/functions-v2/*.js` | `apps/kapso-agent/functions/*.js` |
| `docs/kapso/prompts-v2/` | `apps/kapso-agent/prompts/` |
| `scripts/kapso.ts` | `apps/kapso-agent/scripts/client.ts` |
| `scripts/kapso-functions.ts` | `apps/kapso-agent/scripts/deploy-functions.ts` |
| `scripts/kapso-workflow-v2.ts` | `apps/kapso-agent/scripts/deploy-workflow.ts` |
| `docs/kapso/README.md`, `README-v2.md` | `apps/kapso-agent/` |
| `docs/kapso/prompts/` (v1) | `apps/kapso-agent/prompts-v1/` |
| `docs/kapso/functions-v1-backup/` | `apps/kapso-agent/functions-v1-backup/` |
| `docs/kapso/*.js` (v1 sueltas) | `apps/kapso-agent/functions-v1-backup/` |

Los `.js` conservan su nombre: es el nombre de la function desplegada.

**`infra/office-node/`**: `scripts/install-autostart.ps1`, `scripts/verify-autostart.ps1`, y la documentación de operación del túnel.

**El resto de `scripts/`**: `check.ts`, `docs-vocabulario.ts` y `mock-ingram.ts` pasan a `apps/pricing-api/scripts/`, porque son herramientas de esa app. La carpeta `scripts/` de la raíz queda vacía y se elimina.

### Pruebas

Cada prueba se muda junto a lo que verifica:

- `packages/domain/tests/`: `comparador`, `moneda`, `producto`, `search`, `catalog`, `refresco`.
- `packages/providers/tests/`: `ingram`, `tecnoglobal`, `intcomex-*`, `proveedores`, `paridad-proveedores`.
- `apps/pricing-api/tests/`: `auth`, `http`, `server`, `*-endpoint`, `contrato-errores`, `proveedor-rutas`, `credito-mock`.
- `apps/kapso-agent/tests/`: todo `tests/kapso/`, más `prompts.test.ts`.
- Raíz: `docs.test.ts`, que verifica documentación del repositorio completo.

Vitest se configura con un workspace para que `npm test` en la raíz siga corriendo todo de una vez.

Las rutas hardcodeadas dentro de las pruebas cambian con la mudanza. `tests/kapso/cargar.ts` carga los `.js` por ruta relativa, `prompts.test.ts` recorre los directorios de prompts, y `docs.test.ts` lee documentación por ruta: los tres necesitan sus rutas actualizadas y son el punto más probable de fallo del refactor.

## Convenciones

Quedan escritas en un `CONTRIBUTING.md` en la raíz, porque una convención que no está escrita no existe:

- **Nombres de archivo e identificadores en inglés.** Contratos externos —rutas HTTP, nombres de functions en Kapso— conservan los suyos.
- **Prosa en español.** Prompts, documentación, mensajes al cliente y de error.
- **Una app es algo que se despliega. Un paquete es algo que se importa.** Si tiene un destino de despliegue propio, va en `apps/`. Si lo consume otra cosa del repositorio, va en `packages/`.
- **No se extrae un paquete con un solo consumidor.** El segundo consumidor es el que justifica la extracción.
- **Los diseños viven en `docs/superpowers/specs/`, los planes en `docs/superpowers/plans/`.** Sin cambios.

## Infraestructura

### Dónde corre hoy

La API **no** corre en Vercel, aunque el proyecto existe. Intcomex bloquea las IPs dinámicas de Vercel por whitelist (ErrorCode 14), así que la API se sirve desde un PC de la oficina —cuya IP sí está registrada— con `npm run serve`, y sale a internet por un Cloudflare Tunnel bajo `https://api.pyxis-latam.cl/rr/captador-precios`.

### A dónde va

Todo lo que pueda vivir en Vercel, vive en Vercel; el PC de la oficina empuja hacia el sistema desplegado en vez de ser consultado por él.

Eso es directo para los catálogos, que ya se descargan completos y se cachean: un proceso en la oficina los baja y los sube a un almacén que la API en Vercel lee.

El obstáculo real es más chico y más específico: **la revalidación de precio y stock por SKU al momento de cotizar**. Hoy consulta al proveedor en vivo, desde la IP de la oficina, dentro del request. Un empuje periódico no puede darle eso. Hay dos salidas, y elegir es un proyecto propio:

- **Aceptar instantáneas**, con la edad del dato declarada en la respuesta para que el agente pueda advertir. Simple, y el precio deja de ser en vivo.
- **Una pasarela mínima en la oficina** que la API en Vercel consulte solo para esa revalidación. Conserva el precio en vivo a costa de un salto de red en el camino crítico.

Lo que este refactor hace al respecto: `packages/providers` queda detrás de una interfaz y `apps/pricing-api` deja de asumir dónde corre. Ambas salidas quedan aditivas.

### Vercel

El proyecto de Vercel apunta a la raíz del repositorio. Con la mudanza hay que apuntarlo a `apps/pricing-api` (Root Directory) y mover ahí `vercel.json`. Es configuración en el panel, no código, y hay que hacerla junto con el despliegue del refactor.

## Riesgos y cómo se contienen

| Riesgo | Contención |
|---|---|
| Un import roto pasa desapercibido | `npm run typecheck` los caza todos: TypeScript en `strict` no compila con una ruta mala |
| Una prueba con ruta hardcodeada falla al mudarse | Son tres conocidas (`cargar.ts`, `prompts.test.ts`, `docs.test.ts`); se actualizan en el mismo paso que la mudanza |
| La superficie HTTP cambia sin querer | `contrato-errores.test.ts` y las de endpoint la verifican; además, arranque real del servidor antes de cerrar |
| El proyecto de Vercel queda apuntando a una raíz que ya no tiene `api/` | Se cambia el Root Directory en el mismo momento del renombre del repositorio |
| El renombre del repositorio rompe el remoto local | GitHub redirige indefinidamente; aun así se actualiza el remoto explícitamente |
| Los scripts de despliegue de Kapso quedan con rutas viejas | Leen `docs/kapso/...` por ruta relativa; se actualizan y se verifican con una corrida real contra la cuenta |

## Verificación

El criterio de que el refactor no rompió nada:

1. `npm test` verde con las mismas 671 pruebas. Ni una menos: una prueba que desaparece en una mudanza es una prueba que se perdió.
2. `npm run typecheck` limpio.
3. `npm run serve` levanta y responde una consulta real a `/mejor-precio` con el mismo cuerpo que antes.
4. `npm run kapso:functions` reporta las seis functions sin cambios de código contra la cuenta —confirma que las rutas de los scripts siguen resolviendo.

## Riesgos conocidos

- **El refactor toca casi todos los archivos.** Cualquier rama abierta en paralelo va a conflictuar. Por eso `feat/rr-isia-version2` se fusionó antes de empezar.
- **`docs/` queda más chico pero sigue mezclando** documentación de producto (`docs/api/`) con documentación de proceso (`docs/superpowers/`). No lo toco en este refactor: no molesta todavía y ya hay bastante movimiento.
- **El renombre a inglés hace ilegible el `git blame`** de los archivos movidos. `git log --follow` sigue funcionando, y vale la pena que quede escrito en `CONTRIBUTING.md`.
