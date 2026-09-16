# Diseño: la tienda cobra con Mercado Pago

**Fecha:** 2026-09-16
**Antecedente:** `docs/superpowers/specs/2026-09-10-pagos-mercado-pago-design.md`
(el cobro del bot, ya desplegado y verificado de punta a punta el 2026-09-15
con credenciales de prueba).

## Problema

La tienda web (`apps/tienda`) confirma el carro y **emite de inmediato** las
órdenes de compra a los mayoristas, sin recibir un peso. Un pedido de un
desconocido dispara compras reales en Intcomex. La página de pedido recibido
dice "te escribimos por WhatsApp para coordinar el pago (contado)", que es
trabajo manual y un cobro que puede no ocurrir nunca.

El servicio de pagos del relé (`apps/mailer`, rutas `api/pago/*`) ya resuelve
el cobro para el bot: crea la preferencia, persiste la fila en `pagos`, recibe
el webhook, emite al aprobarse y alerta al interno cuando algo queda a medias.
El spec anterior lo dejó previsto: "la tienda web sigue emitiendo sin cobrar;
enchufarla es reusar `POST /api/pago/crear` tal cual, en una fase aparte".
Esta es esa fase.

## Decisiones tomadas

### Cobrar primero, emitir después — también en la tienda

`/api/confirmar` deja de invocar `emitir-ordenes-compra`. Recotiza en vivo y
compara el total como hoy, y en vez de emitir le pide al relé un link de pago.
La emisión pasa a ocurrir en el webhook cuando Mercado Pago aprueba, por el
mismo camino que el bot, sin una línea nueva en el webhook.

Consecuencia que simplifica: reintentar `/api/confirmar` ya es seguro. Hoy un
503 después de emitir obliga a frenar al cliente ("no lo reintentes: pudo
haber quedado registrado"), porque cada POST crea una cotización nueva y la
idempotencia de la emisión no cubre ese caso. Con el cobro en medio nada se
emite hasta que hay plata, así que ese mensaje y la bandera `noReintentar`
desaparecen. Una cotización huérfana con su fila `pendiente` en `pagos` es
inocua: vence sola, igual que las del bot que nadie paga.

### El cliente va directo a Mercado Pago

Al confirmar, la tienda guarda el detalle en `sessionStorage` (como hoy),
vacía el carro y redirige el navegador al `init_point`. No hay página
intermedia con botón "Pagar": menos pasos, menos abandono. El botón existe
igual, pero en la página del pedido, para quien cierra el checkout y vuelve.

### El relé distingue el origen, no el llamador

`POST /api/pago/crear` gana un campo opcional `origen`, con valores `bot`
(default, comportamiento de hoy) y `tienda`. Con `tienda`:

- Las `back_urls` de la preferencia apuntan a
  `${TIENDA_BASE_URL}/pedido/{quote_id}` en vez de a `/api/pago/retorno`.
  `TIENDA_BASE_URL` es una variable de entorno nueva del relé, exigida solo
  cuando llega ese origen. No se acepta una URL de retorno arbitraria en el
  cuerpo: aunque el endpoint está detrás de `x-api-key`, una URL dictada por
  el llamador es superficie que no hace falta abrir.
- `datos.origen = 'tienda'` queda en la fila, para que el backoffice o una
  alerta puedan decir de dónde vino el pago sin adivinar.
- No se manda ningún WhatsApp. Eso ya es así por construcción: sin
  `phone_number_id` el envío en `kapso.ts` no intenta la llamada. Se deja
  explícito en el spec para que nadie lo "arregle".

El webhook no distingue orígenes. Los avisos al cliente por WhatsApp caen en
el mismo no-op; las alertas internas, la emisión, `marcarPedidosPagados` y la
idempotencia son idénticas.

### El estado del pago se lee del relé, público por URL de capacidad

Nuevo `GET /api/pago/estado/{quote_id}` en el relé. Misma política que
`GET /api/cotizacion/{id}` (el PDF): el `quote_id` es un UUID v4 y conocerlo
es la credencial. Valida la forma del id y responde 404 ante cualquier otra
cosa o ante una fila inexistente. `Cache-Control: no-store`.

Respuesta:

```json
{
  "estado": "pendiente | aprobado | emitido | aprobado_sin_emitir",
  "monto_clp": 1058793,
  "intentos_rechazados": 0,
  "expira_at": "2026-09-15T18:40:13.392Z",
  "init_point": "https://www.mercadopago.cl/checkout/v1/redirect?pref_id=..."
}
```

`init_point` viaja **solo** mientras `estado = 'pendiente'` y `expira_at` no
pasó; en cualquier otro caso se omite. No viajan teléfono, `datos`,
`preference_id` ni `mp_payment_id`.

Se descartó que la tienda lea `pagos` directo de Supabase: mete la
`service_role` en un tercer proyecto de Vercel y duplica el acceso a datos que
hoy vive en un solo lugar (`apps/mailer/src/pago/datos.ts`).

### La página del pedido cuenta la verdad del estado

`/pedido/[id]` consulta el estado al relé al cargar y cada 3 s mientras el
estado sea `pendiente` o `aprobado`, durante 2 minutos; después deja un botón
"Actualizar". Los textos, gobernados por la misma regla del bot (ninguno
afirma algo que el estado no haya verificado):

| Situación | Texto | Acción |
|---|---|---|
| `pendiente`, vigente, sin rechazos | Falta pagar. | Botón "Pagar" al `init_point` |
| `pendiente`, vigente, `intentos_rechazados > 0` | El pago fue rechazado. Puedes reintentar. | Botón "Pagar" |
| `pendiente`, vencida | El link de pago venció. Vuelve a armar el pedido. | Enlace a la tienda |
| `aprobado` | Recibimos tu pago. Estamos cursando el pedido… | Sigue consultando |
| `emitido` | Pago recibido ✅ Tu pedido quedó cursado. | PDF de la cotización |
| `aprobado_sin_emitir` | Recibimos tu pago. Estamos terminando de confirmar el pedido y te contactamos. | PDF de la cotización |
| 404 | No encontramos ese pedido. | Enlace a la tienda |

La traducción de estado a texto es una función pura (`describirPago`) en
`apps/tienda/src/lib/pago.ts`, con pruebas; el componente solo la dibuja.

El PDF de la cotización sigue descargable en todos los estados con fila. La
leyenda "guarda el PDF: es el comprobante de tu pedido" pasa a mostrarse solo
en `emitido` y `aprobado_sin_emitir`, porque antes de pagar no hay pedido.

## Flujo

```
Checkout --POST /api/confirmar--> tienda (server)
                                   |- generar-cotizacion-v2 (Kapso)   [como hoy]
                                   |- compara total                    [como hoy]
                                   '- POST rele /api/pago/crear {origen:'tienda', quote_confirmed:true, ...}
                                        |- lee cotizacion, vigencia
                                        |- crea preferencia (back_urls -> tienda)
                                        '- inserta fila `pagos` (datos.origen='tienda')
         <-- {ok, quoteId, initPoint, totalClp, avisoAbastecimiento?}
navegador --> init_point (Mercado Pago)
Mercado Pago --POST--> rele /api/pago/webhook   [sin cambios: reclama, emite, marca pagado]
Mercado Pago --redirect--> tienda /pedido/{quote_id}
/pedido --GET rele /api/pago/estado/{quote_id}--> texto segun tabla
```

## Cambios por archivo

### `apps/mailer`

- `src/pago/crear.ts`: lee `origen`; con `tienda` exige `TIENDA_BASE_URL`,
  construye la preferencia con el retorno de la tienda y guarda
  `datos.origen`. El resto del handler no cambia.
- `src/pago/mercadopago.ts`: `construirPreferencia` recibe `retornoUrl` en
  vez de derivarla de `baseUrl` sola.
- `src/pago/estado.ts` (nuevo): `createEstadoHandler`, con la lógica de qué
  campos viajan. `api/pago/estado/[id].ts`: envoltorio fino, patrón de
  `api/cotizacion/[id].ts`, con `maxDuration = 300` como el resto de
  `api/pago/`.
- `src/pago/datos.ts`: `leerPago` ya devuelve lo necesario; sin cambios
  salvo que falte `expira_at` en la selección.
- `README.md`: `TIENDA_BASE_URL` y el endpoint nuevo.

### `apps/tienda`

- `src/lib/pedido.ts`: `armarPayloadEmision` se reemplaza por
  `armarCuerpoCrearPago(quote, comprador, facturacion)`, que produce el
  cuerpo plano que `crear` espera: `quote_id`, `quote_version`,
  `quote_confirmed: true`, `origen: 'tienda'`, `phone_number`,
  `customer_name`, `billing_email` (siempre, misma razón que hoy) y los otros
  seis `billing_*` solo con facturación completa.
- `src/lib/relay.ts` (nuevo): `crearPago(cuerpo)` contra
  `${MAILER_URL}/api/pago/crear` con `x-api-key: MAILER_API_KEY`, timeout
  15 s, registra solo etapa y tipo de fallo.
- `app/api/confirmar/route.ts`: el paso 3 pasa a ser "crear pago". Mapa de
  respuestas del relé: 200 → `{ok, quoteId, totalClp, initPoint, ...}`;
  409 `sin_vigencia` → 422 "los precios cambiaron, vuelve a confirmar";
  cualquier otro → 503 "no pudimos generar el link de pago, intenta de
  nuevo" (sin `noReintentar`). `maxDuration` sube de 30 a 60: cotizar 30 s
  más crear 15 s no caben en serie en el peor caso.
- `app/carro/Checkout.tsx`: al recibir `ok`, redirige a `initPoint`. La nota
  bajo el botón deja de hablar de "pago (contado)".
- `src/lib/pago.ts` (nuevo): `describirPago(respuesta, ahora)` → `{titulo,
  texto, accion}`.
- `app/pedido/[id]/Resumen.tsx`: consulta el estado y dibuja
  `describirPago`. El `RELAY` hardcodeado pasa a `NEXT_PUBLIC_MAILER_URL`
  (la URL pública del relé ya viajaba al navegador para el PDF; la key no).
- `README.md`: variables nuevas y el flujo.

## Variables de entorno

| Proyecto | Variable | Valor |
|---|---|---|
| `rr-mailing` | `TIENDA_BASE_URL` | `https://<dominio de la tienda>` sin barra final |
| tienda | `MAILER_URL` | `https://rr-mailing.vercel.app` |
| tienda | `MAILER_API_KEY` | la misma del relé, Sensitive |
| tienda | `NEXT_PUBLIC_MAILER_URL` | `https://rr-mailing.vercel.app` |

Regla heredada: Vercel no aplica un cambio de variable a un despliegue ya
construido. Tras cargar `TIENDA_BASE_URL`, redesplegar el relé.

## Manejo de errores

- Cotizar falla o el total difiere: exactamente como hoy (503 / 409
  recotizado).
- El relé no responde, 5xx, 503 `falta_configuracion` o 401: 503 al
  navegador con "no pudimos generar el link de pago, intenta de nuevo". La
  cotización queda huérfana; es inocua.
- El relé responde 409 `sin_vigencia`: en la práctica no debería pasar
  (la cotización tiene segundos de vida), pero se traduce a 422 con el mismo
  texto de recotizar.
- El cliente cierra Mercado Pago sin pagar: vuelve por su cuenta o por el
  historial a `/pedido/{id}`, que le ofrece el botón mientras hay vigencia.
- Pago rechazado: el webhook suma el rechazo; la página lo muestra con el
  botón para reintentar el mismo link.
- Todo lo que pasa después de aprobado (emisión fallida, base caída, monto
  que no calza) ya alerta al interno desde el webhook. La página muestra
  `aprobado_sin_emitir` con el texto honesto.

## Testing

`apps/mailer/tests`:
- `pago-crear.test.ts`: con `origen: 'tienda'` la preferencia lleva
  `back_urls` a la tienda, `datos.origen` queda en la fila, no se invoca
  Kapso, y sin `TIENDA_BASE_URL` responde 503 `falta_configuracion` nombrando
  la variable. Con origen ausente todo sigue igual (las pruebas actuales
  no cambian).
- `pago-estado.test.ts` (nuevo): 404 con id mal formado y con fila
  inexistente; `init_point` presente solo en pendiente vigente; nunca
  viajan `telefono`, `datos`, `preference_id`, `mp_payment_id`; `no-store`.
- `pago-mercadopago.test.ts`: `construirPreferencia` con `retornoUrl`.

`apps/tienda/tests`:
- `pedido.test.ts`: `armarCuerpoCrearPago` (billing_email siempre, los seis
  solo completos, `quote_confirmed` booleano, `origen`).
- `confirmar.test.ts`: la ruta ya no invoca `emitir-ordenes-compra`; mapa de
  respuestas del relé; sin `noReintentar`.
- `pago.test.ts` (nuevo): `describirPago` sobre la tabla completa, con
  vencimiento calculado contra `ahora`.
- `relay.test.ts` (nuevo): headers, timeout y que la key no sale en logs.

Suite completa verde y `npm run typecheck` limpio.

## Verificación de punta a punta

Con credenciales de prueba, cuenta compradora y tarjeta del 2026-09-15:

1. Armar un carro en la tienda con el correo de la cuenta compradora de
   prueba, confirmar. Esperado: redirige a Mercado Pago; en Supabase hay
   fila `pendiente` con `datos.origen = 'tienda'`; en `pedidos` no hay nada.
2. Pagar con `APRO`. Esperado: vuelve a `/pedido/{id}` y en menos de 10 s
   dice "pedido cursado"; la fila queda `emitido`; el pedido aparece
   `pagado` en el backoffice; sale el correo de la orden de compra.
3. Repetir cerrando Mercado Pago sin pagar. Esperado: `/pedido/{id}` ofrece
   el botón; pagar desde ahí funciona.
4. Repetir con `OTHE`. Esperado: la página muestra el rechazo con el botón;
   pagar después con `APRO` cursa.
5. Confirmar que el bot sigue igual (una cotización por WhatsApp con link y
   mensajes).

## Fuera de alcance

- Correo de confirmación al cliente web. La página y el PDF bastan por ahora.
- Vista de `pagos` en el backoffice.
- Colapsar `invocarFunction` (tienda y relé) en un paquete: la tienda la
  sigue necesitando para cotizar, así que este cambio no la elimina; es un
  refactor aparte.
- Barrido periódico de filas atascadas en `aprobado`: tarea separada,
  pendiente del spec anterior, que conviene tener antes de desplegar esto.

## Riesgos conocidos

- Cada confirmación crea una preferencia en Mercado Pago desde un usuario
  anónimo. El rate limit por IP de `/api/confirmar` sigue siendo la única
  cota; es el mismo riesgo que hoy con las cotizaciones, ahora con una
  llamada externa más.
- `GET /api/pago/estado` es público por URL. Expone monto y estado de un
  pedido a quien conozca el UUID, igual que el PDF expone la cotización
  completa. Es la política ya aceptada.
