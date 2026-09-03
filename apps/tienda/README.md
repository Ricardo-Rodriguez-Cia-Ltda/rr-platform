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
| `NEXT_PUBLIC_RAYO_WA` | teléfono del bot para wa.me (solo dígitos) — **requerida**: sin ella el botón de WhatsApp no se muestra y el cliente queda sin ninguna vía de contacto (la tienda no cobra online) |

Todas son requeridas. El techo de ejecución se fija con `export const
maxDuration = 30` en cada entrypoint (`/api/confirmar` invoca dos functions de
Kapso en vivo y la búsqueda espera hasta 21s a la pricing-api). Va como segment
config de Next, no en `vercel.json`: en App Router las functions las emite el
framework, y un glob que no calza ninguna hace fallar el build.

## Deploy

1. `cd apps/tienda && npx vercel link --yes --project dr-computacion`
2. En el dashboard: Root Directory `apps/tienda` + las variables de arriba.
3. Desde la RAÍZ: `VERCEL_ORG_ID=<org> VERCEL_PROJECT_ID=<prj> npx vercel --prod --yes`
   (ids en `apps/tienda/.vercel/project.json`). Tras el primer deploy, los
   merges a main despliegan solos (git conectado).

## Desarrollo local

`npm run dev -w @rr/tienda` con las variables en `apps/tienda/.env.local`.
