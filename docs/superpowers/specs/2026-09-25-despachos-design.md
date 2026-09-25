# Diseño: módulo de compras y despachos

**Fecha:** 2026-09-25
**Antecedentes:** `docs/superpowers/specs/2026-09-01-backoffice-design.md`
(backoffice y `estado_negocio`), `docs/superpowers/specs/2026-09-10-pagos-mercado-pago-design.md`
(el pedido pasa a `pagado` al acreditarse).

## Problema

Después del pago no hay nada. La orden de compra sale por correo a la bandeja
interna (`OC_EMAIL_DESTINO`), alguien compra a mano en el portal del
mayorista, y desde ahí todo vive en WhatsApp y en la memoria del equipo:

- No queda registro de si ya se compró, con qué número de pedido del
  mayorista, si hay que ir a retirarlo o si lo despachan, ni si llegó.
- No hay dirección de despacho: se usa la de facturación.
- No hay registro de cómo se entregó, con qué courier, cuánto costó ni cuánto
  se le cobró al cliente por el envío.
- El único paso es el botón "Marcar entregado" del pedido completo.

## Modelo actual que condiciona el diseño

- **Una fila de `pedidos` es una orden de compra a UN mayorista**, no el
  pedido del cliente. El pedido del cliente es el grupo de filas que comparten
  `quote_id` + `quote_version` (`agruparPedidos`,
  `apps/backoffice/src/lib/pedidos.ts`). Un pedido con productos de Intcomex y
  Tecnoglobal son dos órdenes de compra.
- Cada línea de `pedidos.lineas` (jsonb) trae `mpn`, `nombre`, `cantidad`,
  `proveedor`, precios y `abastecimiento` (`stock_inmediato` o
  `por_comprar_importar`). Dentro de un pedido, una línea se identifica por
  `po_id` + `mpn`: el mejor precio asigna cada producto a un solo mayorista.
- `estado_negocio` del grupo: `nuevo → pagado → entregado | anulado`, con
  transiciones condicionales sobre el grupo entero
  (`apps/backoffice/app/api/pedidos/transicion/route.ts`).
- El backoffice lee y escribe Supabase por PostgREST con la service key
  (`apps/backoffice/src/lib/supabase.ts`: `supabaseGet`, `supabasePatch`; no
  hay helper de insert todavía). Las tablas tienen RLS activo sin políticas.
- Los esquemas se aplican a mano en el SQL Editor de Supabase
  (`docs/sql/*.sql`).

## Decisiones tomadas (con el usuario, 2026-09-25)

1. **Ruta de la mercadería:** todavía no se sabe si el mayorista despachará
   directo al cliente. El diseño soporta las dos: pasa por nosotros, o va
   directo al cliente.
2. **Despachos parciales, caso a caso:** por defecto se espera a tener todo,
   pero el equipo puede armar un despacho con lo que ya llegó. Un pedido puede
   terminar en uno o más despachos.
3. **La dirección y la modalidad las registra el equipo en el backoffice.** Se
   sigue coordinando por WhatsApp como hoy; la dirección de facturación viene
   precargada. Tienda y bot no cambian.
4. **El envío se cobra aparte al cliente.** Se registra cuánto nos costó y
   cuánto se le cobró, y si ese cobro ya se pagó.
5. **Couriers: sin integración al comienzo.** No hay convenio con ningún
   courier y hay que cuidar la caja. El equipo lleva el paquete al courier que
   convenga y registra número de seguimiento y costo. La estructura queda lista
   para integrar; el primero sería **Blue Express** (sin costo de activación ni
   mínimo, cobra por envío, pide cuenta corriente). Starken Pro exige 12 meses
   de formalización; Shipit cobra desde 0,9 UF al mes, que con poco volumen no
   se justifica.
6. **Enfoque A:** extender `pedidos` para las compras y crear tablas nuevas
   solo para los despachos. Descartados: un módulo de logística con tablas
   propias para compras (duplica la orden de compra y obliga a sincronizarla)
   y un registro de eventos del que se derive el estado (flexible, pero
   consultar lo pendiente se complica para un equipo chico).

## Diseño

### Parte 1 — Compras (lo que compramos a los mayoristas)

Columnas nuevas en `pedidos` (cada fila, una orden de compra):

| Columna | Tipo | Uso |
|---|---|---|
| `estado_compra` | text, default `por_comprar` | Estado de abastecimiento (abajo). |
| `modalidad_compra` | text, null | `retiro`, `despacho_mayorista` o `directo_cliente`. |
| `numero_pedido_mayorista` | text, null | El número que da el portal del mayorista. |
| `comprada_at` | timestamptz, null | Cuándo se compró. |
| `llegada_estimada` | date, null | Opcional. |
| `guia_mayorista` | text, null | Guía o seguimiento del despacho del mayorista, si hay. |
| `nota_compra` | text, null | Libre. |

El default hace que las órdenes nuevas nazcan en `por_comprar` sin tocar
`emitir-ordenes-compra`. Las existentes se rellenan una vez: `entregado` pasa a
`recibida`, `anulado` a `anulada`, y el resto queda en `por_comprar`.

**Estados:**

```
por_comprar ──► comprada ──┬─► por_retirar ──► recibida
     │                     ├─► en_camino ────► recibida
     │                     └─► directo_al_cliente ──► entregada_al_cliente
     └──► anulada          (recibida_parcial mientras falte parte)
```

- `comprada` exige `modalidad_compra` y `numero_pedido_mayorista`.
- Con `retiro` pasa a `por_retirar`; con `despacho_mayorista`, a `en_camino`;
  con `directo_cliente`, a `directo_al_cliente`.
- `recibida_parcial` y `recibida` no se eligen a mano: se calculan con las
  recepciones (abajo).
- `anulada` desde cualquier estado anterior a `recibida` o
  `entregada_al_cliente`.
- **Atrasada** no es un estado: es `llegada_estimada < hoy` sin estar
  `recibida` ni `entregada_al_cliente`. La vista la muestra como alerta.

**Recepciones.** Tabla nueva `recepciones`:

| Columna | Tipo |
|---|---|
| `id` | bigint identity |
| `po_id` | text, referencia a `pedidos` |
| `mpn` | text |
| `cantidad` | int > 0 |
| `recibido_at` | timestamptz, default now() |
| `nota` | text, null |

Al registrar una recepción, la orden de compra pasa a `recibida_parcial`, o a
`recibida` cuando la suma recibida de cada línea alcanza la cantidad comprada.
No se puede recibir más de lo comprado.

### Parte 2 — Despachos al cliente

**Tablas nuevas:**

`despachos`

| Columna | Tipo | Uso |
|---|---|---|
| `id` | bigint identity | Es también el número visible del despacho (N° 1, 2, 3…). |
| `quote_id`, `quote_version` | text | El pedido del cliente. |
| `modalidad` | text | `retiro_oficina`, `propio` o `courier`. |
| `courier` | text, null | `bluexpress`, `starken`, `chilexpress` u `otro` (solo con `courier`). |
| `estado` | text, default `por_preparar` | Abajo. |
| `direccion`, `comuna`, `ciudad` | text, null | Precargados desde la facturación del cliente. |
| `contacto_nombre`, `contacto_telefono` | text, null | Quién recibe. |
| `fecha_programada` | date, null | |
| `responsable` | text, null | Quién del equipo lo lleva o lo gestiona. |
| `numero_seguimiento` | text, null | Del courier. |
| `costo_clp` | int, null | Lo que nos costó el envío. |
| `cobrado_clp` | int, null | Lo que se le cobró al cliente. |
| `cobro_pagado` | boolean, default false | Si el cliente ya pagó el envío. |
| `nota` | text, null | |
| `created_at`, `updated_at`, `despachado_at`, `entregado_at` | timestamptz | |

`despacho_lineas`: `despacho_id`, `po_id`, `mpn`, `cantidad` (int > 0).

`despacho_eventos`: `id`, `despacho_id`, `desde` (null al crear), `hacia`,
`nota`, `created_at`. Se escribe en cada creación y cada cambio de estado.

**Estados:**

```
por_preparar ──► listo ──► en_ruta ──► entregado
     │             │          └─► fallido ──► listo   (reprogramar)
     └─────────────┴──► anulado
```

- `por_preparar`: creado; puede faltar mercadería.
- `listo`: toda la mercadería del despacho está en mano. Con `retiro_oficina`
  significa "listo para que el cliente lo retire".
- `en_ruta`: lo lleva el equipo o ya está en el courier. Con `courier` exige
  `numero_seguimiento`.
- `entregado`: el cliente lo recibió o lo retiró.
- `fallido`: no se pudo entregar; se reprograma volviendo a `listo`.
- `anulado`: libera sus líneas para otro despacho.
- Con `retiro_oficina`, `listo` pasa directo a `entregado` (no hay ruta).

**Cantidades por línea** (`po_id` + `mpn`) dentro de un pedido:

- *comprada*: la `cantidad` de la línea en `pedidos.lineas`.
- *recibida*: suma de `recepciones`.
- *asignada*: suma de `despacho_lineas` en despachos no anulados.
- *en mano*: asignada a despachos `listo`, `en_ruta` o `entregado`.

Reglas:

- Un despacho no puede asignar más de lo comprado menos lo ya asignado.
- Las líneas de órdenes de compra en `directo_al_cliente` o
  `entregada_al_cliente` no se pueden asignar a un despacho nuestro.
- Pasar a `listo` exige que, para cada línea del despacho,
  `recibida − (en mano de OTROS despachos) ≥ cantidad del despacho`.
- Al crear, por defecto se proponen todas las líneas pendientes con su
  cantidad pendiente; el equipo puede bajar cantidades o quitar líneas
  (despacho parcial).

**El pedido pasa solo a `entregado`** cuando todas sus líneas están cubiertas
por despachos `entregado` o por órdenes de compra `entregada_al_cliente`. Se
evalúa después de cada paso a `entregado` de un despacho y de cada paso a
`entregada_al_cliente` de una compra, con la misma transición condicional que
hoy (`pagado → entregado`). El botón manual se mantiene.

### Parte 3 — Couriers

Registro de couriers en `apps/backoffice/src/lib/couriers.ts`. Vive en el
backoffice y no en un paquete compartido porque hoy es su único consumidor y
el backoffice no depende de ningún paquete `@rr/*` (se despliega solo); se
mueve a `packages/logistica` cuando aparezca un segundo consumidor (etapa 3):

```ts
export type CourierId = 'bluexpress' | 'starken' | 'chilexpress' | 'otro';

export interface Courier {
  id: CourierId;
  nombre: string;
  /** Página pública de seguimiento; `conNumero` dice si ya lleva el número. null si no hay. */
  urlSeguimiento(numero: string): { url: string; conNumero: boolean } | null;
  // Capacidades opcionales, para cuando haya integración (etapa 3):
  cotizar?(destino: { comuna: string }, bultos: Bulto[]): Promise<Tarifa[]>;
  crearEnvio?(despacho: DespachoParaCourier): Promise<{ numeroSeguimiento: string; etiquetaPdfUrl: string }>;
  consultarEstado?(numeroSeguimiento: string): Promise<EstadoCourier>;
}
```

En la etapa 1 cada courier implementa solo `urlSeguimiento`. Verificado el
2026-09-25: Starken acepta el número en la URL
(`https://www.starken.cl/seguimiento?codigo=<n>`); Blue Express
(`https://www.blue.cl/seguimiento/`) y Chilexpress
(`https://www.chilexpress.cl/estado-envio-paquete-courier`) no exponen un link
con el número, así que se da su página y el mensaje pide ingresar el número.
`otro` devuelve `null` y se muestra solo el número.

### Parte 4 — Backoffice

- **Vista "Compras"** (`/compras`): órdenes de compra agrupadas por estado,
  con lo pendiente arriba (por comprar, por retirar, en camino, atrasadas).
  Cada tarjeta permite registrar la compra (modalidad, número, fecha estimada,
  guía, nota), avanzar de estado y registrar recepciones por línea.
- **Vista "Despachos"** (`/despachos`): pedidos pagados con líneas sin asignar
  a un despacho; despachos por estado; retiros pendientes en oficina; envíos
  con cobro pendiente.
- **Por pedido, dentro de "Despachos"** (el backoffice no tiene página de
  detalle de pedido; esta vista agrupa por pedido y cumple ese rol): sus
  líneas con cantidades compradas, recibidas y asignadas, sus despachos, y el
  botón "Crear despacho" con las líneas pendientes
  precargadas y la dirección de facturación del cliente como punto de partida.
- **"Copiar mensaje"** en cada despacho: texto listo para pegar en WhatsApp,
  según el estado (listo para retiro / en camino con link de seguimiento /
  entregado). Usa el portapapeles del navegador.
- **Rutas API** nuevas, todas detrás de la sesión existente:
  `api/compras/registrar`, `api/compras/transicion`, `api/compras/recepcion`,
  `api/despachos` (crear), `api/despachos/editar`, `api/despachos/transicion`.
- Se agrega un helper `supabasePost` junto a `supabaseGet`/`supabasePatch`.

## Errores y concurrencia

- Toda transición es un PATCH condicional sobre el estado actual (mismo
  patrón que `pedidos/transicion`): si otro usuario ya lo movió, responde 409 y
  la vista se refresca. Repetir la misma transición no hace nada.
- Las reglas de cantidades se validan en el servidor al crear un despacho y al
  pasarlo a `listo`, releyendo recepciones y despachos en ese momento. La
  ventana entre la lectura y la escritura se acepta: el equipo es chico y el
  peor caso (dos personas armando el mismo despacho a la vez) se ve de
  inmediato en la vista.
- Una falla de Supabase en una vista muestra "No se pudo cargar" con
  reintentar, como hoy. Una falla al escribir no deja nada a medias: el
  despacho, sus líneas y su primer evento se crean juntos, en una función SQL
  (`crear_despacho`) llamada por RPC; si falla, no queda despacho.
- La transición automática del pedido a `entregado` es de mejor esfuerzo: si
  falla, se registra en el log y el botón manual sigue disponible.

## Pruebas

- Lógica pura en `apps/backoffice/src/lib/` (máquinas de estado de compra y
  de despacho, cálculo de cantidades, regla de `listo`, regla de pedido
  entregado, texto de "Copiar mensaje"): tests unitarios con casos de pedido
  con dos mayoristas, recepción parcial, despacho parcial, línea directa al
  cliente, despacho anulado que libera líneas y reprogramación tras `fallido`.
- `@rr/logistica`: el link de seguimiento de cada courier, y `null` para
  `otro` o un número vacío.
- Rutas API: 401 sin sesión, 400 por datos inválidos, 409 por transición
  concurrente, y la escritura esperada en Supabase (con `fetch` simulado,
  como los tests actuales del backoffice).
- Verificación real: aplicar el SQL, armar en el backoffice un pedido de
  prueba con recepción parcial, despacho parcial y el resto, y comprobar que
  el pedido pasa solo a `entregado`.

## Etapas

1. **Esta spec, implementada:** compras, recepciones, despachos, courier
   manual con link de seguimiento, costos y cobro del envío registrados,
   paso automático del pedido a `entregado`, "Copiar mensaje".
2. **Avisos automáticos por WhatsApp:** WhatsApp solo permite mensajes libres
   dentro de las 24 horas desde el último mensaje del cliente; los avisos de
   despacho necesitan plantillas aprobadas por Meta, configuradas en Kapso.
3. **Integración Blue Express** cuando haya cuenta corriente: `crearEnvio`
   (etiqueta PDF) y `consultarEstado`, con un barrido periódico que mueva
   `en_ruta → entregado` solo.
4. **Cobro del envío con link de Mercado Pago**, reutilizando el relé de
   pagos.

## Fuera de alcance

- Cambios en la tienda o en el bot (checkout, prompts).
- Enviar las órdenes de compra al mayorista por API o correo.
- Inventario o bodega (ubicaciones, stock propio).
- Usuarios y permisos por persona en el backoffice (sigue la contraseña
  compartida; `responsable` es texto libre).
