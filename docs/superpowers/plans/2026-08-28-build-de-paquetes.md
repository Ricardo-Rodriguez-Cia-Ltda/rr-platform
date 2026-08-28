# Build de `packages/*` — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que los paquetes del workspace se puedan consumir desde Vercel por su nombre, compilándolos a JavaScript, sin perder el ciclo local que lee el código fuente.

**Architecture:** Cada paquete gana un `tsconfig.build.json` que emite a `dist/`, y un `exports` condicional que entrega `src/*.ts` a quien pida la condición `development` y `dist/*.js` a todos los demás. `vitest`, `tsx` y `tsc` piden esa condición; Vercel no, y compila los paquetes en su `buildCommand`. Con eso desaparece el parche de imports por ruta relativa de `apps/mailer`.

**Tech Stack:** TypeScript 5 con `moduleResolution: NodeNext` y `customConditions`, npm workspaces, vitest 3, tsx, Vercel Functions.

**Spec:** `docs/superpowers/specs/2026-08-28-build-de-paquetes-design.md`

## Global Constraints

- **Cero cambios de comportamiento.** Ninguna ruta HTTP, ningún cuerpo de respuesta, ningún prompt, ningún nombre de function de Kapso.
- **Las herramientas locales leen `src/`, siempre.** Si `vitest` llegara a leer `dist/`, un `dist/` viejo haría pasar las pruebas contra código viejo. Eso es peor que un error, y es la razón de todo el diseño.
- **`dist/` no se versiona.** Va al `.gitignore`.
- **La suite tiene 686 pruebas y debe seguir teniendo 686.**
- `npm run typecheck` limpio.
- Nombres de archivo e identificadores en **inglés**; comentarios y documentación en **español**.
- **Nunca `git add -A`** — hay carpetas sin trackear en la raíz que son del usuario.
- **Criterio de término del refactor**, verificable con un comando: `grep -rn "from '\.\./.*packages/" apps/ --include="*.ts"` sin resultados.

## Un detalle que decide si esto funciona

`tsconfig.build.json` **no debe heredar `customConditions`**. Si lo heredara, al compilar `@rr/providers` el compilador resolvería `@rr/domain` a su código fuente, intentaría incluirlo en la compilación de `providers` y emitiría archivos fuera de su `rootDir`.

Por eso cada `tsconfig.build.json` lo limpia con `"customConditions": []`, y entonces `providers` resuelve `@rr/domain` a sus declaraciones en `dist/` — que tienen que existir antes. De ahí el orden de compilación.

---

## Estructura de archivos

**Se crean** (uno por paquete): `packages/{domain,http,mailer,providers}/tsconfig.build.json`

**Se modifican:**

| Archivo | Cambio |
|---|---|
| `packages/*/package.json` | `exports` condicional |
| `tsconfig.json` | `customConditions: ["development"]` |
| `vitest.config.ts` | pedir la condición `development` |
| `package.json` (raíz) | script `build:packages` |
| `apps/pricing-api/package.json` | `--conditions` en los tres scripts con `tsx` |
| `apps/mailer/vercel.json` | compilar los paquetes en el `buildCommand` |
| `apps/pricing-api/vercel.json` | lo mismo |
| `apps/mailer/{api,src}/send.ts` | volver a imports por nombre |
| `.gitignore` | `dist/` |
| `CONTRIBUTING.md`, `apps/mailer/README.md` | la afirmación de que el repo no tiene build deja de ser cierta |

---

### Task 1: Probar el mecanismo con un paquete

**Files:**
- Create: `packages/http/tsconfig.build.json`
- Modify: `packages/http/package.json`, `tsconfig.json`, `vitest.config.ts`, `package.json` (raíz), `.gitignore`

**Interfaces:**
- Consumes: nada.
- Produces: la forma exacta del `exports` condicional, del `tsconfig.build.json`, y **la invocación concreta que cada herramienta necesita para pedir la condición**. Las tareas 2 a 4 copian lo que aquí se determine.

`@rr/http` es el paquete más chico —dos archivos, sin dependencias— así que es el probe barato. Esta tarea existe para responder una pregunta antes de apostarle el resto: **¿pueden `vitest`, `tsx` y `tsc` pedir una condición de `exports`, y Vercel no?**

Las tres primeras se prueban aquí. La de Vercel es la Task 3.

- [ ] **Step 1: Ignorar `dist/` antes de generarlo**

En `.gitignore`, junto a las demás entradas:

```
dist/
```

Hacerlo primero evita que un `git add` posterior se lleve artefactos compilados.

- [ ] **Step 2: El `tsconfig.build.json` del paquete**

`packages/http/tsconfig.build.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "customConditions": []
  },
  "include": ["src/**/*.ts"]
}
```

`customConditions: []` limpia la que hereda del raíz. Sin eso, un paquete que importe a otro resolvería su código fuente y lo arrastraría a esta compilación.

- [ ] **Step 3: El `exports` condicional**

`packages/http/package.json` pasa de `"exports": { "./*": "./src/*.ts" }` a:

```json
"exports": {
  "./*": {
    "development": "./src/*.ts",
    "types": "./dist/*.d.ts",
    "default": "./dist/*.js"
  }
}
```

El orden importa: Node y TypeScript toman la primera condición que calce.

- [ ] **Step 4: El script de compilación**

En `package.json` de la raíz, junto a los demás:

```json
"build:packages": "tsc -p packages/http/tsconfig.build.json"
```

Las tareas siguientes le agregan los otros tres, en orden.

- [ ] **Step 5: Que `tsc` pida la condición**

En `tsconfig.json` de la raíz, dentro de `compilerOptions`:

```json
"customConditions": ["development"]
```

Requiere TypeScript 5 y `moduleResolution: NodeNext`, que el repositorio ya usa.

- [ ] **Step 6: Que `vitest` pida la condición**

En `vitest.config.ts`, al mismo nivel que `test`:

```ts
resolve: {
  conditions: ['development'],
},
```

**Verifica que esta forma es la que aplica.** Vitest corre en Node, y según la versión la condición para ese entorno puede tener que ir en `ssr.resolve.conditions` en vez de `resolve.conditions`. La prueba del paso 8 lo dice sin ambigüedad: si `vitest` no está pidiendo la condición, resolverá a `dist/` — que en ese momento **no existe** — y fallará con un error de módulo no encontrado. Ese fallo es la señal; si ocurre, mueve la configuración a `ssr.resolve.conditions`, vuelve a correr, y **anota en tu reporte cuál de las dos funcionó**.

- [ ] **Step 7: Que `tsx` pida la condición**

Los tres scripts de `apps/pricing-api/package.json` — y solo esos — ganan la bandera:

```json
"serve": "tsx --conditions=development --env-file=../../.env.local server.ts",
"check": "tsx --conditions=development --env-file=../../.env.local scripts/check.ts",
"docs:vocabulario": "tsx --conditions=development --env-file=../../.env.local scripts/docs-vocabulario.ts"
```

`apps/kapso-agent` **no se toca**: sus dos scripts con `tsx` no importan ningún paquete del workspace —`grep -rn "@rr/" apps/kapso-agent` no devuelve nada— y el diseño lo deja explícitamente fuera.

Si `tsx` rechaza la bandera, la alternativa es pasarla por `NODE_OPTIONS`. Anota en el reporte cuál funcionó.

- [ ] **Step 8: La prueba que responde la pregunta**

Sin compilar nada todavía — no debe existir ningún `dist/`:

```bash
npm run typecheck
npx vitest run packages/http/tests/auth.test.ts
```

Expected: los dos pasan. Si alguno falla con un módulo no encontrado apuntando a `dist/`, esa herramienta no está pidiendo la condición: arréglala antes de seguir.

Luego, que `tsx` resuelva de verdad:

```bash
npx tsx --conditions=development -e "import('@rr/http/auth').then(m => console.log(typeof m.isAuthorized))"
```

Expected: imprime `function`.

- [ ] **Step 9: Que la compilación produzca lo que debe**

```bash
npm run build:packages
ls packages/http/dist
```

Expected: `auth.js`, `auth.d.ts`, `http.js`, `http.d.ts`.

Y la contraprueba, que es la mitad que importa — que **sin** la condición se obtiene el JavaScript:

```bash
npx tsx -e "import('@rr/http/auth').then(m => console.log(typeof m.isAuthorized))"
```

Expected: imprime `function`, resolviendo a `dist/auth.js` en vez de al fuente. Si esto falla, la rama `default` del `exports` está mal.

- [ ] **Step 10: La suite completa**

```bash
npm test
npm run typecheck
```
Expected: 686 verdes, typecheck limpio.

**Si alguna de las tres herramientas no puede pedir la condición**, para y repórtalo con el error exacto. No inventes una alternativa —alias, `paths`, copiar archivos— sin que el controlador la decida: el diseño entero cuelga de este mecanismo.

- [ ] **Step 11: Commit**

```bash
git add .gitignore tsconfig.json vitest.config.ts package.json packages/http apps/pricing-api/package.json
git commit -m "build: mecanismo de compilacion de paquetes, probado con @rr/http"
```

---

### Task 2: Los otros tres paquetes

**Files:**
- Create: `packages/{domain,mailer,providers}/tsconfig.build.json`
- Modify: `packages/{domain,mailer,providers}/package.json`, `package.json` (raíz)

**Interfaces:**
- Consumes: la forma del `tsconfig.build.json` y del `exports` que fijó la Task 1.
- Produces: los cuatro paquetes compilables. La Task 3 los consume desde Vercel.

- [ ] **Step 1: `tsconfig.build.json` en los tres**

El mismo contenido que el de `@rr/http`, sin cambios:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "noEmit": false,
    "declaration": true,
    "outDir": "dist",
    "rootDir": "src",
    "customConditions": []
  },
  "include": ["src/**/*.ts"]
}
```

- [ ] **Step 2: `exports` condicional en los tres**

`@rr/domain` tiene solo subrutas, igual que `@rr/http`:

```json
"exports": {
  "./*": {
    "development": "./src/*.ts",
    "types": "./dist/*.d.ts",
    "default": "./dist/*.js"
  }
}
```

`@rr/mailer` y `@rr/providers` tienen además una raíz, y ambas partes se convierten:

```json
"exports": {
  ".": {
    "development": "./src/index.ts",
    "types": "./dist/index.d.ts",
    "default": "./dist/index.js"
  },
  "./*": {
    "development": "./src/*.ts",
    "types": "./dist/*.d.ts",
    "default": "./dist/*.js"
  }
}
```

No toques las secciones `dependencies` ni `devDependencies` de ninguno.

- [ ] **Step 3: El orden de compilación**

En `package.json` de la raíz:

```json
"build:packages": "tsc -p packages/domain/tsconfig.build.json && tsc -p packages/http/tsconfig.build.json && tsc -p packages/mailer/tsconfig.build.json && tsc -p packages/providers/tsconfig.build.json"
```

`providers` va último porque importa `@rr/domain`, y al compilar —sin la condición `development`— lo resuelve a las declaraciones en `dist/`, que tienen que existir ya.

- [ ] **Step 4: Verificar que el orden es el correcto**

```bash
rm -rf packages/*/dist
npm run build:packages
```

Expected: compila los cuatro sin errores. Si `providers` falla diciendo que no encuentra `@rr/domain` o sus tipos, el orden está mal o `customConditions: []` falta en su `tsconfig.build.json`.

Y confirma que los cuatro emitieron:

```bash
ls packages/domain/dist packages/http/dist packages/mailer/dist packages/providers/dist
```

- [ ] **Step 5: Que el ciclo local siga leyendo el fuente**

Esta es la que protege contra el modo de falla que motivó el diseño. Rompe a propósito un archivo compilado:

```bash
echo "throw new Error('dist viejo');" > packages/domain/dist/currency.js
npm test
```

Expected: **686 verdes**. Si alguna prueba falla con ese error, `vitest` está leyendo `dist/` y no el fuente — para y repórtalo.

Después restaura:

```bash
npm run build:packages
```

- [ ] **Step 6: Verificar todo**

```bash
npm run typecheck
npm test
npm run serve
```

Con el servidor arriba, en otra terminal:

```bash
curl -s -H "x-api-key: $API_SECRET_KEY" "http://127.0.0.1:3000/api/mejor-precio?mpn=ERC-38B&marca=Epson" | head -c 200
```

Expected: 686 verdes, typecheck limpio, y la respuesta con su forma de siempre (`clave`, `mpn`, `marca`, `mejor`, `ofertas`, `incompleta`). Si el puerto 3000 está ocupado, usa otro.

- [ ] **Step 7: Commit**

```bash
git add packages package.json
git commit -m "build: compilar los cuatro paquetes en orden de dependencia"
```

---

### Task 3: Que Vercel compile los paquetes

**Files:**
- Modify: `apps/mailer/vercel.json`, `apps/pricing-api/vercel.json`

**Interfaces:**
- Consumes: `npm run build:packages` (Task 2).
- Produces: un despliegue que trae `dist/`. La Task 4 lo aprovecha para borrar el parche.

Esta tarea **no** toca los imports todavía. `apps/mailer` sigue con sus rutas relativas, así que el despliegue debería seguir funcionando exactamente igual. Lo que se prueba es que agregar la compilación no rompe nada — y que `dist/` llega.

- [ ] **Step 1: Agregar la compilación al `buildCommand`**

`apps/mailer/vercel.json` ya tiene un `buildCommand` que crea el directorio de salida. Antepón la compilación de los paquetes, conservando intacto lo que ya hacía:

```json
{
  "installCommand": "cd ../.. && npm ci",
  "buildCommand": "cd ../.. && npm run build:packages && cd apps/mailer && mkdir -p salida-vacia && printf 'rr-mailing: solo funciones en /api, sin contenido estatico.' > salida-vacia/index.html",
  "outputDirectory": "salida-vacia",
  "functions": {
    "api/**/*.ts": {
      "maxDuration": 30
    }
  }
}
```

`apps/pricing-api/vercel.json` hoy solo tiene el bloque `functions`, porque esa app no se despliega en Vercel —producción vive en el PC de la oficina— pero su proyecto existe y alguien puede desplegarla. Dale la misma forma, para que el día que se intente no falle por esto:

```json
{
  "installCommand": "cd ../.. && npm ci",
  "buildCommand": "cd ../.. && npm run build:packages && cd apps/pricing-api && mkdir -p salida-vacia && printf 'captador-precios: solo funciones en /api, sin contenido estatico.' > salida-vacia/index.html",
  "outputDirectory": "salida-vacia",
  "functions": {
    "api/**/*.ts": {
      "maxDuration": 30
    }
  }
}
```

`salida-vacia/` ya está en el `.gitignore` por el trabajo de `apps/mailer`; confírmalo antes de commitear.

- [ ] **Step 2: Desplegar**

Desde la **raíz del repositorio**, no desde `apps/mailer` —el proyecto ya aplica `apps/mailer` como Root Directory, así que desplegar desde adentro lo haría buscar `apps/mailer/apps/mailer`—, con las variables del proyecto tomadas de `apps/mailer/.vercel/project.json`:

```bash
PID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("apps/mailer/.vercel/project.json","utf8")).projectId)')
OID=$(node -e 'console.log(JSON.parse(require("fs").readFileSync("apps/mailer/.vercel/project.json","utf8")).orgId)')
VERCEL_PROJECT_ID="$PID" VERCEL_ORG_ID="$OID" npx vercel --prod --yes
```

- [ ] **Step 3: Confirmar en el log que compiló**

```bash
npx vercel inspect <url-del-despliegue> --logs
```

Expected: el log muestra la compilación de los cuatro paquetes y el install trayendo el workspace completo (~184 paquetes, no 7).

- [ ] **Step 4: Que el endpoint siga vivo**

La clave está en el proyecto de Vercel; descárgala con `npx vercel env pull <archivo> --environment=production --yes` desde `apps/mailer`, úsala en una variable, y **borra el archivo al terminar** — contiene la contraseña de Gmail.

```bash
curl -s -X POST "https://rr-mailing.vercel.app/api/send" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"to":"ajeno@example.com","subject":"x","html":"x","text":"x"}' -w " | HTTP %{http_code}\n"
```

Expected: `403 destinatario_no_permitido`. Es la prueba barata de que la función arranca y ejecuta.

- [ ] **Step 5: Commit**

```bash
git add apps/mailer/vercel.json apps/pricing-api/vercel.json
git commit -m "build: compilar los paquetes antes de desplegar en Vercel"
```

---

### Task 4: Borrar el parche

**Files:**
- Modify: `apps/mailer/api/send.ts`, `apps/mailer/src/send.ts`

**Interfaces:**
- Consumes: el despliegue con `dist/` de la Task 3.
- Produces: el criterio de término del refactor.

Aquí es donde se cobra el trabajo: los imports vuelven a ser normales, y el despliegue tiene que seguir funcionando — lo que prueba que Vercel está consumiendo `dist/` de verdad.

- [ ] **Step 1: Devolver los imports a su forma normal**

En `apps/mailer/api/send.ts` y `apps/mailer/src/send.ts`, cada import por ruta relativa hacia `packages/` vuelve a su especificador de paquete:

```ts
// de:
import { isAuthorized } from '../../../packages/http/src/auth.js';
// a:
import { isAuthorized } from '@rr/http/auth';
```

Lo mismo para `@rr/http/http` y para los símbolos de `@rr/mailer`.

**Borra también los comentarios** que explicaban que el parche era temporal: ya no describen nada.

- [ ] **Step 2: El criterio de término**

```bash
grep -rn "from '\.\./.*packages/" apps/ --include="*.ts"
```

Expected: sin salida.

- [ ] **Step 3: Verificar localmente**

```bash
npm run typecheck
npm test
```
Expected: 686 verdes. Las pruebas de `apps/mailer` importan `../src/send.js`, que no cambia, así que deberían pasar sin tocarlas.

- [ ] **Step 4: Desplegar y probar de verdad**

Despliega igual que en la Task 3, y esta vez manda un correo real:

```bash
curl -s -X POST "https://rr-mailing.vercel.app/api/send" \
  -H "x-api-key: $KEY" -H "Content-Type: application/json" \
  -d '{"to":"pyxis.latam@gmail.com","subject":"Prueba tras el build de paquetes","html":"<p>Los imports volvieron a ser normales.</p>","text":"Los imports volvieron a ser normales."}' \
  -w " | HTTP %{http_code}\n"
```

Expected: `200` con `{"ok":true,"id":"<...>"}`.

**Si devuelve 500 con `FUNCTION_INVOCATION_FAILED`**, Vercel no está encontrando `dist/`: para y reporta el log de la función. Ese es exactamente el fallo que este trabajo existe para eliminar, y significa que algo del `buildCommand` o del `exports` está mal.

Borra el archivo de entorno que hayas descargado.

- [ ] **Step 5: Commit**

```bash
git add apps/mailer
git commit -m "refactor(mailer): volver a importar los paquetes por su nombre"
```

---

### Task 5: Documentación

**Files:**
- Modify: `CONTRIBUTING.md`, `apps/mailer/README.md`

- [ ] **Step 1: `CONTRIBUTING.md`**

El documento tiene las secciones `Dónde va cada cosa`, `Nombres`, `tests/docs.test.ts es peligroso…` e `Historial`. Inserta una sección nueva **después de `Dónde va cada cosa`**, con este contenido:

```markdown
## Los paquetes se compilan

`packages/*` se publica de dos formas a la vez. Su `exports` responde distinto según quién pregunte: `src/*.ts` a quien pida la condición `development`, `dist/*.js` a todos los demás.

Las herramientas locales piden esa condición —`vitest` en `vitest.config.ts`, `tsx` en los scripts de `apps/pricing-api`, `tsc` con `customConditions` en el `tsconfig` raíz— así que siempre leen el código fuente. Vercel no la pide, y por eso recibe JavaScript: sus funciones tratan todo lo que llega por `node_modules` como código ya compilado, y un `.ts` ahí las hace fallar al arrancar.

**Que las pruebas lean el fuente no es un detalle.** Si leyeran `dist/`, olvidar compilar antes de correrlas las haría pasar verdes contra código viejo — un resultado incorrecto que parece correcto.

`dist/` no se versiona. Lo genera `npm run build:packages`, y cada app lo compila en su `buildCommand` de Vercel antes de desplegar.

Un paquete nuevo necesita tres cosas: su `tsconfig.build.json` (con `customConditions: []`, para que al compilarlo resuelva las dependencias a `dist/` y no arrastre el fuente ajeno), su `exports` condicional, y una línea en `build:packages` **en el orden de dependencia correcto** — si importa a otro paquete, va después de él.
```

- [ ] **Step 2: `apps/mailer/README.md`**

La sección `### Los imports por ruta relativa a packages/*` describe un parche que dejó de existir. Reemplázala entera por:

```markdown
### Los imports son normales

`api/send.ts` y `src/send.ts` importan `@rr/mailer` y `@rr/http` por su nombre, como cualquier otro consumidor.

Durante un tiempo no fue así: los paquetes exponían TypeScript sin compilar, Vercel trata `node_modules` como código ya compilado, y la función fallaba al arrancar con `ERR_MODULE_NOT_FOUND`. El parche fue importarlos por ruta relativa. Ya no hace falta — los paquetes se compilan y el `buildCommand` los construye antes de desplegar. Ver `CONTRIBUTING.md`.
```

Deja el `buildCommand` del bloque de arriba consistente con lo que quedó en `vercel.json`, que ahora empieza compilando los paquetes.

**No toques** la sección del `outputDirectory` y `salida-vacia`: sigue siendo cierta y sigue siendo necesaria.

- [ ] **Step 3: Verificar y commitear**

```bash
npm test
git add CONTRIBUTING.md apps/mailer/README.md
git commit -m "docs: el repositorio ahora compila sus paquetes"
```

---

## Verificación final

```bash
npm test                  # 686, ni una menos
npm run typecheck
npm run build:packages    # los cuatro, en orden
grep -rn "from '\.\./.*packages/" apps/ --include="*.ts"   # sin salida
```

Y contra el despliegue: un correo real enviado desde `apps/mailer` con imports por nombre de paquete.
