# Diseño: pagos con Mercado Pago en el Rayo (WhatsApp)

**Fecha:** 2026-09-10
**Estado:** Propuesto
**Depende de:** el workflow `rr-isia-version2` (nodo `agente_cierre` y la
function `emitir-ordenes-compra`), la persistencia en Supabase
(`cotizaciones`, `pedidos`, `clientes`), el relé `apps/mailer` (proyecto
Vercel `rr-mailing`) y el backoffice — todo ya en producción.

## Problema

Hoy el bot cierra la venta sin cobrar: `agente_cierre` obtiene el "sí",
`emitir-ordenes-compra` dispara las órdenes de compra a los mayoristas, y un
humano coordina el pago después por WhatsApp o teléfono. Eso compra stock
real contra una promesa: el pedido puede caerse después de que la orden ya
salió al mayorista.

El dueño quiere cobrar con Mercado Pago dentro de la conversación del Rayo, y
—decisión explícita suya— **cobrar primero y emitir después**: las órdenes de
compra salen solo cuando el pago está aprobado.

La tienda web (`apps/tienda`) queda fuera de esta fase. El servicio que se
construye acá es el que después usará también la tienda, sin rediseñarlo.

## Decisiones tomadas

### El servicio de pagos vive en `apps/mailer` (el relé)

No se crea un proyecto nuevo en Vercel. El relé ya es el puente entre Kapso y
el mundo exterior, y ya tiene las cuatro cosas que el cobro necesita:

- autenticación de llamadas desde Kapso con `MAILER_API_KEY`;
- lectura y escritura de Supabase con la service key;
- envío de correo interno **en proceso** (`packages/mailer`), que hace falta
  para avisar de un pago aprobado que no se pudo emitir;
- funciones serverless en `api/` con `maxDuration` 30 y pruebas vitest.

Se descartó `apps/pagos` como quinto proyecto: dos endpoints no justifican
otro `vercel link`, otro juego de variables y otro deploy, y el aviso interno
tendría que salir por HTTP contra este mismo relé.

Queda dicho en el README que el relé dejó de ser solo correo: es el relé de
servicios entre Kapso y el exterior (correo, PDF de cotización, PDF de orden
y ahora cobro). El nombre del proyecto Vercel no cambia.

### El workflow gana un nodo `webhook` y pierde dos

Kapso permite **5 Cloudflare Workers desplegados** y el cupo está en 5 de 5.
Por eso el cobro **no** es una function nueva: el nodo `webhook` de Kapso
llama a cualquier URL con un secreto en el header y no consume cupo.

```
hoy:    agente_cierre → fn_emitir_ordenes → send_confirmacion → handoff_fin
queda:  agente_cierre → fn_crear_pago (webhook) → handoff_fin
```

- **`fn_emitir_ordenes` sale del grafo.** La function `emitir-ordenes-compra`
  sigue desplegada y no se toca: ahora la invoca el servicio de pagos por la
  Platform API cuando el pago se aprueba — el mismo camino que ya usa
  `apps/tienda` en producción.
- **`send_confirmacion` sale del grafo.** Hoy manda un texto fijo pase lo que
  pase. Con cobro habría que elegir entre tres mensajes (link enviado, fallo
  al crear el link, cotización vencida) y el nodo no sabe cuál. El servicio de
  pagos sí lo sabe, así que él manda el mensaje.
- **`fn_crear_pago` entra** apuntando a `POST /api/pago/crear` del relé, con
  `X-API-Key: ${ENV:MAILER_API_KEY}`.

Neto: un nodo menos en el grafo, cero cupo de Worker consumido, y ningún
comportamiento de Kapso sin verificar en el camino crítico.

### Todos los mensajes al cliente los manda el servicio de pagos

Con el patrón que ya funciona en producción: el proxy Meta de Kapso
(`POST https://api.kapso.ai/meta/whatsapp/v24.0/{phone_number_id}/messages`
con `X-API-Key`), el mismo que usa `generar-cotizacion-v2` para mandar el PDF
de la cotización.

| Cuándo | Mensaje |
|---|---|
| Preferencia creada | Interactivo `cta_url` con el botón "Pagar" y el monto |
| No se pudo crear el link | "Tuvimos un problema con el link de pago. Te contactamos por acá" |
| Cotización sin vigencia útil | "Los precios hay que refrescarlos, dame un momento" |
| Pago rechazado | "El pago fue rechazado. Puedes reintentar con el mismo link" |
| Pago aprobado y emitido | "Pago recibido, tu pedido quedó cursado 🙌" |
| Pago aprobado sin emitir | "Recibimos tu pago. Te confirmamos el pedido por acá" |

Los tres últimos ocurren cuando la ejecución del workflow ya terminó en
`handoff_fin`, así que no hay nodo que pueda mandarlos: tienen que salir del
servicio. Unificar los seis en el mismo lugar evita dos códigos de envío y
deja los textos donde se decide la verdad que cuentan.

El `phone_number_id` y el teléfono llegan al servicio desde el nodo `webhook`
como `{{system.whatsapp_config.phone_number_id}}` y
`{{context.phone_number}}` — ambos escalares documentados.

### Cobrar primero, emitir después

```
agente_cierre obtiene el sí
  → fn_crear_pago  →  preferencia MP + fila `pagos` + link por WhatsApp
  → handoff_fin (la ejecución termina; el cliente paga cuando quiera)

Mercado Pago avisa  →  POST /api/pago/webhook
  → valida firma
  → GET /v1/payments/{id} y compara monto y external_reference
  → transición atómica pendiente → aprobado
  → invoca emitir-ordenes-compra (Platform API)
  → marca los `pedidos` como `pagado`
  → avisa al cliente por WhatsApp
```

Nada le llega al mayorista antes del pago aprobado.

### La vigencia de la cotización manda sobre el link

La cotización dura 3 horas (`COTIZACION_VALID_HOURS`) y
`emitir-ordenes-compra` rechaza con 409 cualquier cotización vencida — ese
guard no se toca, es lo que impide comprar contra un precio muerto.

El link de pago se crea con `expiration_date_to` = `valid_until` **menos 15
minutos**, para que un pago iniciado justo antes del cierre alcance a
completarse dentro de la vigencia.

Si aun así el pago se aprueba con la cotización vencida, **no se emite nada**:
la fila queda en `aprobado_sin_emitir`, sale un correo interno y el cliente
recibe "recibimos tu pago, te confirmamos por acá". Lo resuelve una persona,
que es lo correcto: hay plata recibida y precios que ya cambiaron.

### Solo medios de pago inmediatos

Se excluyen los tipos `ticket` y `atm` (efectivo en Servipag y similares), que
quedan `pending` por días y dejarían pedidos en limbo con una cotización
vencida hace rato. Quedan tarjetas de crédito, débito y saldo de Mercado
Pago, que aprueban en segundos.

### Mercado Pago se integra a mano, sin SDK

Dos llamadas HTTP (`POST /checkout/preferences` y `GET /v1/payments/{id}`)
más una verificación HMAC. Un SDK agrega una dependencia y su cadena de
actualizaciones para eso. El repositorio ya integra Intcomex, Ingram,
Tecnoglobal, Kapso y Supabase con `fetch` pelado; esto sigue el mismo patrón
y se prueba igual, con `fetch` stubbeado.

Mercado Pago no está en el Vercel Marketplace y es el riel de pago de Chile:
la elección de proveedor es del dueño y no hay alternativa equivalente en el
catálogo.

## Datos

### Tabla nueva `pagos`

`quote_id` como llave primaria: un intento de cobro por cotización. Eso da
idempotencia natural — si el nodo `webhook` se llama dos veces por la misma
cotización, se devuelve el `init_point` que ya existe en vez de crear una
segunda preferencia.

```sql
create table if not exists pagos (
  quote_id        text primary key,
  quote_version   text not null,
  numero          bigint,
  telefono        text,
  phone_number_id text,
  preference_id   text not null,
  init_point      text not null,
  monto_clp       bigint not null,
  expira_at       timestamptz not null,
  estado          text not null default 'pendiente'
    check (estado in ('pendiente','aprobado','emitido','aprobado_sin_emitir')),
  mp_payment_id   text,
  intentos_rechazados int not null default 0,
  datos           jsonb not null,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  aprobado_at     timestamptz,
  emitido_at      timestamptz
);
alter table pagos enable row level security;
```

`datos` guarda lo que `emitir-ordenes-compra` espera en `vars` y que no vive
en ninguna otra tabla: `quote_customer_name` y los siete `billing_*`. RLS
activada sin policies, igual que las otras tres tablas: el único acceso
legítimo es la service key.

La máquina de estados es corta a propósito:
`pendiente → aprobado → {emitido | aprobado_sin_emitir}`.

**Un pago rechazado no es un estado.** Una tarjeta rechazada seguida de un
segundo intento exitoso es de lo más común, y un estado terminal `rechazado`
haría que la transición condicional a `aprobado` fallara justo en el intento
bueno. Así que un rechazo deja la fila en `pendiente`, incrementa
`intentos_rechazados` y avisa al cliente; el link sigue vivo hasta que expire.

Tampoco hay estado `expirado`, porque nada lo escribiría. Una fila `pendiente`
que nadie pagó se queda `pendiente`; si algún día molesta en el backoffice, un
cron la barre.

### Columna nueva `cotizaciones.proveedores_incompletos`

El servicio reconstruye el `quote_result` para `emitir-ordenes-compra` desde
la fila de `cotizaciones`. La function usa exactamente cinco campos de la
cotización: `quote_id`, `version`, `lineas`, `valid_until` y
`proveedores_incompletos`. Los cuatro primeros están persistidos; el quinto
no, y es el que pone en el correo de la orden el aviso "al cotizar no
respondieron X, el precio ganador lo es solo entre los que sí respondieron".

Perder ese aviso degradaría en silencio un correo que hoy es honesto. Se
arregla con una columna y una línea:

```sql
alter table cotizaciones add column if not exists proveedores_incompletos jsonb;
```

y `generar-cotizacion-v2` la escribe en el `POST /cotizaciones` que ya hace.
Es la única modificación a una function existente, y el redespliegue
(`npm run kapso:functions`) es idempotente.

## Endpoints nuevos en `apps/mailer`

### `POST /api/pago/crear`

Autenticado con `x-api-key: MAILER_API_KEY`, la misma clave que Kapso ya
tiene cargada para el correo.

Recibe escalares: `quote_id`, `quote_version`, `phone_number`,
`phone_number_id`, `customer_name` y los siete `billing_*`.

1. Lee la cotización de Supabase por `quote_id`. Si no existe → 404.
2. Si ya hay fila en `pagos`, devuelve su `init_point` sin crear nada.
3. Si a la cotización le quedan **menos de 15 minutos** de vigencia (vencida
   incluida) → 409 sin crear preferencia, y el mensaje al cliente dice que los
   precios hay que refrescarlos. Es el mismo umbral que la holgura del link:
   por debajo de eso no queda ventana para pagar dentro de la vigencia, y un
   link que nace condenado es peor que no mandarlo.
4. Crea la preferencia en `POST https://api.mercadopago.com/checkout/preferences`
   con `Authorization: Bearer $MP_ACCESS_TOKEN` y `X-Idempotency-Key: <quote_id>`:
   un ítem por el total (`unit_price` = `total_clp`, `currency_id` "CLP",
   `quantity` 1, título "Pedido N° <numero>"), `external_reference` =
   `quote_id`, `notification_url` = `<PAGO_BASE_URL>/api/pago/webhook`,
   `back_urls` a `/api/pago/retorno`, `expiration_date_to` = vigencia menos 15
   minutos, y `payment_methods.excluded_payment_types` = `ticket` y `atm`.
5. Inserta la fila `pagos` en estado `pendiente`.
6. Manda el interactivo `cta_url` por WhatsApp.

Devuelve `{ ok, estado, init_point }`.

### `POST /api/pago/webhook`

Público — Mercado Pago no puede mandar nuestra API key. La autenticidad la da
la firma, y es obligatoria.

1. **Valida `x-signature`**: el header trae `ts=<millis>,v1=<hex>`. Se arma el
   manifiesto `id:<data.id>;request-id:<x-request-id>;ts:<ts>;` y se compara
   `v1` contra `HMAC-SHA256(manifiesto, MP_WEBHOOK_SECRET)` en hexadecimal,
   con comparación de tiempo constante. Si no cuadra → 401, y al log va el
   tipo de fallo, nunca el cuerpo.
2. Solo atiende notificaciones de tipo `payment`; cualquier otra → 200 y nada.
3. **Re-consulta el pago** en `GET https://api.mercadopago.com/v1/payments/{id}`.
   El cuerpo del webhook nunca se cree: el monto y la referencia salen de esa
   consulta.
4. **Compara** `external_reference` contra el `quote_id` y
   `transaction_amount` contra `pagos.monto_clp`. Si algo no calza → fila a
   `aprobado_sin_emitir`, correo interno, y **no se emite nada**.
5. `status` distinto de `approved`: si es `rejected`, la fila se queda en
   `pendiente`, sube `intentos_rechazados` y el cliente recibe el aviso; si
   sigue `pending`, no se toca nada. 200 en ambos casos.
6. **Transición atómica** `pendiente → aprobado`: un `PATCH` condicionado a
   `estado=eq.pendiente` con `return=representation`. Cero filas devueltas
   significa que otra entrega del mismo webhook ya la tomó → 200 y nada más.
   Es el mismo patrón condicional que ya usa
   `apps/backoffice/app/api/pedidos/transicion/route.ts`.
7. Reconstruye el `quote_result` e invoca `emitir-ordenes-compra` por la
   Platform API con `quote_confirmed: true`.
8. Si emitió: fila a `emitido`, los `pedidos` de esa cotización pasan a
   `estado_negocio = 'pagado'` con `pagado_at`, y el cliente recibe el aviso.
   Si no: `aprobado_sin_emitir`, correo interno, aviso honesto al cliente.

Siempre responde 200 salvo firma inválida (401) o fallo propio (500, para que
Mercado Pago reintente).

### `GET /api/pago/retorno`

La página a la que Mercado Pago devuelve al cliente. HTML mínimo: "Listo,
vuelve a WhatsApp". No decide nada — la verdad del pago llega por el webhook.

## Variables de entorno nuevas (proyecto `rr-mailing`)

| Variable | Qué es |
|---|---|
| `MP_ACCESS_TOKEN` | Access token de la aplicación en Mercado Pago. **Sensitive** |
| `MP_WEBHOOK_SECRET` | Clave secreta de la notificación, del panel de MP. **Sensitive** |
| `PAGO_BASE_URL` | Base pública del relé, `https://rr-mailing.vercel.app` |
| `KAPSO_API_KEY` | Para invocar `emitir-ordenes-compra` y mandar WhatsApp |

Se reutilizan `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `MAILER_API_KEY` y las
credenciales SMTP que el relé ya tiene.

En Kapso, el nodo `webhook` necesita `MAILER_API_KEY` como variable de
entorno del workflow (`${ENV:MAILER_API_KEY}`), que es la misma clave ya
cargada como secreto de `emitir-ordenes-compra`.

## Manejo de errores

| Situación | Comportamiento |
|---|---|
| Mercado Pago no responde al crear la preferencia | Nada se persiste; el cliente recibe "tuvimos un problema con el link, te contactamos". El handoff deja la conversación con un humano |
| El nodo `webhook` no alcanza al relé | El grafo avanza a `handoff_fin`; el cliente queda sin link y un humano ve el handoff. Mismo riesgo que hoy corre cualquier fallo del cierre |
| Webhook con firma inválida | 401, log sin cuerpo, nada se toca |
| Webhook repetido (MP reintenta) | La transición condicional lo absorbe: la segunda entrega no emite |
| Monto o referencia que no calzan | `aprobado_sin_emitir` + correo interno. Nunca se emite |
| Pago aprobado con cotización vencida | `aprobado_sin_emitir` + correo interno; al cliente se le dice que recibimos el pago |
| `emitir-ordenes-compra` falla o devuelve `ok: false` | `aprobado_sin_emitir` + correo interno. El cliente no recibe una promesa falsa |
| Emisión ok con alguna OC en `failed` | La fila queda `emitido` — el contrato honesto de hoy: la OC fallida se ve en el backoffice |
| Pago rechazado | La fila sigue `pendiente` y sube el contador de intentos; el cliente recibe el aviso y reintenta con el mismo link mientras no expire |
| Cotización con menos de 15 minutos de vigencia | No se crea link; el cliente recibe que hay que refrescar precios |

## Cambios en los prompts

`agente-cierre` sube a **v-03**: la única diferencia es que el mensaje de
confirmación ya no promete que un humano contactará para coordinar el pago,
sino que anuncia que el link de pago llega enseguida. `quote_confirmed`
mantiene exactamente la misma semántica y la misma advertencia — es lo que
ahora dispara el cobro en vez de la orden de compra.

`agente-facturacion` no cambia: sigue prohibido preguntar por forma de pago.

## Testing

Estilo del repositorio: vitest con `fetch` stubbeado, lógica pura separada de
los handlers.

**Lógica pura:**
- armado del manifiesto y validación de la firma: válida, alterada, header
  ausente, secreto equivocado, `ts` fuera de formato;
- armado del cuerpo de la preferencia: monto, cálculo de `expiration_date_to`
  (incluida la cotización que vence en menos de 15 minutos), tipos excluidos,
  `external_reference`;
- reconstrucción del `quote_result` desde la fila de `cotizaciones`, campo por
  campo contra lo que `emitir-ordenes-compra` lee;
- armado del payload de emisión y de los tres mensajes de WhatsApp;
- la máquina de estados: cada transición legal y cada una ilegal.

**Handlers** con Supabase, Mercado Pago y Kapso mockeados: flujo feliz
completo; webhook duplicado; monto que no calza; referencia que no calza;
cotización vencida; `emitir` caído; `emitir` con `ok: false`; pago rechazado;
firma inválida; `crear` idempotente sobre una cotización que ya tiene fila.

Sin pruebas de navegador.

## Verificación de punta a punta

Con credenciales de **prueba** de Mercado Pago y un comprador de prueba:

1. Conversación real en el número sandbox hasta el sí de `agente_cierre` →
   llega el mensaje con el botón "Pagar" y el monto correcto.
2. Pagar con tarjeta de prueba aprobada → llega el aviso de pedido cursado,
   las OC llegan al correo interno con sus PDF, y el pedido aparece en el
   backoffice ya en `pagado`.
3. Pagar con tarjeta de prueba rechazada → llega el aviso de rechazo y no se
   emite ninguna orden.
4. Reenviar a mano la misma notificación del webhook → no se emite una segunda
   orden.
5. Cotización forzada a vencida → `aprobado_sin_emitir` y correo interno.

Recién después se cargan las credenciales de producción, que es solo cambiar
dos variables en Vercel y el `notification_url` en el panel de Mercado Pago.

## Fuera de alcance (v1)

- La tienda web. `apps/tienda/app/api/confirmar` sigue emitiendo sin cobrar;
  enchufarla es una fase siguiente que reusa `POST /api/pago/crear` tal cual.
- Devoluciones, pagos parciales y cuotas más allá del comportamiento por
  defecto de Mercado Pago.
- Un cron que barra filas `pendiente` que nadie pagó.
- Recotizar automáticamente cuando el pago llega con la cotización vencida.
- Medios de pago en efectivo.

## Riesgos conocidos

- **Endpoint público que mueve dinero.** Mitigado con firma HMAC obligatoria,
  re-consulta del pago contra Mercado Pago y comparación de monto y
  referencia. Ningún dato del cuerpo del webhook se usa para decidir.
- **El relé pasa a custodiar un secreto de grado pago.** `MP_ACCESS_TOKEN`
  entra como variable Sensitive y nunca se imprime; los logs de fallo siguen
  la regla que ya rige en el repositorio (function y tipo de fallo, jamás el
  payload).
- **Ventana entre pago y vigencia.** Los 15 minutos de holgura la reducen, no
  la eliminan. El caso residual termina en intervención humana con el dinero
  ya recibido, que es preferible a emitir contra precios muertos.
- **El nodo `webhook` de Kapso no está probado en este proyecto.** Es el único
  comportamiento nuevo de la plataforma en el camino crítico. Se verifica en
  el paso 1 de la verificación de punta a punta, antes de tocar producción.
- **`quote_confirmed` deja de ser la última puerta antes de gastar dinero** y
  pasa a ser la puerta antes de cobrar. El riesgo baja: un falso positivo del
  LLM ahora manda un link de pago, no una orden de compra.
