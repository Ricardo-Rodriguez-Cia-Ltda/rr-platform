# Diseño: Hosting local de la API + Cloudflare Tunnel

**Fecha:** 2026-08-05
**Estado:** Aprobado

## Problema

La API está deployada en Vercel y funciona, pero Intcomex rechaza las IPs dinámicas de Vercel (ErrorCode 14, whitelist de IP). Desde la red de la oficina (IP registrada) todo funciona. El sistema consumidor está **fuera** de la oficina, así que la API debe quedar accesible desde internet, hosteada en un PC de la oficina.

## Solución

Servir el mismo handler en un PC de la oficina con un mini servidor HTTP, y exponerlo con un Cloudflare Tunnel (dominio propio de la empresa, plan gratuito): URL fija `https://precios.<dominio>`, HTTPS automático, sin abrir puertos.

## Alcance

**Incluido:**
- `server.ts` (raíz): servidor `node:http` sin dependencias nuevas que adapta `IncomingMessage`/`ServerResponse` al handler existente `api/price.ts` (default export con firma Vercel).
- Script npm `serve`: `tsx --env-file=.env.local server.ts`.
- Tests unitarios del adaptador (vitest, provider mockeado).
- Documentación en README: cómo levantar el servidor, crear el túnel con `cloudflared` como servicio de Windows, y autoarranque del servidor con Tarea Programada.

**Fuera de alcance:**
- Cambios al handler, providers o al deploy de Vercel (queda como está).
- Automatizar la creación del túnel (requiere login interactivo del usuario en Cloudflare).

## Diseño de `server.ts`

- `PORT` (default `3000`) y `HOST` (default `127.0.0.1`) por variables de entorno. Bind a loopback: solo `cloudflared`, corriendo en la misma máquina, alcanza el servidor.
- Adaptación por request:
  - `query`: parseada de la URL con `URL.searchParams` (valores string; params repetidos → se toma el primero, coherente con `firstString` del handler).
  - `headers` y `method`: los nativos de Node (el handler ya valida `x-api-key` y método GET).
  - Response: se agregan `status(code)` (set `statusCode`, retorna el response para encadenar) y `json(payload)` (header `content-type: application/json`, `JSON.stringify`, `end`).
- Rutas: se enruta solo por path — `/api/price` (cualquier método) → handler, que ya aplica el 405 a métodos no-GET. Cualquier otro path → `404 {"error":"not_found","detail":"Unknown route"}`.
- Errores inesperados del handler → `500 {"error":"internal","detail":"Unexpected server error"}` sin filtrar internals (el handler ya captura los suyos; esto es red de seguridad del adaptador).
- Al iniciar, loguea `listening on http://HOST:PORT` (nunca credenciales).

## Contrato

Idéntico al de Vercel: `GET /api/price?sku=|mpn=|upc=` + header `x-api-key`; respuestas 200/400/401/404/405/502 según el spec anterior (`2026-08-04-price-fetcher-design.md`).

## Operación (documentada en README, ejecutada por el usuario)

1. **Servidor:** `npm run serve` en el PC designado (siempre encendido).
2. **Túnel:** `cloudflared tunnel login` (cuenta Cloudflare de la empresa con el dominio), `cloudflared tunnel create precios`, config con ingress `precios.<dominio>` → `http://localhost:3000`, `cloudflared tunnel route dns`, y `cloudflared service install` para que corra como servicio de Windows.
3. **Autoarranque del servidor:** Tarea Programada de Windows al inicio del equipo que ejecuta `npm run serve` en el directorio del proyecto.
4. El consumidor externo usa `https://precios.<dominio>/api/price?...` con la `x-api-key`.

## Limitaciones conocidas

- Disponibilidad atada al PC de la oficina (energía, internet, reinicios).
- Si cambia `.env.local`, reiniciar el servidor.

## Pruebas

- Unitarias del adaptador con el módulo del provider mockeado (sin red): ruta correcta 200 con query y key; ruta desconocida 404; sin key 401 (vía handler); params repetidos toman el primero.
- Smoke manual: `npm run serve` + `curl` local con la key (ya validado en sesión con `vercel dev`; se repite con `server.ts`).
