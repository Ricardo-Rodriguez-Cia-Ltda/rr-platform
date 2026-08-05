# scrapper-proveedores

API de precios de proveedores (Intcomex vía IWS) desplegada en Vercel.

## Uso

```
GET /api/price?sku=SE001MSE01
GET /api/price?mpn=AAA-01148
GET /api/price?upc=885370599871
Header requerido: x-api-key: <API_SECRET_KEY>
```

Respuesta 200:

```json
{
  "provider": "intcomex",
  "sku": "SE001MSE01",
  "mpn": "AAA-01148",
  "description": "Microsoft Access 2013 - License...",
  "price": 103.5294,
  "currency": "US",
  "inStock": 203
}
```

Errores: `401` x-api-key inválida · `400` parámetros inválidos · `404` producto no encontrado · `502` fallo del proveedor. Formato: `{ "error": "...", "detail": "..." }`.

## Desarrollo

```bash
npm install
npm test            # tests unitarios
npm run typecheck
cp .env.example .env.local   # completar con credenciales reales
npm run check -- <SKU>       # smoke test contra IWS test
vercel dev                   # servidor local
```

## Variables de entorno (Vercel)

| Variable | Preview | Production |
|---|---|---|
| `INTCOMEX_API_KEY` | clave pública de desarrollo | clave pública de producción |
| `INTCOMEX_ACCESS_KEY` | access key de desarrollo | access key de producción |
| `INTCOMEX_BASE_URL` | `https://intcomex-test.apigee.net/v1/` | `https://intcomex-prod.apigee.net/v1/` |
| `API_SECRET_KEY` | clave propia para `x-api-key` | clave propia para `x-api-key` |

## Deploy

```bash
vercel link       # una vez
vercel            # deploy preview
vercel --prod     # deploy a producción
```

## Hosting local (PC oficina) + Cloudflare Tunnel

Intcomex valida IP de origen; las IPs de Vercel son dinámicas. Alternativa: servir la API desde un PC de la oficina (IP registrada) y exponerla con Cloudflare Tunnel.

### Servidor local

```bash
npm run serve        # sirve en http://127.0.0.1:3000 (PORT/HOST para cambiar)
```

Usa el mismo handler y `.env.local` que el resto del proyecto.

### Cloudflare Tunnel (una vez, como servicio de Windows)

Requisitos: dominio de la empresa con DNS en Cloudflare (plan gratuito).

```powershell
winget install Cloudflare.cloudflared
cloudflared tunnel login                 # abre el navegador; elegir el dominio
cloudflared tunnel create precios        # anota el TUNNEL-ID que imprime
```

Crear `C:\Users\<usuario>\.cloudflared\config.yml`:

```yaml
tunnel: <TUNNEL-ID>
credentials-file: C:\Users\<usuario>\.cloudflared\<TUNNEL-ID>.json
ingress:
  - hostname: precios.TUDOMINIO.cl
    service: http://localhost:3000
  - service: http_status:404
```

```powershell
cloudflared tunnel route dns precios precios.TUDOMINIO.cl
cloudflared service install              # queda como servicio de Windows (auto-arranca)
```

### Autoarranque del servidor

Task Scheduler → Create Task: trigger "At startup", action "Start a program":
- Program: `cmd`
- Arguments: `/c cd /d C:\ruta\al\proyecto && npm run serve`
- Marcar "Run whether user is logged on or not".

### Consumo externo

```
GET https://precios.TUDOMINIO.cl/api/price?sku=...   (o mpn= / upc=)
Header: x-api-key: <API_SECRET_KEY>
```

El PC debe permanecer encendido y con internet. Si cambia `.env.local`, reiniciar el servidor (la tarea programada o `npm run serve`).

Referencia IWS: https://iws.intcomex.com/reference/api.html
