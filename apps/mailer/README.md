# `apps/mailer` — el relé de correo propio

Un endpoint HTTP, `POST /api/send`, que manda correo por el SMTP de Gmail.
Reemplaza a Resend: Resend cobraba por un plan que no se quería, y hoy es
esta app la que envía las órdenes de compra que emite
`apps/kapso-agent/functions/emitir-ordenes-compra.js`. El proyecto de Vercel
se llama `rr-mailing`, desplegado en `https://rr-mailing.vercel.app`. (El
enlace local vive en `apps/mailer/.vercel/project.json`, pero ese archivo
está en `.gitignore` y no existe en un clon nuevo hasta que se corre
`vercel link`.)

`POST /api/send` no sabe nada de mayoristas, cotizaciones ni de la base D1
del Worker que lo llama — solo recibe `{ to, subject, html, text }`
autenticado, decide si puede mandarlo, y lo manda. Toda la lógica de negocio
(agrupar por mayorista, la reserva idempotente, qué hacer si falla) vive en
quien lo llama, no acá.

Esta app tiene un segundo endpoint, `GET /api/cotizacion/<quote_id>`, que sí
conoce las cotizaciones: lee la fila en Supabase y devuelve el PDF. Ver la
sección dedicada más abajo.

## Arquitectura

```
emitir-ordenes-compra (Cloudflare Worker, Kapso)
   │  POST /api/send  ·  header x-api-key
   ▼
apps/mailer (Vercel, Node)      — este directorio
   │  usa @rr/mailer
   ▼
packages/mailer  ──SMTP──►  smtp.gmail.com  ──►  casilla interna
```

`packages/mailer` (`createGmailTransport` + `createMailer`) es quien de
verdad habla SMTP; esta app solo valida la petición HTTP y decide si la
deja pasar. El diseño completo está en
`docs/superpowers/specs/2026-08-27-mailer-fase-1-design.md`.

## Variables de entorno

Las cinco son obligatorias. Si falta cualquiera, el endpoint responde
`500 falta_configuracion` nombrando cuáles faltan — nunca sus valores (ver
`apps/mailer/api/send.ts`).

| Variable | Qué es | De dónde sale |
|---|---|---|
| `MAILER_API_KEY` | La clave que el endpoint exige en el header `x-api-key` | Generada a mano, cargada como variable **Sensitive** en el proyecto `rr-mailing` de Vercel. El mismo valor tiene que estar cargado como secreto en la function `emitir-ordenes-compra` de Kapso (también `MAILER_API_KEY`) — si no coinciden, el Worker recibe `401 no_autorizado` en cada intento |
| `GMAIL_USER` | La cuenta de Gmail que envía | La casilla que se decidió usar como remitente (hoy la interna, `pyxis.latam@gmail.com`) |
| `GMAIL_APP_PASSWORD` | Contraseña de aplicación de esa cuenta | Se genera en la cuenta de Google (`myaccount.google.com` → Seguridad → Contraseñas de aplicaciones), y exige verificación en dos pasos activada en esa cuenta. **No es la contraseña normal de la cuenta** — es un valor de 16 caracteres pensado para esto, revocable sin tocar el resto de la cuenta |
| `MAILER_FROM` | El `From` del mensaje | Tiene que ser la misma dirección que `GMAIL_USER` (o un alias verificado en esa cuenta): Gmail rechaza un `From` que la cuenta autenticada no puede usar |
| `MAILER_ALLOWED_RECIPIENTS` | Direcciones permitidas para `to`, separadas por coma | Hoy una sola: la casilla interna. Ver "La lista blanca" más abajo antes de tocar esto |

Se cargan en **Vercel** (proyecto `rr-mailing` → Settings → Environment
Variables), no en un `.env` del repo — no hay `.env.example` en este
directorio porque no hay entorno local que los necesite: no existe un
`vercel dev` de este endpoint documentado, y las pruebas (`apps/mailer/tests/send.test.ts`)
prueban `createSendHandler` con un `Mailer` falso, sin credenciales reales.

## `GET /api/cotizacion/<quote_id>` — el PDF de la cotización

Dado el `quote_id` (UUID) de una fila en la tabla `cotizaciones` de
Supabase, arma la vista con `buildCotizacionView`
(`apps/mailer/src/cotizacion-view.ts`) y dibuja un PDF con `pdf-lib`
(`apps/mailer/src/cotizacion.ts`), que devuelve como
`200 application/pdf`. Si el `quote_id` no tiene forma de UUID o la fila no
existe, `404 {"error":"cotizacion_no_encontrada"}`; si Supabase no responde
o el fetch expira (8 s), `503 {"error":"upstream"}` — reintentable, el
enlace no caduca por eso. Si `drawCotizacion` revienta dibujando el PDF
(p.ej. algo fuera del alfabeto que `sanitizeWinAnsi` no haya anticipado),
también responde `503 {"error":"upstream"}` en vez de un 500 crudo, logueando
solo el `quote_id` — nunca datos del cliente.

El nombre de archivo cae a `cotizacion-SN.pdf` cuando la fila trae
`numero: null`. Es una rama **defensiva**, no un caso esperado: en Postgres,
`add column ... generated always as identity` rellena retroactivamente todas
las filas existentes al correr el ALTER (`docs/sql/2026-09-01-numero-cotizacion.sql`),
así que ninguna fila real debería llegar sin `numero` una vez aplicado.

Los nombres de producto y la razón social del cliente pasan por
`sanitizeWinAnsi` antes de dibujarse: `pdf-lib` usa la codificación WinAnsi
(cp1252) con Helvetica, y un carácter fuera de ese repertorio hace lanzar a
`drawText`. Esto no es teórico — 44 productos reales del catálogo de Ingram
(0,27% del catálogo) traen mojibake (bytes de cp1252 sin carácter asignado,
p.ej. U+0081, U+009D) que reventaba el endpoint con 500 antes de este
saneo; cualquier carácter no representable se reemplaza por `?`.

Es una **capability URL**: pública a propósito, sin autenticación, porque el
`quote_id` es un UUID inadivinable — quien lo tiene (por el link que manda
`apps/kapso-agent`) puede ver el PDF, y nadie más. No agregar un header de
autenticación a este endpoint sin repensar ese diseño primero.

Necesita `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` cargadas en el proyecto
`rr-mailing` de Vercel (las mismas que usa `generar-cotizacion-v2` en
Kapso). Si faltan, responde `503 {"error":"falta_configuracion","faltan":[...]}`
nombrando cuáles — nunca sus valores.

## Cómo se despliega

```bash
vercel --prod    # desde apps/mailer, con el proyecto ya enlazado (.vercel/project.json)
```

El proyecto en Vercel tiene **Root Directory** `apps/mailer` y el
interruptor de "incluir archivos fuera del Root Directory" **activado** —
igual que `apps/pricing-api` — porque importa código de `packages/mailer` y
`packages/http`, que viven fuera de `apps/mailer`.

### `vercel.json`: por qué tiene `installCommand`, `buildCommand` y `outputDirectory`

Cita parcial — solo las tres claves que explica esta sección. El archivo
real (`apps/mailer/vercel.json`) tiene además un bloque `functions` que le
pone `maxDuration: 30` a `api/**/*.ts`; es lo único que acota un envío SMTP
colgado (sin eso, una conexión a `smtp.gmail.com` que nunca responde dejaría
la función corriendo hasta el límite por defecto de Vercel).

```json
{
  "installCommand": "cd ../.. && npm ci",
  "buildCommand": "cd ../.. && npm run build:packages && cd apps/mailer && mkdir -p salida-vacia && printf '...' > salida-vacia/index.html",
  "outputDirectory": "salida-vacia"
}
```

Los tres existen por una cadena de restricciones de Vercel, no por gusto —
tocar cualquiera sin entender las otras dos rompe el despliegue:

1. **`installCommand: "cd ../.. && npm ci"`.** El Root Directory es
   `apps/mailer`, pero el lockfile y el `workspaces` del monorepo viven dos
   niveles arriba. Sin este comando, Vercel instala solo las dependencias
   directas de `apps/mailer/package.json` (7 paquetes) en vez del workspace
   completo (184), y la función revienta al importar `@vercel/node` y los
   paquetes `@rr/*`.
2. **Un proyecto de solo-funciones-en-`api/`, sin `buildCommand`, entra en
   una ruta de "cero configuración" de Vercel que ignora por completo
   `installCommand`** (está documentado por Vercel: no es un bug de este
   repo). Declarar `buildCommand` es lo que saca al proyecto de esa ruta y
   hace que `installCommand` se respete de verdad.
3. **Declarar `buildCommand` obliga a un `outputDirectory` no vacío.**
   Vercel rechaza el deploy si el directorio de salida no existe o está
   vacío. `salida-vacia` es un directorio generado en cada build (nunca
   parte del árbol de `apps/mailer`) con un único `index.html` de una línea,
   solo para satisfacer ese requisito — esta app no sirve nada estático,
   solo las dos funciones en `api/` (`send.ts` y `cotizacion/[id].ts`).

**Esto es deliberado. No lo "arregles" quitando `buildCommand` o apuntando
`outputDirectory` a otra cosa** — sin los tres juntos, o vuelve el install
de 7 paquetes (la función no arranca), o el deploy falla por directorio de
salida vacío. `vercel.json` es JSON estricto y no admite comentarios; esta
sección es esa explicación.

**Por qué no es `outputDirectory: "."`.** Fue la primera versión, y servía
`apps/mailer` entero como contenido estático: `GET /vercel.json` y
`GET /src/send.ts` respondían `200` con el código fuente completo. Sin
secretos en esos archivos, pero exponiendo el mecanismo de autenticación y
de lista blanca a cualquiera. `salida-vacia` corrige eso: hoy esas rutas dan
`404`, y `GET /api/send.ts` da `405` (la función real respondiendo, no un
archivo servido).

### Los imports son normales

`api/send.ts` y `src/send.ts` importan `@rr/mailer`, `@rr/http/auth` y
`@rr/http/http` por su nombre, como cualquier otro consumidor.

Durante un tiempo no fue así: los paquetes exponían TypeScript sin
compilar, Vercel trata `node_modules` como código ya compilado, y la
función fallaba al arrancar con `ERR_MODULE_NOT_FOUND`. El parche fue
importarlos por ruta relativa. Ya no hace falta — los paquetes se compilan
y el `buildCommand` los construye antes de desplegar. Ver
`CONTRIBUTING.md`.

## Respuestas del endpoint

Lo que un operador necesita para diagnosticar sin leer el código, a
cualquier hora:

| HTTP | Cuerpo | Qué significa | Qué hacer |
|---|---|---|---|
| `200` | `{ "ok": true, "id": "<messageId>" }` | Gmail aceptó el correo | Nada — es el camino feliz |
| `400` | `{ "ok": false, "error": "cuerpo_invalido" }` | Falta `to`, `subject`, `html` o `text`, o alguno no es un string no vacío | No es un problema del relé: revisar qué manda el llamador (`emitir-ordenes-compra` u otro). Nunca se llegó a intentar enviar nada |
| `401` | `{ "ok": false, "error": "no_autorizado" }` | El header `x-api-key` falta o no coincide con `MAILER_API_KEY` | Confirmar que el `MAILER_API_KEY` cargado en Vercel es el mismo que tiene la function de Kapso que llama al relé. Si se rotó uno de los dos lados sin el otro, todo falla así |
| `403` | `{ "ok": false, "error": "destinatario_no_permitido" }` | `to` no está en `MAILER_ALLOWED_RECIPIENTS` | **No es una falla que "arreglar" agregando el destinatario a la ligera** — es la lista blanca haciendo su trabajo (ver más abajo). Si el destino cambió de verdad (nueva casilla interna), se agrega esa dirección a `MAILER_ALLOWED_RECIPIENTS` en Vercel a propósito, con esa decisión tomada, no como parche |
| `405` | `{ "ok": false, "error": "metodo_no_permitido" }` | Alguien pegó al endpoint con un método que no es `POST` | No suele ser una falla operativa real (nadie más debería estar llamando a esta URL); si aparece en volumen, alguien está probando o escaneando el endpoint |
| `500` | `{ "ok": false, "error": "falta_configuracion", "faltan": ["..."] }` | Falta una de las cinco variables de entorno en Vercel | Revisar Settings → Environment Variables del proyecto `rr-mailing`, cargar exactamente las que lista `faltan` (nunca se listan sus valores), y redesplegar |
| `502` | `{ "ok": false, "error": "el_envio_fallo" }` (a veces con `"codigo": "EAUTH"` / `"ETIMEDOUT"` / etc.) | El transporte SMTP falló. El `mensaje` de nodemailer nunca se devuelve porque puede traer la credencial; el `codigo` simbólico sí, y basta para diagnosticar sin adivinar cronometrando la respuesta | `EAUTH`: Gmail rechazó `GMAIL_USER`/`GMAIL_APP_PASSWORD` — la contraseña de aplicación se revocó o se cargó mal (ojo con espacios al pegarla). Regenerarla y actualizar `GMAIL_APP_PASSWORD`. `ETIMEDOUT`/`ECONNECTION`: problema de red saliente hacia `smtp.gmail.com` — reintentar, y si persiste, es una incidencia de plataforma, no de este código. Sin `codigo`: revisar el error en los logs de Vercel (`vercel logs`), ahí si puede aparecer más detalle porque no sale por la respuesta HTTP. También puede ser el **límite diario de Gmail** (500 correos/día en la cuenta gratuita) — poco probable para volumen interno, pero es la primera sospecha si `EAUTH` no aplica y el volumen del día fue alto |

Nunca devuelve el detalle de la credencial ni el mensaje crudo del
transporte si puede contenerla — solo el código simbólico del error
(`EAUTH`, `ETIMEDOUT`, ...), que no puede traerla.

## La lista blanca de destinatarios es deliberada

Un endpoint de envío protegido solo por una clave es, si esa clave se
filtra, un relé de spam a nombre de la cuenta de Gmail — y Google suspende
la cuenta. Por eso el endpoint **rechaza cualquier destinatario que no esté
en `MAILER_ALLOWED_RECIPIENTS`**, y lo hace **antes** de tocar el
transporte: un `403` a un destinatario ajeno nunca intenta un `sendMail`
(ver el test `rechaza un destinatario fuera de la lista SIN llamar al
transporte` en `apps/mailer/tests/send.test.ts`).

Hoy la lista tiene una sola dirección: la casilla interna. Cuando llegue la
fase 2 (cotizaciones y facturas a clientes) habrá que mandar a direcciones
arbitrarias, y ese es el momento de **reemplazar** la lista blanca por otro
control — no de vaciarla ni de aflojarla antes.

## Tests

```bash
npm test -- apps/mailer     # o npm test, desde la raíz, para la suite completa
```

`apps/mailer/tests/send.test.ts` prueba `createSendHandler` con un `Mailer`
falso: sin clave → 401, con clave incorrecta → 401, destinatario fuera de la
lista → 403 sin llamar al transporte, cuerpo incompleto → 400, método
distinto de POST → 405, caso feliz → 200 con el `id`, y dos casos del fallo
de transporte → 502 (con y sin `codigo`), verificando en ambos que la
credencial nunca aparece en la respuesta.

`apps/mailer/tests/cotizacion.test.ts` prueba `createCotizacionHandler` y
`drawCotizacion` con Supabase mockeado vía `vi.stubGlobal('fetch', ...)`: PDF
válido de una página con los headers correctos, id sin forma de UUID → 404
sin tocar Supabase, cotización inexistente → 404, sin `SUPABASE_URL`/`SUPABASE_SERVICE_KEY`
→ 503 nombrando las que faltan, fila sin `numero` → archivo `cotizacion-SN.pdf`,
un fetch que falla → 503 `upstream`, sin teléfono no consulta `/clientes`, un
nombre con mojibake real de Ingram (U+0081) o una razón social con `″`
(U+2033) salen `200` en vez de reventar, `drawCotizacion` inyectado para que
reviente responde `503 upstream` logueando solo el `quote_id`, y dos pruebas
estructurales de `drawCotizacion`: más de 18 líneas pasa a una segunda
página, y una línea con todos los campos `undefined` (normalizados a 0 por
`buildCotizacionView`) no revienta el dibujo.

`apps/mailer/tests/cotizacion-view.test.ts` prueba además `sanitizeWinAnsi`
directamente: deja intacto el ASCII imprimible, el rango Latin-1 y los 27
caracteres especiales de cp1252 (`€`, comillas curvas, guion largo, etc.)
que `pdf-lib` sí sabe codificar en WinAnsi; reemplaza por `?` cualquier otro
carácter, con los dos bytes de mojibake reales observados en Ingram
(U+0081, U+009D) como caso concreto.
