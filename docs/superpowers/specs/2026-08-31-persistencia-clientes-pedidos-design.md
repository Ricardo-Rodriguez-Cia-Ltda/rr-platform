# Diseño: persistencia de clientes, cotizaciones y pedidos

**Fecha:** 2026-08-31
**Estado:** Aprobado

## Problema

Hoy el negocio no recuerda nada entre conversaciones:

- Los **datos de facturación** del cliente (RUT, razón social, giro, dirección,
  comuna, ciudad, email) viven en las variables del workflow y mueren con la
  conversación. Un cliente que compra por segunda vez dicta los siete campos de
  nuevo.
- Las **cotizaciones** no se guardan en ninguna parte.
- De los **pedidos** solo queda el mínimo de idempotencia en D1 (ids, proveedor,
  estado) — el detalle completo (cliente, líneas, montos) vive únicamente en los
  correos a la casilla interna.

El usuario pidió las tres cosas: que al cliente se le pregunte una sola vez
(con confirmación editable en las siguientes), y que cotizaciones y pedidos
queden guardados completos. Consulta: **solo guardar por ahora** — el dashboard
es proyecto futuro; mientras tanto, el editor de tablas de Supabase sirve de
visor.

## Decisiones tomadas

### Base gestionada externa (Supabase), no D1 ni la API local

Se evaluaron tres arquitecturas; el usuario eligió la externa, y dentro de ella
se eligió **Supabase** (Postgres gestionado, plan gratis):

- **Independencia del PC de oficina**: la memoria del negocio no debe apagarse
  con el computador. (La opción "base en la API local" perdía esto.)
- **HTTPS simple desde Cloudflare Workers**: PostgREST se consume con `fetch` y
  dos headers — sin SDK, igual que el resto de las functions. (La base D1
  existente es privada del Worker de `emitir-ordenes-compra` y consultarla
  exige consola de Cloudflare.)
- **Editor de tablas incluido**: con el alcance "solo guardar", la consulta la
  resuelve la web de Supabase sin construir nada.

Región del proyecto: `sa-east-1` (São Paulo) — los datos quedan en Sudamérica.

### El teléfono de WhatsApp es la llave del cliente

Llega solo en cada conversación (`context.phone_number` del execution context;
respaldo: `context.contact.wa_id`). Se normaliza a **solo dígitos**
(`"+56 9 4175 7584"` → `"56941757584"`) antes de usarse como llave. No se pide
ni se confirma: es la identidad que WhatsApp ya garantiza.

### La persistencia nunca bloquea una venta

Toda llamada a Supabase es *best-effort* con timeout corto (4 s):

- Si falla la **carga** del cliente → se pregunta todo como hoy.
- Si falla el **guardado** del pedido → la OC ya salió por correo; se registra
  el fallo en la respuesta y se sigue.

La base es memoria del negocio, no un eslabón del flujo.

### Sin functions nuevas

El cupo de Cloudflare Workers está en 5/5. Los dos puntos de contacto se
absorben en functions existentes que ya están en el lugar correcto del flujo:
`generar-cotizacion-v2` (existe cuando nace la cotización y **antes** de
facturación) y `emitir-ordenes-compra` (existe cuando el pedido es real y los
datos están confirmados).

### D1 no se toca

La tabla `purchase_orders` de D1 sigue siendo el candado de idempotencia,
transaccional con la emisión. Supabase es el **registro de negocio**; D1 el
**candado técnico**. Duplicar el rol de idempotencia en Supabase sería tener
dos candados que pueden discrepar.

## Alcance

**Incluido:**

- Tres tablas en Supabase (`clientes`, `cotizaciones`, `pedidos`) con su SQL de
  creación versionado en el repo.
- Un módulo compartido de acceso en las functions (fetch a PostgREST, timeout,
  nunca lanza).
- `generar-cotizacion-v2`: guarda la cotización; carga el cliente y lo devuelve
  en `vars.cliente_guardado`.
- `emitir-ordenes-compra`: guarda el pedido completo (una fila por proveedor,
  espejo de los correos) y hace upsert del cliente confirmado.
- Prompt `agente-facturacion` v-03: si `cliente_guardado` existe, confirmar en
  una línea con edición por campo; si no, pedir los siete como hoy.
- Secretos `SUPABASE_URL` y `SUPABASE_SERVICE_KEY` en ambas functions, vía
  `deploy-functions.ts` desde `.env.local`.

**Fuera de alcance:**

- **Dashboard o endpoints de consulta.** El editor de tablas de Supabase cubre
  la consulta por ahora; los endpoints nacerán con el proyecto que los necesite.
- **Migrar la idempotencia fuera de D1.**
- **Historial de conversaciones.** Eso ya lo guarda Kapso.
- **Resúmenes por correo.** Decidido explícitamente fuera; reutilizaría el relé
  cuando se quiera.

## Arquitectura

```
generar-cotizacion-v2 ──POST /rest/v1/cotizaciones──►
                      ──GET  /rest/v1/clientes?telefono=eq.X──►   Supabase
emitir-ordenes-compra ──POST /rest/v1/pedidos (una por proveedor)─►  (Postgres,
                      ──POST /rest/v1/clientes  (upsert)──────►    sa-east-1)
```

Autenticación: headers `apikey` y `Authorization: Bearer` con la clave
`service_role`, que solo vive en secretos de Kapso y en `.env.local` — jamás en
código ni en el chat. No hay acceso anónimo: RLS queda irrelevante porque la
única vía de entrada es la clave de servidor.

### Las tablas

```sql
create table clientes (
  telefono      text primary key,     -- digitos de WhatsApp: "56941757584"
  rut           text not null,
  razon_social  text not null,
  giro          text not null,
  direccion     text not null,
  comuna        text not null,
  ciudad        text not null,
  email         text not null,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now()
);

create table cotizaciones (
  quote_id      text not null,
  version       text not null,
  telefono      text,                 -- puede no conocerse aun; sin FK dura
  neto_clp      bigint not null,
  iva_clp       bigint not null,
  total_clp     bigint not null,
  valida_hasta  timestamptz,
  lineas        jsonb not null,       -- las lineas completas de la cotizacion
  created_at    timestamptz not null default now(),
  primary key (quote_id, version)
);

create table pedidos (
  po_id           text primary key,   -- el mismo id humano de D1 y el correo
  quote_id        text not null,
  quote_version   text not null,
  proveedor       text not null,      -- intcomex | ingram | tecnoglobal
  telefono        text,
  rut             text,               -- copia de lo confirmado al emitir
  razon_social    text,
  lineas          jsonb not null,     -- las lineas del grupo de este proveedor
  neto_grupo_clp  bigint,
  estado          text not null,      -- sent | failed
  email_id        text,
  created_at      timestamptz not null default now()
);
```

Una fila de `pedidos` por **proveedor** dentro de una cotización — el espejo
exacto de los correos y de las filas de D1. `rut`/`razon_social` se copian en
el pedido para que el historial sea legible aunque el cliente edite sus datos
después.

El SQL vive en `docs/sql/2026-08-31-persistencia.sql` y se ejecuta **una vez**
en el SQL Editor de Supabase (lo hace quien crea el proyecto, pegándolo).

### El módulo de acceso

Las functions son JavaScript plano sin imports del workspace, así que el
acceso es un bloque pequeño **duplicado deliberadamente** en las dos functions
(el mismo trade-off que ya aceptan para todo lo demás):

```js
// supabase(env, metodo, ruta, body?) -> objeto | null. Nunca lanza: la
// persistencia es memoria del negocio, no un eslabon del flujo.
async function supabase(env, method, path, body) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;
  try {
    const r = await fetch(`${env.SUPABASE_URL}/rest/v1${path}`, {
      method,
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: method === "POST" ? "resolution=merge-duplicates,return=minimal" : "return=representation",
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(4000),
    });
    if (!r.ok) return null;
    const text = await r.text();
    return text ? JSON.parse(text) : {};
  } catch {
    return null;
  }
}
```

El upsert de clientes usa `POST /clientes?on_conflict=telefono` con
`Prefer: resolution=merge-duplicates`. La forma exacta la fija el plan.

### El flujo del cliente que vuelve

1. `generar-cotizacion-v2`, tras armar la cotización: `POST /cotizaciones`
   (best-effort) y `GET /clientes?telefono=eq.<digitos>&limit=1`. Si hay fila,
   la respuesta suma `vars.cliente_guardado = { rut, razon_social, giro,
   direccion, comuna, ciudad, email }`; si no (o si Supabase no contesta),
   `vars.cliente_guardado = null`.
2. `agente_facturacion` (prompt v-03):
   - Con `cliente_guardado`: *"¿Facturamos con los datos de la vez pasada?
     RUT 21099234-0 · Vicente Pareja · Holanda 222, Ñuñoa, Santiago ·
     parejavice@gmail.com — ¿o corriges algo?"*. Un sí llena las siete
     variables desde `cliente_guardado` y sigue; una corrección reemplaza
     **solo** el campo corregido. La validación de RUT aguas abajo corre
     igual — un dato guardado no se exime.
   - Sin `cliente_guardado`: los siete campos en bloque, como hoy.
3. `emitir-ordenes-compra`, tras emitir: upsert del cliente con las variables
   confirmadas + `POST /pedidos` por cada grupo de proveedor con el mismo
   estado que quedó en D1. La respuesta de la function gana un campo
   `persistencia: "ok" | "fallo"` para que el fallo silencioso no exista —
   aparece en los logs de Kapso aunque al cliente no se le diga nada.

## Manejo de errores

| Situación | Comportamiento |
|---|---|
| Supabase caído al cotizar | `cliente_guardado: null`; la cotización sale igual; se pregunta todo |
| Supabase caído al emitir | La OC ya salió; `persistencia: "fallo"` en la respuesta; nada se reintenta |
| Sin teléfono en el contexto (canal de prueba) | No se carga ni guarda cliente; cotización y pedido se guardan con `telefono: null` |
| Secretos no configurados | `supabase()` devuelve null en silencio: el flujo completo se comporta como hoy |
| El cliente corrige un dato guardado | La corrección vive en las vars; el upsert al emitir persiste la versión corregida |

## Testing

El patrón existente: `loadHandler` + `vi.stubGlobal('fetch')`. Los mocks ahora
enrutan por URL (las llamadas a `pyxis-latam.cl` vs las de `supabase.co`).

- `generar-cotizacion-v2`: con cliente en Supabase → `vars.cliente_guardado`
  poblado; sin fila → null; Supabase lento/caído (mock que rechaza) → null y la
  cotización intacta; la cotización se postea con sus totales y líneas.
- `emitir-ordenes-compra`: pedido posteado por proveedor con las líneas del
  grupo; upsert del cliente con las vars; Supabase caído → la emisión completa
  igual y `persistencia: "fallo"`; sin secretos → comportamiento idéntico al
  actual (las pruebas existentes no cambian de resultado).
- Normalización de teléfono: `"+56 9 4175 7584"` → `"56941757584"`; contexto
  sin teléfono → null.
- `prompts.test.ts` valida v-03 como única vigente de facturación.

## Verificación de punta a punta

1. Conversación real 1: comprar algo, dictar los siete datos → en el editor de
   Supabase aparecen el cliente, la cotización y el pedido.
2. Conversación real 2 (mismo WhatsApp): al llegar a facturación, el bot ofrece
   los datos guardados; confirmar con "sí" → el pedido sale sin dictar nada.
3. Conversación real 3: corregir un campo ("cambió mi dirección a X") → el
   pedido sale con la dirección nueva y el editor muestra al cliente
   actualizado.
4. La degradación sin secretos no se prueba en producción: la cubren las
   pruebas unitarias (invocar el handler con `env` sin `SUPABASE_URL` debe dar
   el comportamiento idéntico al actual).

## Riesgos conocidos

- **Datos personales en un tercero** (Supabase sobre AWS, São Paulo). Cifrado
  en reposo en el plan gratis; el usuario lo aceptó explícitamente. La clave
  `service_role` es total: vive solo en secretos de Kapso y `.env.local`.
- **El plan gratis de Supabase pausa proyectos inactivos ~7 días.** Con uso
  real no pasa; si pasara, la degradación es la diseñada (todo vuelve a
  preguntarse). Vale saberlo antes de extrañarse.
- **Dos registros del mismo pedido** (D1 y Supabase) pueden discrepar si
  Supabase falla al emitir. D1 es la verdad técnica; Supabase el registro de
  negocio. La columna `persistencia` de la respuesta deja huella del hueco.
- **El teléfono como llave** asume un cliente = un WhatsApp. Una empresa con
  dos compradores serán dos filas — correcto para facturación, pero vale
  tenerlo presente al mirar la tabla.
