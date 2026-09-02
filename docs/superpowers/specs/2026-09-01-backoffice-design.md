# Diseño: Backoffice interno de operación

**Fecha:** 2026-09-01
**Estado:** Aprobado
**Depende de:** la persistencia en Supabase (spec 2026-08-31) y los PDF de
cotización y de orden de compra (spec 2026-09-01), que son las fuentes de
datos y los documentos que este front enlaza.

## Problema

El dueño del local y su operador no tienen dónde ver el estado del negocio
que el bot genera: qué pedidos hay, cuáles están pagados y sin entregar, qué
se cotizó y cuánto convierte, quién es el cliente que está llamando. Kapso
tiene front propio para las **conversaciones**, pero no sabe nada de pedidos,
cotizaciones ni clientes (eso vive en Supabase). Además, "pagado" y
"entregado" hoy **no existen como dato**: `pedidos.estado` registra el estado
del correo de la OC (`sent`/`failed`), no el del negocio.

## Decisiones tomadas

### App nueva `apps/backoffice` con Next.js, proyecto Vercel propio

Tercer proyecto Vercel (`rr-backoffice`) junto a la pricing-api y el relé.
Next.js App Router en TypeScript: páginas y API juntas, middleware para la
sesión, hosting sin config. Es la primera dependencia de framework del repo,
asumida a propósito: un dashboard con vistas, filtros, sesión y escrituras es
exactamente el caso para el que existe.

Se descartó extender el relé (`apps/mailer`) con UI — mezclaría
responsabilidades y un deploy del dashboard podría romper el envío de
correos — y quedarse en Supabase Studio como visor (UI genérica de base de
datos, sin la vista "pagado por entregar", y editar celdas a mano es
propenso a errores).

### Todo el acceso a datos es del lado del servidor

Componentes de servidor y route handlers leen y escriben Supabase (PostgREST
via `fetch`, patrón del relé) con la `service_role`. Variables
`SUPABASE_URL` / `SUPABASE_SERVICE_KEY` en el proyecto Vercel. Al navegador
nunca viaja una credencial de base ni una llamada directa a Supabase.

### Login con clave compartida, sesión por cookie firmada

- Página única `/login` contra el secreto `BACKOFFICE_PASSWORD`.
- Comparación de tiempo constante y pausa de 1 s al fallar (frena fuerza
  bruta sin infraestructura de rate limiting).
- Si calza: cookie de sesión `HttpOnly` + `Secure` + `SameSite=Lax`, firmada
  con HMAC (`BACKOFFICE_SESSION_SECRET`), vigencia 30 días.
- Un middleware protege todas las rutas menos `/login` y los assets.
- Sin cuentas individuales en v1; subir a cuentas después no rediseña nada
  porque toda la lógica ya pasa por el servidor.

### Estado de negocio en `pedidos`, separado del estado técnico

```sql
alter table pedidos add column if not exists estado_negocio text not null default 'nuevo'
  check (estado_negocio in ('nuevo','pagado','entregado','anulado'));
alter table pedidos add column if not exists pagado_at timestamptz;
alter table pedidos add column if not exists entregado_at timestamptz;
```

(Archivo en `docs/sql/`, lo pega el usuario en el SQL Editor — mismo flujo
de siempre.)

Máquina de estados: `nuevo → pagado → entregado`, con `anulado` alcanzable
desde cualquier estado no-entregado. Cada transición estampa su fecha. El
`estado` existente (correo `sent`/`failed`) no se toca y se muestra aparte.

**La unidad operativa es el pedido del cliente, no la fila.** Las filas de
`pedidos` son una por mayorista (una OC cada una); marcar "pagado" aplica al
grupo `quote_id + version` completo: el servidor actualiza todas las filas
del grupo en una sola escritura PostgREST
(`PATCH /pedidos?quote_id=eq.X&quote_version=eq.Y`).

**Pagos futuros ya calzan:** cuando exista pago online, el webhook del medio
de pago escribirá `estado_negocio = 'pagado'` en ese mismo campo. El front
no cambia.

### Conversaciones: enlazar a Kapso, no duplicar

Link al front de Kapso en la barra y en cada pedido (a la conversación del
teléfono si la URL de Kapso lo permite; si no, al inbox general). Este
backoffice no lee ni muestra mensajes.

### Responsive

Pensado para el teléfono del local además del escritorio: la lista de
pedidos y los botones de transición tienen que operarse con el pulgar.

## Las vistas

### Pedidos (portada, `/`)

- **Contadores arriba:** pagados por entregar · nuevos · OC con correo
  fallido.
- **Lista agrupada** por pedido del cliente (`quote_id + version`), orden
  descendente por fecha: razón social y teléfono, fecha, total de venta
  (CLP, desde la fila de `cotizaciones`), badge de `estado_negocio`, y el
  estado técnico de cada OC por mayorista (enviada/fallida).
- **Detalle desplegable:** las líneas del pedido (producto, cantidad,
  precios de venta), links al PDF de la cotización
  (`/api/cotizacion/<quote_id>` del relé), a los PDF de cada OC
  (`/api/orden/<po_id>`), y a la conversación en Kapso.
- **Acciones:** Marcar pagado → Marcar entregado; Anular pide un diálogo de
  confirmación simple antes de ejecutar.
- **Filtro** por estado de negocio.

### Cotizaciones (`/cotizaciones`)

Lista: N° correlativo, fecha, cliente (razón social si el teléfono calza con
`clientes`, si no el teléfono), total CLP, **vigente/expirada** (contra
`valida_hasta`), badge "→ pedido" si existe un grupo en `pedidos` con su
`quote_id + version`, link al PDF. Sin acciones: las cotizaciones son
inmutables.

### Clientes (`/clientes`)

Lista por teléfono con razón social y RUT. La ficha (`/clientes/<telefono>`)
muestra los siete datos de facturación y el historial de cotizaciones y
pedidos de ese teléfono. **Solo lectura en v1**: los datos los corrige el
bot conversando, que ya funciona y ya está probado.

### Salud (`/salud`)

Tres chequeos hechos desde el servidor al cargar la página (timeout corto,
4 s):

| Chequeo | Cómo | Verde si |
|---|---|---|
| Supabase | la propia consulta de contadores | responde |
| API de la oficina | `GET` barato a la pricing-api vía el túnel, con `API_SECRET_KEY` server-side | 200 |
| Relé correo/PDF | `GET /api/cotizacion/<uuid inexistente>` | 404 con `cotizacion_no_encontrada` (respuesta viva del contrato) |

Más dos números: cotizaciones de las últimas 24 h (pulso del bot) y OC
fallidas pendientes. Sin historial, sin gráficos, sin alertas — es un
semáforo, no Grafana.

## Manejo de errores

| Situación | Comportamiento |
|---|---|
| Supabase caído | Cada vista muestra "no se pudo cargar" con botón reintentar; nunca página en blanco ni 500 pelado |
| Transición inválida (entregar lo no pagado) | El servidor la rechaza con 409 y el front lo dice; los botones solo ofrecen las transiciones legales, la validación del servidor es la autoridad |
| Doble clic / marcar dos veces | Idempotente: marcar `pagado` lo ya pagado responde ok sin efecto |
| Cookie inválida o vencida | Redirect a `/login` |
| Contraseña incorrecta | Mensaje genérico + pausa de 1 s |
| Filas de `pedidos` anteriores al ALTER | Nacen `nuevo` por el `default` — correcto: nadie las ha marcado |

## Testing

Al estilo del repo (vitest, `fetch` mockeado):

- **Lógica pura** (el grueso): máquina de estados (transiciones legales e
  ilegales), agrupación de filas por `quote_id + version`, armado de los
  view-models de cada vista (contadores, vigente/expirada, badge "→ pedido"),
  verificación de cookie firmada (válida, adulterada, vencida).
- **Handlers de escritura:** marcar pagado emite el PATCH correcto al grupo
  completo; transición ilegal → 409; sin sesión → 401.
- **Login:** contraseña buena setea cookie firmada; mala no, y demora ≥1 s.
- Sin tests de navegador (YAGNI para un dashboard interno).

## Verificación de punta a punta

1. Login desde el teléfono y desde escritorio.
2. Un pedido real (o sintético) aparece en la portada como `nuevo`; marcarlo
   `pagado` y ver el contador "pagados por entregar" subir; marcarlo
   `entregado` y verlo salir.
3. Los links de PDF (cotización y OC) abren los documentos del relé.
4. `/salud` en verde con la oficina arriba; apagar el túnel y ver el chequeo
   en rojo (y nada más romperse).

## Fuera de alcance (v1)

- Pagos online (solo queda listo el campo que el webhook escribirá).
- Editar datos de clientes o líneas de pedidos.
- Cuentas individuales y auditoría de quién marcó qué.
- Notificaciones (push/email) de nuevos pedidos.
- Reportes/estadísticas más allá de los contadores.

## Riesgos conocidos

- **Primera dependencia de framework del repo** (Next.js). Asumida: el
  costo de hand-rollear routing + sesión + SSR supera con creces el de la
  dependencia.
- **Clave compartida**: quien la tenga puede marcar estados y ver PII. Es el
  modelo elegido para 2-3 personas de confianza; la mitigación de fuerza
  bruta es la pausa + comparación constante, y la rotación es cambiar un
  secreto en Vercel.
- **El estado de negocio es manual** hasta que existan pagos online: si
  nadie marca, los contadores mienten por omisión. Riesgo operativo, no
  técnico — el front lo hace fácil de marcar desde el teléfono justamente
  por esto.
- **Un cuarto proyecto que desplegar** (tras pricing-api, relé y Kapso). El
  deploy es `npx vercel --prod` con el patrón de IDs ya conocido.
