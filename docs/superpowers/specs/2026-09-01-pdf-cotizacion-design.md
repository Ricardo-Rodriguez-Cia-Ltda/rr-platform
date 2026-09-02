# Diseño: PDF de cotización por WhatsApp

**Fecha:** 2026-09-01
**Estado:** Aprobado
**Depende de:** la persistencia en Supabase (spec 2026-08-31) — el PDF se genera desde la tabla `cotizaciones`.

## Problema

La cotización llega al cliente como texto de chat. Para una venta B2B eso es
poco formal: la empresa siempre ha emitido cotizaciones con membrete, número
correlativo y tabla de valores (hay un ejemplo real en `idea pdf/cotización.png`),
y ese documento es lo que el cliente reenvía internamente para aprobar la
compra. El usuario pidió que el bot mande ese documento, **como PDF adjunto en
la misma conversación de WhatsApp**, al momento de cotizar.

## Decisiones tomadas

### Generación al vuelo desde Supabase, servida por el relé existente

`apps/mailer` (proyecto `rr-mailing` en Vercel) gana un endpoint
`GET /api/cotizacion/<quote_id>` que lee la fila de `cotizaciones` (y la de
`clientes` si el teléfono calza) y **renderiza el PDF en el momento** con
`pdf-lib` (JavaScript puro — sin Chromium, corre en una función de Vercel).
No se almacena ningún archivo: el mismo link regenera el mismo documento
mientras la cotización exista.

Se descartó generar en la function de Kapso (los Workers no son buen lugar
para render de PDF y el resultado necesita una URL pública igual) y crear una
app nueva (el relé ya está desplegado y este endpoint le calza al rol).

### El envío lo hace `generar-cotizacion-v2`, best-effort

Meta soporta mensajes de tipo `document` **por link**: WhatsApp descarga la URL
y muestra el PDF con su nombre de archivo. Tras guardar la cotización, la
function manda ese mensaje vía la API de la plataforma Kapso (el `to` y el
`phone_number_id` ya llegan en el execution context). Mismo contrato que toda
la persistencia: **si el envío del PDF falla, la cotización conversacional sale
igual**; el fallo se declara en la respuesta (`pdf: "enviado" | "fallo"`), no
se esconde ni se reintenta.

El endpoint exacto de la plataforma para mandar mensajes crudos es la única
incógnita técnica: se resuelve como **primer paso del plan** (spike), antes de
construir encima.

### Capability URL, no autenticación

Meta descarga el link sin credenciales, así que el endpoint es público y la
protección es que la URL sea inadivinable: el `quote_id` es un UUID v4 (122
bits aleatorios) — el modelo "cualquiera con el enlace" de Google Docs. El PDF
contiene únicamente lo que ese cliente ya vio en su chat. Endurecimiento futuro
(firma HMAC en la query) cabe sin rediseñar.

### Número correlativo en la base

La tabla `cotizaciones` gana una columna autonumerada:

```sql
alter table cotizaciones
  add column if not exists numero bigint generated always as identity (start with 1600001);
```

Arranca en 1.600.001 para quedar por sobre la numeración histórica en papel
(~1.53M en el ejemplo) sin chocar con ella; el valor de arranque es ajustable
antes de pegar el ALTER. La function no necesita conocer el número (se asigna
solo al insertar); el PDF lo lee de la fila.

### Separar el modelo del dibujo

El endpoint se parte en dos piezas con una costura clara:

- `buildCotizacionView(fila, cliente)` — función **pura**: fila de Supabase →
  modelo de vista (números formateados en CLP con puntos de miles, fecha en
  español de Chile, vigencia en hora de Santiago, líneas con MPN como código,
  bloque de cliente resuelto). Aquí vive toda la lógica y aquí se concentran
  las pruebas.
- `drawCotizacion(view)` — el dibujo con `pdf-lib`: posiciona el modelo en la
  página. Fino, con pruebas estructurales (es un PDF válido, tiene una página,
  pesa lo razonable).

## Alcance

**Incluido:**

- El endpoint `GET /api/cotizacion/<quote_id>` en `apps/mailer` (404 si no
  existe la cotización; `Content-Type: application/pdf`;
  `Content-Disposition` con nombre `cotizacion-<numero>.pdf`).
- `pdf-lib` como dependencia de `apps/mailer`.
- El ALTER de la columna `numero` (archivo en `docs/sql/`, lo pega el usuario).
- El envío del documento desde `generar-cotizacion-v2` (spike del endpoint de
  Kapso primero), con secretos nuevos: `KAPSO_API_KEY` y
  `COTIZACION_PDF_BASE` (= `https://rr-mailing.vercel.app/api/cotizacion`).
- Variables `SUPABASE_URL`/`SUPABASE_SERVICE_KEY` en el proyecto Vercel
  `rr-mailing` (paso del usuario, con instrucciones exactas).
- Pruebas de todo lo anterior.

**Fuera de alcance:**

- PDF por correo (reusaría este mismo endpoint cuando se quiera).
- PDF de órdenes de compra o facturas.
- Almacenar los PDF generados.
- Firma HMAC del link (anotada como endurecimiento futuro).

## El documento (fiel al mockup `idea pdf/cotización.png`)

| Zona | Contenido |
|---|---|
| Membrete | Logo + `RICARDO RODRIGUEZ & CIA. LTDA` / `DIVISION INFORMATICA` / `R.U.T.: 89.912.300-K` |
| Fecha | `Santiago, <día> de <Mes> de <Año>` (hora de Santiago) |
| Título | `COTIZACION N° <numero>` |
| Cliente | `Señores:` + razón social si hay cliente guardado para ese teléfono; si no, `Presente` a secas |
| Cuerpo | "De nuestra consideración: … nos es grato enviarles la siguiente cotización" |
| Tabla | Código (el **MPN** — el SKU interno no le dice nada al cliente) · Descripción · Cantidad · Valor unitario · Total, en CLP |
| Totales | Neto / IVA / **Total** (el mockup dice "+ I.V.A."; el nuestro muestra el IVA calculado, que ya viene en la fila) |
| Observaciones | Valores en pesos · vigencia real de la cotización (fecha y hora límite de `valida_hasta`) · consultas al fono +56-2-23641111 |
| Pie | Web, política de devoluciones, dirección José M. Infante #2629 Ñuñoa, Santiago — como el mockup |

**Logo:** si al ejecutar existe un archivo de logo en `idea pdf/` (PNG/JPG),
se incrusta; si no, un monograma "R" tipográfico en recuadro azul (como la
forma del mockup) y se reemplaza cuando el archivo aparezca. Nunca se
incrusta el mockup completo.

## Manejo de errores

| Situación | Comportamiento |
|---|---|
| Cotización inexistente | 404 con cuerpo JSON `{ error: "cotizacion_no_encontrada" }` |
| Supabase caído o pausado | 503; el link puede reintentarse — y el envío original desde la function habría fallado como `pdf: "fallo"` sin bloquear nada |
| Sin `numero` (rama defensiva) | El PDF sale con `N° S/N`; no revienta. En Postgres, `generated always as identity` rellena retroactivamente todas las filas existentes al correr el ALTER (`docs/sql/2026-09-01-numero-cotizacion.sql`), así que esta rama no es un caso esperado en producción — protege contra la columna faltante o una consulta que no la trajo, no contra filas "viejas" |
| Sin cliente guardado | Bloque `Presente` genérico |
| El envío a Kapso/Meta falla | `pdf: "fallo"` en la respuesta de la function; la conversación sigue |
| Vercel sin las env de Supabase | El endpoint responde 503 nombrando las variables que faltan (patrón del relé), nunca sus valores |

## Testing

- **`buildCotizacionView`** (el grueso): formateo CLP (`1221795` → `$1.221.795`),
  fecha y vigencia en zona `America/Santiago`, MPN como código con fallback a
  SKU si falta, cliente presente/ausente, `numero` presente/ausente, líneas
  múltiples.
- **El endpoint**: 200 con `%PDF` al inicio y `Content-Type`/`Content-Disposition`
  correctos; el PDF carga con `pdf-lib` y tiene ≥1 página; 404; 503 sin env.
  Supabase mockeado vía `fetch` stub, como en el resto del repo.
- **`generar-cotizacion-v2`**: el mensaje a Kapso lleva `type: "document"` con
  el link que contiene el `quote_id` y el filename correcto; fallo del envío →
  `pdf: "fallo"` y todo lo demás intacto; sin secretos nuevos → ni lo intenta
  y el campo no aparece.

## Verificación de punta a punta

1. Abrir `https://rr-mailing.vercel.app/api/cotizacion/<quote_id real>` en el
   navegador: descarga un PDF correcto con los datos de esa cotización.
2. Conversación real por WhatsApp: cotizar algo → llega el resumen del agente
   **y** el PDF como documento adjunto, con número correlativo.
3. Un `quote_id` inventado → 404.

## Riesgos conocidos

- **El link es público por diseño** (capability URL). Quien tenga la URL exacta
  ve esa cotización. Mitigado por los 122 bits del UUID y porque el contenido
  es lo que el cliente ya recibió por chat. La firma HMAC queda anotada.
- **El PDF sobrevive a la vigencia**: a las 3 horas la cotización expira pero
  el documento sigue descargable — correcto como registro; la vigencia impresa
  deja claro que ya venció.
- **Meta cachea los documentos por link** un tiempo; si una cotización se
  regenerara distinta (hoy no pasa — son inmutables), el cliente podría ver la
  versión cacheada.
- **Dependencia nueva de producción** (`pdf-lib`) en `apps/mailer` — la segunda
  del repo tras nodemailer.
- **Orden aceptado: el PDF llega antes que el texto.** El documento sale del
  lado de `generar-cotizacion-v2` (esta function), y el resumen en texto lo
  compone el agente después — el cliente ve primero el adjunto, luego la
  explicación. Es una decisión aceptada, no un defecto: el envío a Kapso
  agrega hasta 5 s de latencia a la respuesta cuando la plataforma está
  lenta (mismo timeout que el `fetch` del POST).
