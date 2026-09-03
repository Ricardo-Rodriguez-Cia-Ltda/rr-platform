# Diseño: Tienda web Dr. Computación (e-commerce dropshipping)

**Fecha:** 2026-09-03
**Estado:** Aprobado
**Depende de:** la pricing-api (búsqueda + cache de precios), las functions de
Kapso `generar-cotizacion-v2` y `emitir-ordenes-compra`, la persistencia en
Supabase, los PDF del relé y el backoffice — todo ya en producción.

## Problema

Hoy la única forma de comprarle a la empresa por canales digitales es el bot
de WhatsApp (Rayo Pérez). El dueño quiere un segundo canal: una tienda web
donde los clientes busquen el catálogo con precios reales y **compren**, con
el mismo modelo dropshipping (la venta emite órdenes de compra a los
mayoristas; no hay bodega propia). Aún no existe medio de pago online — el
dueño está gestionando la cuenta bancaria — así que la compra web termina en
"pedido recibido, te contactamos para coordinar pago y entrega".

## Decisiones tomadas

### App nueva `apps/tienda`, marca nueva "Dr. Computación"

Next.js App Router (mismo patrón que `apps/backoffice`), cuarto proyecto
Vercel. Marca **nueva e independiente** — elegida por el dueño — sin heredar
el azul corporativo (ese queda en documentos y backoffice). El Rayo Pérez
aparece dentro de la tienda como asistente: botón "¿Dudas? Háblale al Rayo"
con link `wa.me` al número del bot.

Se descartó Shopify/plataformas (el catálogo son miles de SKUs con precios
vivos de 3 mayoristas — sincronizarlos pelea contra el modelo de frescura ya
construido, y el pipeline de OC habría que customizarlo igual) y un motor de
pedidos propio en la tienda (duplicaría lógica delicada ya probada:
idempotencia, numeración, costos).

### La tienda no tiene catálogo propio: consume la pricing-api

Cada búsqueda va server-side a la pricing-api existente
(`https://api.pyxis-latam.cl/rr/captador-precios`, con `PRICING_API_KEY` —
el navegador jamás ve la key ni la URL del túnel). La API ya trae sonda +
ronda paralela + cache de precios (fresco ≤15 min / usable ≤24 h) y facets de
categorías/marcas. La tienda no agrega endpoints a la API salvo que el plan
detecte un faltante concreto (el diseño no exige ninguno).

### Precios finales con IVA incluido

La API entrega precio de venta **neto**; la tienda muestra
`round(neto × (1 + IVA_RATE))` con leyenda "IVA incluido" (convención retail
chilena). `IVA_RATE = 0.19` como constante de la tienda, el mismo valor que
usa la cotización. El desglose neto/IVA/total exacto lo pone la cotización
formal al confirmar.

### El puente al motor del bot (la decisión central)

Al confirmar el pedido, el servidor de la tienda **invoca las mismas
functions de Kapso** vía la Platform API (`KAPSO_API_KEY` server-side),
con un execution context sintético:

1. **`generar-cotizacion-v2`** con los productos del carro (misma forma de
   vars que escribe el agente de descubrimiento del workflow — el plan
   verifica el contrato exacto leyendo la function) y el teléfono del
   cliente en `context.phone_number`. Recotiza en vivo, persiste la
   cotización con número correlativo; sin conversación WhatsApp activa el
   PDF queda `sin_destinatario` (comportamiento ya existente, sin efectos).
2. **`emitir-ordenes-compra`** con `quote_confirmed=true` y los datos de
   facturación (los que haya): OCs por mayorista con PDF al correo interno,
   idempotencia D1, fila en `pedidos` → aparece en el backoffice como
   `nuevo`, enlazada a la ficha del cliente por teléfono.

Los IDs de las functions se resuelven por nombre contra `GET /functions` de
la Platform API y se cachean en memoria del proceso.

**Recotización visible:** el POST de confirmación corre primero
`generar-cotizacion-v2`; si el total difiere del total indicativo del carro,
la UI muestra la diferencia y pide confirmar de nuevo (la cotización ya
generada se reusa — es la misma que se confirma). Solo entonces se invoca
`emitir-ordenes-compra`.

### Checkout liviano con memoria

- **Obligatorios (3):** nombre, teléfono (WhatsApp, normalizado a dígitos) y
  email.
- **Opcional desplegable:** los 7 datos de facturación (RUT, razón social,
  giro, dirección, comuna, ciudad, email de factura) para quien quiera dejar
  todo listo. Si van completos, `emitir` los guarda en `clientes` como
  siempre; si no, el comercial (o el Rayo por WhatsApp) los completa después.
- **Memoria:** carro y datos del comprador en `localStorage` — la segunda
  compra no pregunta nada. Sin cuentas de usuario.

### Carrito y topes

Carro client-side (`localStorage`): items `{proveedor, sku, mpn, nombre,
marca, cantidad, precioIndicativoClp}`. Topes anti-abuso: máx 10 líneas, máx
20 unidades por línea. Los precios del carro son indicativos; la verdad la
pone la recotización al confirmar.

## Páginas

| Ruta | Contenido |
|---|---|
| `/` | Buscador protagonista + categorías (facets) + presentación de la marca |
| `/buscar` | Resultados con filtros categoría/marca/precio máx; tarjetas tipográficas (marca destacada, nombre, precio IVA incl., disponibilidad); paginado |
| `/producto/[proveedor]/[sku]` | Detalle (endpoint product existente): nombre, marca, MPN, categoría, disponibilidad, precio; "Agregar al carro" |
| `/carro` | Carrito + checkout en una página: líneas editables, 3 campos + facturación desplegable, honeypot, botón confirmar |
| `/pedido/[quote_id]` | Confirmación (capability URL por UUID): N° de cotización, resumen, link al PDF del relé, "te contactamos por WhatsApp" |

Sin fotos en v1 (el catálogo no trae imágenes): diseño tipográfico con ícono
por categoría. El spike de Icecat (fotos por MPN+marca) es un proyecto aparte,
posterior.

## Identidad visual (dirección; los tokens finos se afinan al implementar)

- **Concepto:** la consulta del doctor de los computadores — experticia que
  diagnostica y recomienda, cálida, no infantil.
- **Color:** verde clínico profundo como base sobre papel cálido; ámbar para
  los CTA de compra. Nada del azul corporativo.
- **Tipografía:** serif con carácter para la marca y títulos (aire de rótulo
  de consulta, moderno); sans limpia para texto y datos. Vía `next/font`.
- **Logo:** tipográfico "Dr. C" — sin cruces médicas literales ni emojis.
- **Rayo Pérez** presente como asistente (botón WhatsApp discreto).
- Responsive de verdad (compra desde el teléfono) y modo claro único en v1
  (una tienda define su atmósfera; el modo oscuro no es requisito).

## Manejo de errores

| Situación | Comportamiento |
|---|---|
| pricing-api caída | Búsqueda/producto: "no pudimos cargar el catálogo" + reintentar; nunca página rota |
| Producto sin precio/stock al recotizar | La confirmación lo dice línea por línea (contrato `parcial`/incompleta de la API ya existente) |
| Total recotizado ≠ total del carro | Se muestra la diferencia y se pide confirmar de nuevo; nada se emite hasta ese segundo sí |
| `generar-cotizacion-v2` falla | "No pudimos procesar tu pedido, intenta de nuevo" — nada quedó a medias |
| Cotización ok pero `emitir` falla | Confirmación sale igual ("pedido recibido, te contactamos"); la OC fallida queda visible en el backoffice — mismo contrato honesto del bot |
| Doble submit | La idempotencia de `emitir` (D1 por `quote_id:version:proveedor`) lo absorbe |
| Abuso | Honeypot invisible + límite de tasa por IP en memoria del servidor (best-effort en serverless, aceptado) + topes de carro; un pedido basura se anula desde el backoffice |
| `/carro` y `/pedido/*` | `noindex`; el resto indexable con metadata básica |

## Testing

Estilo del repo (vitest, `fetch` stubbeado):

- **Lógica pura (el grueso):** precio con IVA y formateo CLP; validación del
  checkout (3 obligatorios, teléfono a dígitos, topes de carro, honeypot);
  armado del payload sintético para las functions de Kapso; view-models de
  búsqueda, producto y confirmación; detección de diferencia de total.
- **Handlers:** el POST de confirmación con Kapso mockeado (flujo feliz,
  precio cambiado, generar caído, emitir caído); rate limit.
- **Build** valida las páginas. Sin tests de navegador.

## Verificación de punta a punta

1. Buscar un producto real, agregarlo al carro, confirmar con datos de
   prueba → página de confirmación con N° y PDF descargable.
2. El pedido aparece en el backoffice como `nuevo` y las OC llegan al correo
   interno con sus PDF.
3. Repetir la compra desde el mismo navegador: los datos vienen precargados.
4. Compra con precio cambiado simulado → la UI pide reconfirmar.

## Fuera de alcance (v1)

- Pagos online (se enchufan en este mismo checkout cuando exista la cuenta).
- Fotos de producto (spike Icecat aparte).
- Cuentas de usuario, historial de pedidos del comprador.
- Cálculo de despacho/envío.
- Emails de confirmación al cliente (el contacto es por WhatsApp/teléfono).
- Sincronización de catálogo (no existe tal cosa: la API es la fuente viva).
- Modo oscuro.

## Riesgos conocidos

- **Formulario público que dispara correos internos**: mitigado con
  honeypot, rate limit best-effort y topes; residual aceptado porque nada se
  factura automáticamente y el backoffice permite anular.
- **Dependencia del túnel**: si la oficina se cae, la tienda no puede buscar
  (el cache amortigua repeticiones, no la primera búsqueda). Mismo riesgo
  que ya corre el bot; el semáforo del backoffice lo delata.
- **El contrato de invocación sintética de Kapso** es interno nuestro: si el
  workflow cambia las vars que escribe el descubrimiento, la tienda debe
  acompañar el cambio (las pruebas del payload lo hacen visible).
- **Marca nueva sin dominio aún**: se lanza en `*.vercel.app`; el dominio
  definitivo (cuando exista) es un alias en Vercel, sin tocar código.
