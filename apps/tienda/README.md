# Dr. Computación (tienda web)

E-commerce dropshipping sobre el motor del bot: catálogo desde la
pricing-api (server-side), pedidos vía las functions de Kapso.
Spec: `docs/superpowers/specs/2026-09-03-tienda-dr-computacion-design.md`.

## Variables (proyecto Vercel dr-computacion)

| Variable | Qué es |
|---|---|
| `PRICING_API_URL` | `https://api.pyxis-latam.cl/rr/captador-precios` |
| `PRICING_API_KEY` | la API_SECRET_KEY de la pricing-api |
| `KAPSO_API_KEY` | la misma key de la Platform API que usan los scripts |
| `MARGEN` | `0.13` — DEBE calzar con el del bot |
| `TIPO_CAMBIO_CLP_USD` | `950` — DEBE calzar con el del bot |
| `IVA_RATE` | `0.19` |
| `NEXT_PUBLIC_RAYO_WA` | teléfono del bot para wa.me (solo dígitos) — **requerida**: sin ella el botón de WhatsApp no se muestra y el cliente queda sin ninguna vía de contacto (la entrega se coordina por WhatsApp) |
| `MAILER_URL` | `https://rr-mailing.vercel.app` — el relé, para pedirle el link de pago (server-side) |
| `MAILER_API_KEY` | la misma `MAILER_API_KEY` del proyecto `rr-mailing`, cargada como **Sensitive** |
| `NEXT_PUBLIC_MAILER_URL` | `https://rr-mailing.vercel.app` — la URL pública del relé que usa el navegador para el PDF y el estado del pago (sin key). Si falta, cae a ese mismo valor |

Todas son requeridas. El techo de ejecución se fija con `export const
maxDuration` en cada entrypoint: `60` en `/api/confirmar` (cotiza en Kapso, 30s,
y después le pide el link de pago al relé, 15s, en serie) y `30` en el resto
(la búsqueda espera hasta 21s a la pricing-api). Va como segment config de
Next, no en `vercel.json`: en App Router las functions las emite el framework,
y un glob que no calza ninguna hace fallar el build.

## Cómo cobra

Desde el 2026-09-16 la tienda cobra con Mercado Pago a través del servicio de
pagos del relé (`apps/mailer`, `api/pago/*`). Diseño en
`docs/superpowers/specs/2026-09-16-tienda-cobro-design.md`.

1. `/api/confirmar` recotiza en vivo (Kapso) y compara el total, como siempre.
2. En vez de emitir, llama a `POST <MAILER_URL>/api/pago/crear` con
   `origen: "tienda"`, la confirmación y los datos del comprador. El relé crea
   la preferencia, guarda la fila en `pagos` y devuelve el `init_point`.
3. El checkout redirige el navegador a Mercado Pago. Al terminar, Mercado
   Pago vuelve a `/pedido/{quote_id}` (lo decide `TIENDA_BASE_URL` en el relé).
4. La emisión de las órdenes de compra la hace el webhook del relé cuando el
   pago se acredita: el pedido aparece en el backoffice ya en `pagado`.
5. `/pedido/{quote_id}` consulta `GET <NEXT_PUBLIC_MAILER_URL>/api/pago/estado/{quote_id}`
   cada 3 s mientras el desenlace puede cambiar, y muestra el estado con los
   textos de `src/lib/pago.ts`. Ninguno afirma algo que el estado no haya
   verificado.

Una confirmación abandonada deja una cotización huérfana y una fila `pendiente`
en `pagos`; ambas vencen solas. Reintentar `/api/confirmar` es seguro: nada se
emite hasta que hay plata.

## Deploy

1. `cd apps/tienda && npx vercel link --yes --project dr-computacion`
2. En el dashboard: Root Directory `apps/tienda` + las variables de arriba.
3. Desde la RAÍZ: `VERCEL_ORG_ID=<org> VERCEL_PROJECT_ID=<prj> npx vercel --prod --yes`
   (ids en `apps/tienda/.vercel/project.json`). Tras el primer deploy, los
   merges a main despliegan solos (git conectado).

## Desarrollo local

`npm run dev -w @rr/tienda` con las variables en `apps/tienda/.env.local`.
