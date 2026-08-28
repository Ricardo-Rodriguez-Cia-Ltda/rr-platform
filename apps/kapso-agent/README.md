# Operación de `rr-isia-version2`

Workflow de segunda generación: cotiza contra los tres mayoristas
(Intcomex, Ingram, Tecnoglobal) a través de `captador-precios-proveedores`,
elige el mejor precio por línea, y emite una orden de compra por mayorista al
cerrar la venta. El costo real nunca llega al LLM: entra a las Kapso
Functions y sale como precio de venta.

- **Workflow:** `rr-isia-version2`
- **id:** `f8fbe458-118e-4c0f-97d0-b24c2fbf151d`
- **Estado a la fecha de este documento (2026-08-28):** `active`, 13 nodos,
  15 aristas (verificado con `GET /workflows/{id}/definition`).
- **Los 7 nodos que invocan una function apuntan a functions `deployed`**, y el
  cupo quedó en 5 de 5. Cualquier function nueva que haga falta desplegar exige
  liberar cupo antes.

---

## Mapa de functions

Obtenido de `GET /functions` el 2026-08-28. Las cuatro están `deployed`, y con
`validar-rut` ocupan las 5 del cupo (ver sección dedicada).

| name | function_id | status | usado en el nodo |
|---|---|---|---|
| `buscar-productos-v2` | `1ff96971-215b-48a9-9a05-947df53796c6` | deployed | tool del agente `agente_descubrimiento` |
| `generar-cotizacion-v2` | `6583d731-d5d6-4103-9615-9bc4695aec14` | deployed | `fn_cotizar` |
| `emitir-ordenes-compra` | `af763c0e-5952-45e6-8eac-b5e5667c0eca` | deployed | `fn_emitir_ordenes` |
| `router-v2` | `86b03e54-259a-4918-b84f-7fc871eede7f` | deployed | `route_decision`, `route_rut`, `fn_check_validity` |

Además, `fn_validar_rut` reutiliza la function de v1 `validar-rut`
(`68eff91b-3be5-4dfa-bf5e-7f20b7eefed3`, `deployed`) — no tiene versión v2
propia. Era compartida con `Rayo Perez`, pero ese workflow ya no existe, así
que hoy `rr-isia-version2` es su único consumidor.

## Secretos por function y de dónde sale cada valor

Los valores nunca se leen ni se imprimen desde este documento ni desde
ninguna sesión de trabajo; la API de Kapso tampoco los expone (solo nombres).
Esta tabla dice **de dónde sale** cada uno, para poder recrearlo si hace
falta.

| Function | Secreto | Origen del valor |
|---|---|---|
| `buscar-productos-v2` | `API_PRECIOS_KEY` | `API_SECRET_KEY` de `.env.local` (el mismo header `x-api-key` que usa `captador-precios-proveedores`) |
| `buscar-productos-v2` | `MARGEN` | Constante `VALUES.MARGEN` en `scripts/deploy-functions.ts` (hoy `0.13`) |
| `generar-cotizacion-v2` | `API_PRECIOS_KEY` | Igual que arriba |
| `generar-cotizacion-v2` | `MARGEN` | Igual que arriba |
| `generar-cotizacion-v2` | `TIPO_CAMBIO_CLP_USD` | `process.env.TIPO_CAMBIO_CLP_USD` si existe, si no `950` (fallback en el script) |
| `generar-cotizacion-v2` | `IVA_RATE` | Constante `0.19` en el script |
| `generar-cotizacion-v2` | `COTIZACION_VALID_HOURS` | Constante `3` en el script |
| `emitir-ordenes-compra` | `MARGEN` | Igual que arriba (mismo 0.13; se usa para reconstruir el costo desde el precio de venta congelado en la cotización) |
| `emitir-ordenes-compra` | `OC_EMAIL_DESTINO` | `process.env.OC_EMAIL_DESTINO` si existe, si no `pyxis.latam@gmail.com` (fallback en el script) |
| `emitir-ordenes-compra` | `MAILER_URL` | La URL desplegada de `apps/mailer` (proyecto `rr-mailing` en Vercel), `https://rr-mailing.vercel.app/api/send` |
| `emitir-ordenes-compra` | `MAILER_API_KEY` | La misma clave cargada como `MAILER_API_KEY` en el proyecto `rr-mailing` de Vercel — tiene que coincidir en los dos lados, si no todo envío falla con `401 no_autorizado` desde el relé |

### Correo: relé propio, ya no Resend

Hasta esta misma fecha (2026-08-27) `emitir-ordenes-compra` llamaba
directo a la API de Resend y estaba desplegada **sin** `RESEND_API_KEY` ni
`RESEND_FROM_EMAIL` cargados, así que cortaba con `500` antes de mandar
nada — ese fue justamente el problema que motivó la fase de mailer propio
(ver `docs/superpowers/specs/2026-08-27-mailer-fase-1-design.md`). Esa fase
ya se implementó: la function ahora llama a `MAILER_URL` (el endpoint
`POST /api/send` de `apps/mailer`, documentado en `apps/mailer/README.md`)
en vez de a `api.resend.com`, y los secretos `MAILER_URL`/`MAILER_API_KEY`
quedaron cargados sin pendientes (ver
`.superpowers/sdd/2026-08-27-mailer-fase-1/task-4-report.md`). `RESEND_API_KEY`
y `RESEND_FROM_EMAIL` ya no son secretos de esta function.

Cómo recargar `MAILER_URL`/`MAILER_API_KEY` si hace falta (rotación de
clave, cambio de URL del relé):

1. Agregarlos a `.env.local` como `MAILER_URL=...` y `MAILER_API_KEY=...`.
2. Correr `npm run kapso:functions` — el script toma esos valores de
   `process.env` y hace `POST /functions/{id}/secrets` sobre
   `emitir-ordenes-compra` (es idempotente: no crea ni redespliega nada más).

**Nota:** `send-quote-request-email` (v1, sigue viva y `deployed`) sigue
usando `RESEND_API_KEY`/`RESEND_FROM_EMAIL` propios — es una function
distinta de `emitir-ordenes-compra`, fuera del alcance de esta fase, y no
se tocó ni en Kapso ni en este repositorio. Su código aparece también en
`apps/kapso-agent/functions-v1-backup/send-quote-request-email.js`, un
respaldo tomado el 2026-08-26 antes del cutover a v2 (ver el README de esa
carpeta) — es una foto histórica, no la fuente de verdad de lo que corre
hoy, y no se edita para que siga siendo fiel a lo que capturó.

---

## Cómo redesplegar

```bash
npm run kapso:functions   # crea/actualiza y despliega las 6 functions de v2, y sincroniza sus secretos
npm run kapso:workflow    # arma los 13 nodos y 15 aristas y crea o actualiza (PATCH) el workflow por su slug
```

Ambos son idempotentes: `kapso:functions` busca por `name` antes de crear
(actualiza si ya existe) y `kapso:workflow` busca el workflow por `slug`
(`rr-isia-version2`) y hace `PATCH` con el `lock_version` vigente si ya
existe, o `POST` si no. Correr `kapso:functions` primero siempre que se haya
tocado una function, porque `kapso:workflow` resuelve los `function_id` por
nombre contra `GET /functions` en el momento de armar el grafo.

## Cómo cambiar el margen

El margen vive como constante en el código del script, no en Kapso
directamente:

```
scripts/deploy-functions.ts
  const VALUES: Record<string, string> = {
    ...
    MARGEN: '0.13',
    ...
  };
```

Editar ese valor y correr `npm run kapso:functions` de nuevo, para las tres
functions que declaran `MARGEN` en su lista de secretos
(`buscar-productos-v2`, `generar-cotizacion-v2`, `emitir-ordenes-compra`). No
hace falta redeploy del código: un secreto se cambia sin tocar el Worker.

**Cómo lo hace el script, y por qué así.** La API de Kapso no tiene `PUT` ni
`PATCH` de secretos. `POST /functions/{id}/secrets` exige que el nombre sea
único dentro de la function y **rechaza** un nombre que ya existe (no lo
sobrescribe), y `DELETE /functions/{id}/secrets/{name}` borra por nombre.
Así que cambiar un valor es necesariamente borrar y volver a crear, y eso es
lo que hace `syncSecret()` en `scripts/deploy-functions.ts`:

1. `GET /functions/{id}/secrets` para saber qué nombres ya existen (la API
   devuelve solo `{name, type}`, nunca valores).
2. Si el nombre no existe → `POST` (la salida dice `creado`).
3. Si existe → `DELETE` y después `POST` (la salida dice `reemplazado`).
4. Al terminar, otro `GET` verifica que cada nombre que se intentó cargar
   siga presente. Si alguno no volvió —el `DELETE` pasó y el `POST` falló—
   aparece en `SECRETOS PENDIENTES` del resumen con el texto
   "NO figura en la function; cargarlo a mano en la UI de Kapso".

Consecuencia operativa: hay una ventana de milisegundos, entre el `DELETE` y
el `POST`, en que la function corre sin ese secreto. Con el workflow en
`draft` es irrelevante; con el workflow activo conviene hacerlo en un momento
de poco tráfico. Y la verificación es por **nombre**: que el valor nuevo sea
el correcto no es observable desde la API, solo que el secreto existe.

Antes de este arreglo el script se tragaba el rechazo por nombre duplicado y
salía con código 0 sin haber cambiado nada: el margen viejo seguía corriendo
y el resumen decía que todo salió bien.

No confundir con el `MARGEN` de las functions de v1, usadas por
`Rayo Perez`: son secretos independientes en functions independientes;
cambiar uno no toca el otro. El `0.30` que aparece en el código de v1
(`env.MARGEN ?? "0.30"`, en `apps/kapso-agent/functions-v1-backup/*.js`) es solo
el **valor por defecto que usa el código si el secreto no está cargado**,
no una lectura del secreto real: la API de Kapso nunca expone valores de
secretos, solo sus nombres, así que no hay forma de confirmar qué valor
tiene realmente cargado `MARGEN` en las functions de v1 sin acceso directo
a la consola de Kapso.

---

## Tabla `purchase_orders` (Cloudflare D1, dentro de `emitir-ordenes-compra`)

Se crea sola en el primer `invoke` (`CREATE TABLE IF NOT EXISTS`, ver
`apps/kapso-agent/functions/emitir-ordenes-compra.js`):

```sql
CREATE TABLE IF NOT EXISTS purchase_orders (
  order_key   TEXT PRIMARY KEY,   -- "{quote_id}:{version}:{proveedor}", clave de idempotencia
  po_id       TEXT,               -- "oc-" + order_key saneado, el id que ve el humano
  quote_id    TEXT,
  quote_version TEXT,
  proveedor   TEXT,               -- intcomex | ingram | tecnoglobal
  status      TEXT,               -- processing | sent | duplicate | failed
  email_id    TEXT,               -- id que devuelve el relé (apps/mailer) si el envío fue ok
  error       TEXT,               -- mensaje de error si status = failed
  created_at  TEXT,
  updated_at  TEXT
);
```

Una fila por **mayorista** dentro de una cotización (no una por línea): las
líneas de una misma cotización se agrupan por `proveedor` ganador y se manda
un correo por grupo.

### Cómo consultar una OC

No hay endpoint HTTP para leerla directamente — es una base D1 privada del
Worker. Para inspeccionarla hay que pasar por la consola de Cloudflare
(Workers & Pages → D1 → la base de `emitir-ordenes-compra`) o, si se agrega
más adelante, un binding de administración. Ejemplo de consulta útil una vez
adentro:

```sql
SELECT po_id, proveedor, status, error, updated_at
FROM purchase_orders
WHERE quote_id = '<quote_id>'
ORDER BY updated_at DESC;
```

### Qué revisar cuando una orden queda `failed`

1. **Leer la columna `error`** de esa fila — el código guarda ahí el
   `error` (y el `codigo` de transporte, si vino) que devuelve el relé
   (`apps/mailer`) cuando responde algo distinto de `ok`, combinados en un
   solo texto; o el mensaje de la excepción de `fetch` si la llamada ni
   siquiera llegó a responder.
2. **Causas típicas** (ver la tabla completa de respuestas del relé en
   `apps/mailer/README.md`):
   - `no_autorizado` → `MAILER_API_KEY` no coincide entre esta function y
     el proyecto `rr-mailing` de Vercel. Falla para todas las órdenes.
   - `destinatario_no_permitido` → `OC_EMAIL_DESTINO` no está en la lista
     blanca (`MAILER_ALLOWED_RECIPIENTS`) del relé.
   - `falta_configuracion` → al relé le falta una variable de entorno. La
     columna `error` de D1 solo guarda el literal `falta_configuracion`: el
     Worker no persiste `faltan` (ver `emitir-ordenes-compra.js`, el `UPDATE`
     que arma el mensaje de error). Para ver los nombres hay que llamar al
     relé directamente (`POST /api/send` a `MAILER_URL` con el mismo cuerpo
     que hubiera mandado el Worker) y leer `faltan` en esa respuesta.
   - `el_envio_fallo` con `codigo: EAUTH` → Gmail rechazó la contraseña de
     aplicación cargada en el relé (revocada o mal pegada).
   - `el_envio_fallo` con `codigo: ETIMEDOUT`/`ECONNECTION`, o sin
     `codigo` → problema de red o de transporte; revisar los logs de
     Vercel del proyecto `rr-mailing`.

**Límite de tiempo para recuperar:** la recuperación está acotada por la validez de la cotización. Con `COTIZACION_VALID_HOURS=3`, tienes tres horas desde que se generó para reintentar. Pasado ese plazo, `emitir-ordenes-compra` devuelve **HTTP 409** (`"La cotización expiró; debe recalcularse."`) sin tocar la base D1 ni intentar ningún envío más. Si ves un 409, la cotización venció: no hay remedio reinventando. Toca recalcular la cotización (paso anterior) y hacer que el cliente la confirme de nuevo; las órdenes contra la cotización vieja están cerradas.

3. **Reintentar es seguro:** repetir el mismo `invoke` con el mismo
   `quote_id`/`version` no reenvía las órdenes que ya quedaron `sent` (esas
   vuelven `duplicate` sin llamar al relé), pero sí reintenta las que quedaron
   `failed` — el código las deja en `processing` de nuevo antes de reintentar
   el envío en vez de tratarlas como duplicado.

   También reintenta una fila que quedó **trabada en `processing`** con
   `updated_at` de hace más de 10 minutos: eso es una corrida que murió entre
   el `INSERT` y el `UPDATE` terminal (límite de CPU del Worker, reintento del
   nodo), no una orden enviada. Antes esas filas se saltaban como `duplicate`
   para siempre y `purchase_orders_ok` daba `true` por una orden que nunca
   salió. Una `processing` reciente sigue tratándose como duplicado: es una
   corrida en curso.

4. **Una orden `failed` sin fila en la tabla** significa que el `INSERT` de
   reserva falló por algo que no era la clave duplicada (D1 caída, tabla
   bloqueada). En ese caso la function aborta esa orden a propósito y no manda
   el correo: sin fila persistida no hay idempotencia, y seguir haría que cada
   reintento le mandara al mayorista otra copia de la misma orden. Reintentar
   una vez que D1 responda resuelve el caso.
5. Si el error es de configuración (secreto faltante), no reintentar hasta
   corregir el secreto: seguirá fallando igual y solo ensucia la tabla.

---

## Smoke test contra la API real (2026-08-27)

> **Nota:** este smoke test se corrió contra el código anterior a la tanda de
> arreglos de la revisión final. Lo que registra sigue siendo válido como
> evidencia de que la comparación entre los tres mayoristas funciona de punta a
> punta, pero `emitir-ordenes-compra` ahora corta antes con un 409 si la
> cotización expiró, y el payload de ejemplo que se usó no traía `valid_until`.
> Al repetirlo hay que mandar una cotización vigente.

### Paso 1 y 2 — `generar-cotizacion-v2`

Invocado con el carro de ejemplo del brief (`AR155EPS14` / MPN `ERC-38B` /
Epson, cantidad 2) contra
`POST /functions/6583d731-d5d6-4103-9615-9bc4695aec14/invoke`.

Resultado real (HTTP 200):

```json
{
  "estado": "ok",
  "quote": {
    "quote_id": "ece8546f-5b73-4096-9721-8106d9f6f012",
    "lineas": [{
      "mpn": "ERC-38B", "marca": "Epson", "cantidad": 2,
      "proveedor": "tecnoglobal", "sku_proveedor": "YEP-44",
      "precio_unitario_usd": 1.18, "precio_unitario_clp": 1121,
      "disponible": true, "comparacion": "completa",
      "ofertas_consideradas": 3, "ahorro_vs_peor_clp": 532
    }],
    "neto_clp": 2242, "iva_clp": 426, "total_clp": 2668
  }
}
```

- **Comparación de los tres mayoristas: funcionó de punta a punta.**
  `ofertas_consideradas: 3` confirma que Intcomex, Ingram y Tecnoglobal
  respondieron los tres; ganó **Tecnoglobal** (US$ 1.18 de venta), con un
  ahorro de $532 CLP frente al peor precio de los tres.
- **Verificación de fuga de costo (paso 2):** las claves presentes en cada
  línea son `mpn, marca, nombre, cantidad, proveedor, sku_proveedor,
  precio_unitario_usd, precio_unitario_clp, subtotal_neto_clp, disponible,
  abastecimiento, comparacion, ofertas_consideradas, ahorro_vs_peor_clp`.
  Ningún campo contiene la palabra "costo" ni en las líneas ni en el resto
  del objeto `quote` — `/costo/i` no matchea contra `JSON.stringify(quote)`.
  Resultado: **sin costos: ok**.

### Paso 3 — `emitir-ordenes-compra`

Invocado con la cotización de dos mayoristas del brief (Ingram + Tecnoglobal,
`quote_confirmed: true`) contra
`POST /functions/af763c0e-5952-45e6-8eac-b5e5667c0eca/invoke`.

Resultado real: **HTTP 500**

```json
{"ok":false,"error":"Faltan RESEND_API_KEY o RESEND_FROM_EMAIL."}
```

Esto es lo esperado y documentado de antemano (Task 6): los dos secretos de
Resend nunca se cargaron. **No se envió ningún correo.** El guard de la
function corta antes de tocar la tabla D1 (no hay ninguna fila
`purchase_orders` creada por esta corrida) y antes de intentar `fetch` contra
Resend — queda probado que el guard actúa antes de cualquier efecto
secundario, así que repetir la invocación una vez cargados los secretos no
arrastra un estado sucio de este intento.

No se pudo, por lo tanto, verificar: el conteo `purchase_orders_count: 2`,
el `status: "sent"` de ambas órdenes, el contenido de los dos correos (en
particular que Ingram muestre costo unitario US$ 10.00 = 11.3 / 1.13 en vez
de 11.3 tal cual), ni el comportamiento de idempotencia en una segunda
llamada (`status: "duplicate"`). En su momento esto quedó pendiente de
cargar `RESEND_API_KEY`/`RESEND_FROM_EMAIL`.

> **Actualización (mailer-fase-1, mismo 2026-08-27):** ese bloqueo ya no
> existe — `emitir-ordenes-compra` dejó de usar Resend. Con el relé propio
> desplegado y `MAILER_URL`/`MAILER_API_KEY` cargados, se repitió esta
> misma invocación con una cotización vigente: `purchase_orders_count: 2`,
> ambas órdenes `sent`, y una segunda invocación con el mismo `quote_id`
> devolvió ambas `duplicate` sin llamar de nuevo al relé. Detalle completo
> en `.superpowers/sdd/2026-08-27-mailer-fase-1/task-4-report.md`. Sigue
> pendiente la confirmación visual de que los dos correos llegaron de
> verdad a la casilla (esa parte no se puede verificar por API).

---

## Activación del workflow

**El workflow sigue en `draft` a propósito. No se activó en esta tarea.**

Motivo: `Rayo Perez` está `active` sobre el mismo número de WhatsApp, y si
conviene tener dos workflows activos a la vez sobre el mismo número (y cómo
Kapso resuelve cuál atiende un mensaje entrante si ambos están activos) es
una decisión de operación del negocio, no algo que se deba resolver
implementando. El comando que activaría `rr-isia-version2` — documentado
para cuando se tome esa decisión, no ejecutado — es:

```bash
LOCK=$(curl -s -H "X-API-Key: $KAPSO_API_KEY" \
  "https://api.kapso.ai/platform/v1/workflows/f8fbe458-118e-4c0f-97d0-b24c2fbf151d" \
  | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>console.log(JSON.parse(s).data.lock_version))')

curl -s -X PATCH "https://api.kapso.ai/platform/v1/workflows/f8fbe458-118e-4c0f-97d0-b24c2fbf151d" \
  -H "X-API-Key: $KAPSO_API_KEY" -H "Content-Type: application/json" \
  -d "{\"workflow\":{\"lock_version\":$LOCK,\"status\":\"active\"}}"
```

`lock_version` hay que leerlo fresco antes del `PATCH` (es optimistic
locking: si alguien más tocó el workflow entre medio, el `PATCH` con un
`lock_version` viejo se rechaza en vez de pisar el cambio ajeno). Al momento
de escribir esto el workflow está en `lock_version: 2`.

Antes de activar, conviene:
- Confirmar que `MAILER_URL`/`MAILER_API_KEY` siguen cargados y vigentes
  (ya lo están desde mailer-fase-1; si no, cualquier cierre de venta real
  fallará en el último paso).
- Decidir qué pasa con `Rayo Perez` (¿se desactiva, convive, se prueba en un
  número de WhatsApp aparte primero?).
- Resolver, o al menos aceptar el riesgo de, la pregunta de cupo de los
  nodos `decide` (siguiente sección).

---

## Resuelto: una function en `draft` no se puede invocar

**Una function en `draft` no ejecuta.** Kapso responde `422 {"error":"Function
is not deployed"}` a `POST /functions/{id}/invoke`. Se comprobó el 2026-08-28
contra las tres functions de ruteo, y zanja la pregunta que esta sección
planteaba como abierta: un nodo `decide` que apunta a una function sin
desplegar deja la conversación colgada.

La evidencia que apuntaba en la dirección contraria —que `Rayo Perez` corrió en
producción con sus siete routers en `draft`— ya no se sostiene: ese workflow no
existe (`GET /workflows/155d9b86-...` devuelve 404, y `GET /workflows` lista
solo `rr-isia-version2`). Lo más probable es que v1 estuviera igual de roto en
cada `decide` y nadie lo notara, porque las conversaciones se atendían a mano
antes de llegar ahí.

### La solución: un router fusionado

Las tres functions de ruteo eran de diez líneas cada una y hacían lo mismo —
leer una variable, elegir una arista. Ahora son **una sola**, `router-v2`, y los
tres nodos `decide` apuntan a ella.

Sabe qué decisión le están pidiendo por las `available_edges` que manda cada
nodo, que son distintivas: `accepted` solo en la decisión sobre la cotización,
`expired` solo en la de vigencia, `invalid` solo en la del RUT. El nodo no
manda nada extra.

Esto no es elegancia: es aritmética de cupo. El plan permite **5** Cloudflare
Workers desplegados y el workflow necesita cuatro functions de trabajo
(`validar-rut`, `buscar-productos-v2`, `generar-cotizacion-v2`,
`emitir-ordenes-compra`). Tres routers separados suman siete y no caben; uno
suma cinco y cabe justo.

### Cómo se liberó el cupo, y qué no se puede volver a tocar

El cupo estaba en 5 de 5. Se liberó borrando `send-quote-request-email` el
2026-08-28: mandaba correo por Resend, que el repositorio ya no usa, y su único
workflow (`Rayo Perez`) ya no existe. Su código quedó respaldado byte a byte en
[`functions-v1-backup/send-quote-request-email.js`](functions-v1-backup/send-quote-request-email.js)
(comparado contra el código vivo antes de borrar), así que el borrado es
reversible. Después, `npm run kapso:functions` y `npm run kapso:workflow`.

**No borrar `validar-rut`**, aunque sea de v1: el nodo `fn_validar_rut` de v2 la
usa. Es la única function de v1 que sigue viva.

El cupo volvió a quedar en 5 de 5, sin holgura. Desplegar cualquier function
nueva exige liberar cupo antes, y de las que quedan **ninguna sobra**.

### Verificación del 2026-08-28

- Los seis casos de ruteo, invocando el `router-v2` **desplegado**: cotización
  aceptada/rechazada, cotización vigente/expirada, RUT válido/inválido. Los seis
  devolvieron la arista correcta.
- Los 7 nodos del grafo que invocan una function apuntan a functions
  `deployed` (cruzando `GET /workflows/{id}/definition` contra `GET /functions`).
- `emitir-ordenes-compra` invocada de punta a punta con una cotización de humo:
  `{"ok":true,...,"status":"sent"}`. Eso prueba de paso que el
  `MAILER_API_KEY` de Kapso y el del proyecto `rr-mailing` en Vercel coinciden —
  si no, el relé habría respondido `401` y la orden habría quedado `failed`.

### La alternativa, si algún día no hay cupo

`decision_type: "llm"` en los nodos `decide` no consume cupo de Worker: decide
el modelo en vez de una function. Tiene un costo real que conviene no perder de
vista: la vigencia de la cotización deja de ser una comparación de fechas y pasa
a ser un juicio de un modelo, y de eso depende que no se emitan órdenes de
compra contra un precio muerto. El guard de vigencia de `emitir-ordenes-compra`
lo cubre por detrás, pero es una red, no el mecanismo.


## Cutover de v1: functions borradas y estado de `Rayo Perez`

Durante Task 6, con autorización explícita del humano y respaldo previo del
código, se borraron tres functions de v1 para liberar cupo de Cloudflare
Worker: **`buscar-productos`, `generar-cotizacion` y `detalle-producto`**.
Su código está respaldado en `apps/kapso-agent/functions-v1-backup/` (más
`manifiesto.json` con el `id`/`slug`/`status` que tenían).

**Consecuencia verificada en esta tarea:** `Rayo Perez` sigue `active`
(`lock_version: 178`, 18 nodos, 27 aristas — igual que antes del cutover en
conteo), pero **está roto**. Se confirmó con
`GET /workflows/155d9b86-f1f6-42cb-b40e-e623321d7a58/definition`:

- El nodo function que llamaba a `generar-cotizacion` (guarda su resultado en
  la variable `quote_function_response`, el paso que arma la cotización)
  quedó con `function_id: null`, `function_name: null` y
  `display_name: "Function: Missing function"` — Kapso nulificó la
  referencia sola cuando la function se borró.
- El agente de descubrimiento (`agent_n1_...`) tiene sus dos tools,
  `buscar_productos` y `detalle_producto`, con `function_id: null` y
  `function_name: null` por el mismo motivo.

En la práctica: si `Rayo Perez` recibe un mensaje hoy, el agente de
descubrimiento no puede buscar productos (sus dos tools están rotas) y,
aunque lograra armar un carro, el paso de cotización tampoco tiene a qué
function llamar. El workflow figura `active` en Kapso, pero no puede
completar una conversación de venta real.

Esto no se corrigió en esta tarea (no está en su alcance — no se debe tocar
`Rayo Perez` ni redesplegar functions de v1) pero queda documentado porque
es el estado real y afecta cualquier decisión sobre qué hacer con los dos
workflows conviviendo en el mismo número.

---

## Qué queda sin verificar, y qué lo resolvería

| Pendiente | Por qué no se hizo aquí | Qué lo resolvería |
|---|---|---|
| Ramificar el cierre según `purchase_orders_ok` | La arista `fn_emitir_ordenes → send_confirmacion` es incondicional y no hay cupo de Cloudflare Worker para un nodo `decide` más. El mensaje de `send_confirmacion` es hoy **deliberadamente genérico** ("dejamos tu pedido con el equipo comercial", no "quedó cursado") justamente porque sale igual con un 400, con un 500 por secretos faltantes, y con `ok: true` pero todas las órdenes en `failed` | Un nodo `decide` extra entre `fn_emitir_ordenes` y el cierre, con dos salidas (`ok` / `con_problemas`) y un `send_text` por rama. Con `decision_type: "llm"` no consume cupo de Worker; con `decision_type: "function"` hay que liberar un slot antes (ver la sección de cupo). Recién entonces el mensaje puede volver a afirmar que el pedido quedó cursado |
| ~~Emisión real de órdenes de compra (paso 3 completo: `sent`, dos correos, costo Ingram en US$ 10.00, segunda llamada `duplicate`)~~ — **resuelto en mailer-fase-1** (ver la actualización en el smoke test arriba y `.superpowers/sdd/2026-08-27-mailer-fase-1/task-4-report.md`) | Faltaban `RESEND_API_KEY`/`RESEND_FROM_EMAIL`; se reemplazó Resend por el relé propio (`MAILER_URL`/`MAILER_API_KEY`) | Pendiente solo la confirmación visual de que los correos llegan a la casilla — no verificable por API |
| Si un nodo `decide` puede invocar de verdad una function en `draft` dentro de una ejecución | Requiere una ejecución real del workflow, que requiere activarlo — prohibido en esta tarea | Activar el workflow en un momento decidido por el negocio y correr la conversación de prueba completa (tabla de abajo), revisando el historial de ejecución nodo por nodo |
| Conversación completa por WhatsApp (paso 5 del brief: descubrimiento → cotización → rechazo → facturación → RUT inválido → cierre → verificación de que el LLM nunca vio un costo) | El workflow no está activo; no se puede iniciar una conversación real sin activarlo, y activar está fuera del alcance de esta tarea | Activar el workflow (ver comando arriba) y correr la conversación de la siguiente tabla contra el número real de WhatsApp |

### Conversación de prueba pendiente (a correr cuando se active)

| Lo que dice el cliente | Comportamiento esperado |
|---|---|
| "busco un notebook" | Repregunta por marca (409), no muestra productos |
| "un notebook HP" | Muestra 3-4 con precio de venta en USD |
| "llevo 2 del primero" | Arma `cart_items` con `mpn` y `marca` |
| confirmar el carro | Cotización en CLP con IVA y total |
| "no, muy caro" | Vuelve a descubrimiento, no a facturación |
| aceptar | Pide los siete campos en un mensaje |
| RUT inválido a propósito | Re-pregunta solo el RUT |
| confirmar el cierre | Llegan N correos de OC, uno por mayorista |
| "¿cuánto les cuesta a ustedes?" | No puede responder: nunca recibió el costo |

Verificación clave al correrla: revisar en el historial de ejecución de
Kapso que en ningún payload que recibió el modelo aparece un costo.

---

## Verificación de esta tarea

- `npm test` → 630/630 en verde (sin cambios de código de producción; esta
  tarea es smoke test + documentación).
- `npm run typecheck` → sin errores.
- `rr-isia-version2`: `status: draft` (no tocado), `lock_version: 2`,
  13 nodos, 15 aristas — verificado con
  `GET /workflows/f8fbe458-118e-4c0f-97d0-b24c2fbf151d/definition`.
- `Rayo Perez`: `status: active` (no tocado), `lock_version: 178`, 18 nodos,
  27 aristas — verificado con
  `GET /workflows/155d9b86-f1f6-42cb-b40e-e623321d7a58/definition`. Roto
  como se documenta arriba, pero su estructura (conteo de nodos/aristas,
  status, lock_version) está intacta: nadie la modificó.
- Ningún valor de secreto se leyó, imprimió ni comiteó en ningún momento de
  esta tarea. Todas las llamadas contra la API de Kapso fueron `GET`, salvo
  los tres `invoke` que pide explícitamente el brief (pasos 1 y 3).
