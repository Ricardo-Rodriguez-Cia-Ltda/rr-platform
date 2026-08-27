# Diseño: envío de correo propio — fase 1

**Fecha:** 2026-08-27
**Estado:** Aprobado
**Depende de:** PR #13 (refactor a monorepo). Este trabajo se apoya en `apps/` y `packages/`, así que se rama desde `refactor/monorepo` y se integra después.

## Problema

La emisión de órdenes de compra manda correo con Resend, y su plan de pago no se quiere. Hoy la function `emitir-ordenes-compra` está desplegada **sin** `RESEND_API_KEY` ni `RESEND_FROM_EMAIL`, así que responde 500: ninguna orden llega a nadie. El workflow `rr-isia-version2` ya está activo sobre WhatsApp, y el mensaje de cierre al cliente no depende de que el correo haya salido — o sea que una venta aceptada hoy se pierde en silencio.

Esta fase reemplaza el transporte de correo por infraestructura propia y destraba eso.

## Alcance

**Incluido:**

- `packages/mailer`: la interfaz de envío y una implementación sobre el SMTP de Gmail.
- `apps/mailer`: una app desplegable en Vercel que expone `POST /api/send`, autenticado y con lista blanca de destinatarios.
- Cambiar `apps/kapso-agent/functions/emitir-ordenes-compra.js` para que llame a ese endpoint en vez de a Resend.
- Los secretos correspondientes en Kapso y en Vercel.

**Fuera de alcance:**

- **Fase 2** — cotizaciones y facturas al cliente. Necesita un remitente en dominio propio, y el mini front para ver lo enviado nace ahí, cuando haya algo que auditar.
- **Fase 3** — órdenes directo a la casilla de compras de cada mayorista. No es un problema técnico: hay que acordar casillas y formato con cada uno, y aceptar que un error cuesta dinero fuera de la empresa.
- Adjuntos, plantillas, reintentos con cola, y cualquier cosa que no sea "mandar un correo de texto y HTML a una dirección conocida".

## Decisiones tomadas

### El relé, no llamar a Gmail desde el Worker

Las functions de Kapso son Cloudflare Workers y **no pueden hablar SMTP**: solo HTTPS. Así que el envío tiene que ocurrir en un proceso Node nuestro, y el Worker llamarlo por HTTPS.

Se descartó que el Worker llamara directo a la API de Gmail: obliga a OAuth igual, deja la credencial encerrada en Kapso, y cuando en la fase 2 nuestra propia API mande cotizaciones necesitaría una segunda copia de todo. El relé sirve a los dos.

### SMTP de Gmail con contraseña de aplicación, no la API de Gmail

La API de Gmail por HTTPS eliminaría cualquier duda sobre conexiones salientes, pero exige proyecto en Google Cloud, pantalla de consentimiento y un refresh token — que **caduca a los 7 días mientras la app OAuth esté en modo Testing**. Es más ceremonia y una trampa operativa, para el mismo resultado.

Una contraseña de aplicación son cinco minutos. El costo es un supuesto por verificar: que una función de Vercel pueda abrir SMTP hacia `smtp.gmail.com`. La documentación de límites de Vercel no lista puertos de salida bloqueados y declara cobertura completa de Node, con sockets TCP contados entre los descriptores de archivo — buena señal, no prueba.

**Por eso lo primero que se implementa es esa prueba**, con un despliegue real y un correo de verdad, antes de escribir el resto. Si falla, se cambia la implementación del paquete a la API de Gmail sin tocar a quien la llama; para eso está la interfaz.

### La lista blanca de destinatarios no es opcional

Un endpoint de envío protegido solo por una clave es, si esa clave se filtra, un relé de spam a nombre de la cuenta de Gmail — y Google suspende la cuenta. El endpoint rechaza cualquier destinatario que no esté en una lista explícita. Para esta fase la lista tiene una sola dirección: la casilla interna.

Cuando llegue la fase 2 habrá que mandar a clientes, o sea a direcciones arbitrarias. Ese es el momento de reemplazar la lista blanca por otro control, no antes.

### `packages/mailer` aunque hoy tenga un solo consumidor

Contradice la regla del monorepo —"no se extrae un paquete con un solo consumidor"— y es deliberado: el segundo consumidor está en la fase 2, que es la razón de existir de la fase 1. Extraerlo ahora cuesta un archivo; extraerlo después cuesta reescribir el llamador.

Si la fase 2 se cancelara, este paquete debería fundirse dentro de `apps/mailer`.

## Arquitectura

```
emitir-ordenes-compra (Cloudflare Worker, Kapso)
   │  POST /api/send  ·  header x-api-key
   ▼
apps/mailer (Vercel, Node)
   │  usa @rr/mailer
   ▼
packages/mailer  ──SMTP──►  smtp.gmail.com  ──►  casilla interna
```

### `packages/mailer`

```ts
export interface Message {
  to: string;
  subject: string;
  html: string;
  text: string;
}

export interface SendResult {
  id: string;   // el messageId que devuelve el transporte
}

export interface Mailer {
  send(message: Message): Promise<SendResult>;
}
```

Una implementación, `createGmailMailer({ user, appPassword, from })`, que devuelve un `Mailer` sobre nodemailer. El paquete no sabe nada de HTTP, de claves de API ni de listas blancas: recibe un mensaje y lo manda. Todo lo demás es de la app.

### `apps/mailer`

Un endpoint, `POST /api/send`.

**Entrada** — header `x-api-key`, cuerpo JSON:

```json
{ "to": "...", "subject": "...", "html": "...", "text": "..." }
```

**Respuestas:**

| Código | Cuerpo | Cuándo |
|---|---|---|
| 200 | `{ "ok": true, "id": "<messageId>" }` | Enviado |
| 400 | `{ "ok": false, "error": "cuerpo_invalido" }` | Falta un campo o no es string |
| 401 | `{ "ok": false, "error": "no_autorizado" }` | `x-api-key` ausente o distinta |
| 403 | `{ "ok": false, "error": "destinatario_no_permitido" }` | `to` fuera de la lista blanca |
| 500 | `{ "ok": false, "error": "falta_configuracion", "faltan": ["..."] }` | Falta una variable de entorno; se nombran, nunca sus valores |
| 502 | `{ "ok": false, "error": "<mensaje del transporte>" }` | El SMTP falló |

Nunca devuelve el detalle de la credencial ni el error crudo del transporte si contiene la contraseña.

**Variables de entorno de la app:**

| Variable | Qué es |
|---|---|
| `MAILER_API_KEY` | La clave que exige en `x-api-key` |
| `GMAIL_USER` | La cuenta que envía |
| `GMAIL_APP_PASSWORD` | Contraseña de aplicación de esa cuenta |
| `MAILER_FROM` | El `From` del mensaje |
| `MAILER_ALLOWED_RECIPIENTS` | Direcciones permitidas, separadas por coma |

Si falta cualquiera, el endpoint responde 500 nombrando las que faltan, nunca sus valores.

**En Vercel es un proyecto aparte**, con Root Directory `apps/mailer` y el interruptor de incluir archivos fuera del root activado, igual que `apps/pricing-api` — porque importa `@rr/mailer`, que vive fuera de su directorio.

### El cambio en el Worker

En `emitir-ordenes-compra.js` cambia **solo** el bloque que hoy hace `fetch("https://api.resend.com/emails", …)`. Pasa a hacer `POST` contra `MAILER_URL` con el header `x-api-key: MAILER_API_KEY` y el mismo `subject`, `html` y `text` que ya construye.

Todo lo demás queda intacto: la agrupación por mayorista, la reserva idempotente en D1, la reconstrucción del costo dividiendo por el margen, el manejo de fallo parcial y el guard de vigencia. Los secretos `RESEND_API_KEY` y `RESEND_FROM_EMAIL` dejan de usarse; entran `MAILER_URL` y `MAILER_API_KEY`.

La idempotencia sigue viviendo donde está. El relé no la necesita: quien decide si una orden se manda es el Worker, contra su fila en D1.

## Manejo de errores

| Situación | Comportamiento |
|---|---|
| El relé responde 4xx o 5xx | El Worker lo trata igual que trataba un fallo de Resend: la fila queda `failed`, las demás órdenes se envían igual, y el resultado lo dice |
| El relé no responde (red, app caída) | El `try/catch` que ya existe alrededor del `fetch` lo cubre; misma ruta que el anterior |
| Gmail rechaza el envío | 502 con el mensaje del transporte, sin credenciales |
| Se supera el límite diario de Gmail | Gmail devuelve error de cuota; se propaga como 502 y queda en la fila `failed`, reintentable |

## Testing

Vitest, como el resto del repositorio.

- **`packages/mailer`**: con un transporte falso — construye el mensaje con `from`, `to`, `subject`, `html` y `text` correctos, y propaga el `messageId`.
- **`apps/mailer`**: sin clave responde 401; con clave incorrecta, 401; con destinatario fuera de la lista, 403 **y sin llamar al transporte** (esa es la que importa: prueba que la lista blanca corta antes de enviar, no después); cuerpo incompleto, 400; caso feliz, 200 con el id; fallo del transporte, 502 sin filtrar la contraseña.
- **El Worker**: la prueba existente de `emitir-ordenes-compra` cambia de destino de `fetch`; se mantienen todos sus casos —agrupación, idempotencia, fallo parcial, reintento— porque ninguno depende de quién sea el transporte.

### Criterio de aceptación

**Llega un correo genérico a la dirección interna, enviado por el endpoint desplegado en Vercel.** Ese es el mínimo pedido y es lo que cierra la fase.

Después, la verificación real: invocar `emitir-ordenes-compra` con una cotización de dos mayoristas y recibir **dos** correos, y comprobar que una segunda invocación no manda ninguno.

## Riesgos conocidos

- **Que Vercel no permita SMTP saliente.** Es el supuesto del que cuelga todo, y por eso se prueba primero, con un despliegue real. Salida: cambiar la implementación a la API de Gmail detrás de la misma interfaz.
- **500 correos al día** en Gmail gratis. Sobra para órdenes internas; es una restricción a revisar en la fase 2, cuando se sume correo a clientes.
- **El remitente es `@gmail.com`.** Aceptable para la casilla propia. Para facturas a clientes y órdenes a mayoristas se ve mal y aumenta el riesgo de filtros corporativos. La empresa ya tiene dominio (`pyxis-latam.cl`); migrar el remitente es trabajo de DNS, no de código, y es la primera tarea de la fase 2.
- **nodemailer es la primera dependencia de producción del repositorio.** Hoy `package.json` solo tiene `devDependencies`. No es un problema, sí un cambio de categoría que conviene notar.
- **Una app más que desplegar y vigilar.** Si `apps/mailer` está caída, no salen órdenes — igual que hoy no salen si falta la clave. La diferencia es que ahora el fallo es visible en los logs de Vercel.
