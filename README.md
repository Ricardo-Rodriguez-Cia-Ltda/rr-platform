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

Variable opcional `BASE_PATH`: expone el endpoint tambien bajo un prefijo de ruta, util cuando el subdominio del tunel agrupa varios servicios. Con `BASE_PATH=/rr/captador-precios` responden tanto `/api/price` como `/rr/captador-precios/price`. Sin la variable, solo `/api/price`.

### Cloudflare Tunnel (una vez, como servicio de Windows)

Requisitos: dominio de la empresa con DNS en Cloudflare (plan gratuito).

El siguiente bloque debe ejecutarse en una consola de PowerShell abierta **como Administrador**: instalar el servicio de Windows requiere permisos elevados.

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
    service: http://127.0.0.1:3000
  - service: http_status:404
```

Nota: el servidor local escucha solo en IPv4 (`127.0.0.1`); en Windows `localhost` puede resolver primero a `::1` (IPv6) y fallar la conexión, por eso se usa la IP explícita.

```powershell
cloudflared tunnel route dns precios precios.TUDOMINIO.cl
cloudflared service install              # queda como servicio de Windows (auto-arranca)
```

Importante: `cloudflared service install` copia `config.yml` y el archivo de credenciales al perfil de `LocalSystem`. Si luego editas el `config.yml` de tu usuario, el servicio **no** toma los cambios automáticamente; hay que reinstalarlo:

```powershell
cloudflared service uninstall
cloudflared service install
```

### Autoarranque del servidor

Hay un script que deja todo instalado (túnel como servicio + servidor como tarea programada al arrancar el equipo + desactivar suspensión). En PowerShell **como Administrador**:

```powershell
powershell -ExecutionPolicy Bypass -File scripts\install-autostart.ps1
```

Para hacerlo a mano en vez del script: Task Scheduler → Create Task: trigger "At startup", action "Start a program":
- Program: `cmd`
- Arguments: `/c cd /d C:\ruta\al\proyecto && npm run serve >> logs\serve.log 2>&1`
- Marcar "Run whether user is logged on or not".
- En la pestaña Settings, activar "If the task fails, restart every 1 minute, up to 3 times" para que se recupere solo ante un cierre inesperado.

### Consumo externo

```
GET https://precios.TUDOMINIO.cl/api/price?sku=...   (o mpn= / upc=)
Header: x-api-key: <API_SECRET_KEY>
```

Instalación actual de Ricardo Rodríguez y Cía. (túnel `captador-precios`, `BASE_PATH=/rr/captador-precios`):

```
GET https://api.pyxis-latam.cl/rr/captador-precios/price?sku=...   (o mpn= / upc=)
Header: x-api-key: <API_SECRET_KEY>
```

El PC debe permanecer encendido y con internet. Si cambia `.env.local`, reiniciar el servidor (la tarea programada o `npm run serve`). Evitar que el equipo entre en suspensión o hibernación, ya que eso corta el túnel:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

También conviene configurar las "Active Hours" de Windows Update (Configuración → Windows Update → Horas activas) para que los reinicios automáticos no ocurran mientras el servicio debe estar disponible.

### Checklist de PC nuevo

Al migrar o configurar el servidor en otro PC:

- `git clone` del repositorio.
- `npm install`.
- `mkdir logs` (requerido para que Task Scheduler pueda guardar los logs de ejecución).
- Crear `.env.local` con credenciales de **producción** (no las de preview/test).
- Confirmar que la IP pública del PC es la registrada en Intcomex.
- Correr `npm run serve` una vez de forma interactiva para verificar que responde antes de automatizar nada.
- Recién ahí configurar la tarea programada (Task Scheduler) y el servicio de Cloudflare Tunnel.

### Seguridad

El endpoint queda accesible desde internet con la `x-api-key` como única barrera. Se recomienda agregar una regla de rate limiting en el WAF de Cloudflare (disponible en el plan gratuito) y, si el sistema consumidor tiene IP fija, una regla que solo permita el tráfico desde esa IP.

Referencia IWS: https://iws.intcomex.com/reference/api.html
