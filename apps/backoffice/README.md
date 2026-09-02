# Backoffice interno (rr-backoffice)

Dashboard de operación: pedidos (nuevo → pagado → entregado), cotizaciones,
clientes y salud. Spec: `docs/superpowers/specs/2026-09-01-backoffice-design.md`.

## Variables (proyecto Vercel rr-backoffice)

| Variable | Qué es |
|---|---|
| `SUPABASE_URL` | la misma del relé |
| `SUPABASE_SERVICE_KEY` | la misma del relé (service_role) |
| `BACKOFFICE_PASSWORD` | la clave compartida del local |
| `BACKOFFICE_SESSION_SECRET` | cadena aleatoria larga (firma las cookies; rotarla cierra todas las sesiones) |

## Antes del primer deploy

1. Pegar `docs/sql/2026-09-01-estado-negocio.sql` en el SQL Editor de Supabase.
2. Crear el proyecto Vercel con Root Directory `apps/backoffice` y cargar las
   4 variables.
3. Linkear una sola vez DESDE `apps/backoffice`: `cd apps/backoffice && npx vercel link`
   (crea `apps/backoffice/.vercel/project.json` con los ids). El deploy va
   siempre desde la RAÍZ del repo (el build necesita los workspaces):
   `VERCEL_ORG_ID=<org> VERCEL_PROJECT_ID=<prj> npx vercel --prod --yes`
   con los ids de ese project.json. Es el mismo patrón que rr-mailing.

## Desarrollo local

`npm run dev -w @rr/backoffice` con las 4 variables en `apps/backoffice/.env.local`.
