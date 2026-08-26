# Respaldo de las functions de v1 (workflow `Rayo Perez`)

Tomado el 2026-08-26 desde `GET /platform/v1/functions`, antes del cutover a
`rr-isia-version2`.

Cada `.js` es el codigo desplegado tal cual, y `manifiesto.json` guarda el
`id`, el `slug` y el `status` que tenia cada una.

## Por que existe

Kapso **no tiene "undeploy"**. Para liberar un slot de la cuota de Cloudflare
Workers (5 por proyecto) hay que borrar la function, y `DELETE /functions/{id}`
es permanente: se lleva tambien todos sus secretos.

Este respaldo permite volver a crear el codigo, pero **no** revive el workflow
v1 tal cual: una function recreada nace con un `id` nuevo, y los nodos de
`Rayo Perez` apuntan a los `id` viejos. Restaurar v1 significa recrear las
functions y despues recablear sus nodos con los `id` nuevos.

## Lo que el respaldo NO puede rescatar

Los **valores** de los secretos. La API expone solo los nombres. En particular
`RESEND_API_KEY` y `RESEND_FROM_EMAIL` viven unicamente dentro de
`send-quote-request-email`; si esa function se borra, esos valores se pierden y
hay que emitir una API key nueva en Resend.
