# Diseño: build de `packages/*`

**Fecha:** 2026-08-28
**Estado:** Aprobado
**Depende de:** PR #15. Este trabajo borra el parche de rutas relativas que ese PR documenta, así que se rama desde `feat/mailer-worker` y se integra después.

## Problema

Los cuatro paquetes del monorepo —`@rr/domain`, `@rr/providers`, `@rr/http`, `@rr/mailer`— exponen **TypeScript sin compilar**: su `package.json` dice que su código está en `src/*.ts`.

Eso funciona con las tres herramientas locales, porque las tres entienden TypeScript: `tsx` para el servidor, `vitest` para las pruebas, `tsc` para el typecheck. Se probó explícitamente al armar el monorepo, y por eso se decidió no tener build.

Vercel funciona distinto: **compila el archivo de entrada de la función, pero trata todo lo que llega por `node_modules` como JavaScript ya compilado.** Los paquetes del workspace llegan por ahí, así que Vercel encuentra un `.ts` donde espera un `.js` y la función falla al arrancar con `ERR_MODULE_NOT_FOUND`.

Se descubrió desplegando `apps/mailer`, y se parcheó importando los paquetes por **ruta relativa** (`../../../packages/mailer/src/index.js`), que los mete en el grafo de código fuente que Vercel sí compila. Funciona, pero es por app: cada app nueva en Vercel repite el truco, y un truco que se copia a mano es un truco que alguien copia mal.

La dirección elegida para el repositorio es que todo lo que pueda vivir en Vercel viva ahí — fronts, e-commerce, más APIs. Con el parche actual, cada una de esas apps choca con la misma pared.

## Alcance

**Incluido:**

- Un paso de compilación para los cuatro paquetes: `src/*.ts` → `dist/*.js` más sus declaraciones.
- `exports` condicional en cada paquete: código fuente para las herramientas locales, `dist/` para todo lo demás.
- La configuración correspondiente en `vitest`, `tsx` y `tsc`.
- El `buildCommand` de las apps desplegadas en Vercel compilando los paquetes antes de desplegar.
- Borrar el parche de rutas relativas de `apps/mailer` y devolverle sus imports normales.

**Fuera de alcance:**

- **Mover `apps/pricing-api` a Vercel.** Hoy corre en el PC de la oficina por la whitelist de IP de Intcomex, y moverla exige decidir antes si la oficina empuja instantáneas o si queda una pasarela allá. Es un cambio de comportamiento con su propio diseño.
- Los ~92 identificadores en español que quedan en archivos de prueba. Independiente; mezclarlo haría el diff ilegible.
- Cualquier cambio de comportamiento. Ninguna ruta HTTP, ninguna respuesta, ningún prompt, ningún nombre de function de Kapso.

## Decisiones tomadas

### Condiciones de `exports`, no alias por herramienta

`package.json` permite responder distinto según quién pregunte:

```json
"exports": {
  "./*": {
    "development": "./src/*.ts",
    "default": "./dist/*.js"
  }
}
```

La regla vive **una vez, en el paquete**. La alternativa —dejar `exports` apuntando solo a `dist` y poner alias en `vitest`, en `tsx` y en el `tsconfig`— repite la misma decisión en tres archivos que se desincronizan sin avisar.

### Las herramientas locales siguen leyendo el código fuente

Se descartó la variante simple de compilar y que todo lea `dist/`, por un motivo concreto: obligaría a compilar antes de cada corrida de pruebas, y el día que alguien lo olvide **las pruebas pasan verdes contra código viejo**. Un resultado incorrecto que parece correcto es peor que un error.

Con la condición `development`, `vitest` y `tsx` leen `src/` siempre. No hay estado intermedio que pueda mentir.

### `dist/` no se versiona

Se genera en el `buildCommand` de cada despliegue. Versionar artefactos compilados produce diffs ilegibles y conflictos de merge sin información.

### Los cuatro paquetes, no solo los que Vercel consume hoy

Hoy solo `@rr/mailer` y `@rr/http` los consume una app desplegada en Vercel. Compilar los cuatro cuesta lo mismo, evita que la regla tenga excepciones que nadie recuerda, y `@rr/domain` y `@rr/providers` van a hacer falta en cuanto `pricing-api` se mueva.

## Arquitectura

```
packages/domain/
  src/*.ts              ← lo que escribes
  dist/*.js + *.d.ts    ← lo que se despliega (no versionado)
  tsconfig.build.json   ← hereda del raíz; emite
  package.json          ← exports condicional
```

Igual para `http`, `mailer` y `providers`.

### Quién lee qué

| Consumidor | Cómo pide | Qué recibe |
|---|---|---|
| `vitest` | `resolve.conditions: ['development']` | `src/*.ts` |
| `tsx` | `--conditions=development` en el script | `src/*.ts` |
| `tsc` | `customConditions` en el `tsconfig` raíz | `src/*.ts` |
| Vercel | no pide ninguna condición | `dist/*.js` |

El `tsconfig` raíz sigue siendo el del typecheck, con `noEmit`. Los `tsconfig.build.json` por paquete son los únicos que emiten.

### El orden de compilación importa

`@rr/providers` importa `@rr/domain`. Durante la compilación no se pide la condición `development`, así que `providers` resuelve `@rr/domain` a sus declaraciones en `dist/` — que tienen que existir antes. El script compila en orden de dependencia: `domain`, `http` y `mailer` primero, `providers` después.

### La limpieza es el criterio de término

`apps/mailer` vuelve a importar `@rr/mailer` y `@rr/http` por su nombre, y desaparecen los comentarios que explicaban el parche.

El criterio es objetivo y lo verifica un comando:

```bash
grep -rn "from '../.*packages/" apps/ --include="*.ts"
```

Sin resultados. Busca **imports relativos** que salgan hacia `packages/`, no cualquier mención de la palabra: un comentario o una ruta en un string no son el defecto.

## Riesgos y cómo se contienen

| Riesgo | Contención |
|---|---|
| Que `tsx` no respete `--conditions` | Es la suposición de la que cuelga el ciclo local. Se prueba **primero**, con un solo paquete, antes de tocar los otros tres |
| Que `tsc` no resuelva `customConditions` | Se prueba en el mismo paso; requiere TypeScript 5 y `moduleResolution: NodeNext`, que el repositorio ya usa |
| Que Vercel no encuentre `dist/` | El `buildCommand` de cada app compila antes; si falla, el despliegue falla ruidosamente, no en silencio |
| Que alguien corra las pruebas contra `dist/` viejo | No puede: las condiciones hacen que `vitest` lea siempre `src/` |
| Que el orden de compilación falle | El script lo fija explícitamente; un orden mal puesto rompe la compilación de inmediato |

## Verificación

1. Las **686 pruebas** verdes, leyendo el código fuente. Ni una menos.
2. `npm run typecheck` limpio.
3. `npm run build:packages` produce `dist/` en los cuatro paquetes, con `.js` y `.d.ts`.
4. `npm run serve` levanta y responde una consulta real a `/mejor-precio`.
5. `apps/mailer` desplegado con imports normales manda un correo real: `200` con `messageId`.
6. El `grep` de imports relativos hacia `packages/` sin resultados.

## Riesgos conocidos

- **El tiempo de build en Vercel crece**, porque ahora compila los paquetes antes de desplegar. Son cuatro paquetes pequeños; el costo es de segundos.
- **Un `dist/` viejo en la máquina de alguien** no afecta las pruebas ni el servidor local, pero sí un despliegue hecho a mano desde esa máquina. Los despliegues de Vercel compilan desde cero, así que solo aplica a un `vercel --prod` local.
- **`apps/kapso-agent` no participa.** Sus artefactos son JavaScript plano que se sube tal cual a Cloudflare Workers, y no importa ningún paquete del workspace. Queda como está.
