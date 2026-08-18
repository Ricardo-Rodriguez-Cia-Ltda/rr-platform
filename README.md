# scrapper-proveedores

API de precios de proveedores. Cotiza contra Intcomex (IWS), Tecnoglobal e
Ingram Micro, cada uno con su propio catálogo y sus propias rutas. Ver
[Proveedores](#proveedores).

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
npm run docs:vocabulario     # regenera docs/api/vocabulario.md desde la API
vercel dev                   # servidor local
```

## Variables de entorno (Vercel)

| Variable | Preview | Production |
|---|---|---|
| `INTCOMEX_API_KEY` | clave pública de desarrollo | clave pública de producción |
| `INTCOMEX_ACCESS_KEY` | access key de desarrollo | access key de producción |
| `INTCOMEX_BASE_URL` | `https://intcomex-test.apigee.net/v1/` | `https://intcomex-prod.apigee.net/v1/` |
| `TECNOGLOBAL_USER` | usuario entregado por su área TI | íd. |
| `TECNOGLOBAL_PASSWORD` | clave **ya hasheada en MD5** por su área TI | íd. |
| `INGRAM_CLIENT_ID` | *(pendiente)* | *(pendiente)* |
| `INGRAM_CLIENT_SECRET` | *(pendiente)* | *(pendiente)* |
| `INGRAM_CUSTOMER_NUMBER` | *(pendiente)* | *(pendiente)* |
| `API_SECRET_KEY` | clave propia para `x-api-key` | clave propia para `x-api-key` |
| `CATALOG_CACHE_DIR` | carpeta del caché de catálogos (opcional; default `cache/`) | íd. |

Las opcionales con default razonable (`TECNOGLOBAL_BASE_URL`,
`INGRAM_BASE_URL`, `INGRAM_TOKEN_URL`, `INGRAM_COUNTRY_CODE`,
`INGRAM_SENDER_ID`, `INGRAM_MAX_PAGINAS`, `TECNOGLOBAL_PRECIOS_TTL_MS`) están
listadas en `.env.example`.

## Deploy

```bash
vercel link       # una vez
vercel            # deploy preview
vercel --prod     # deploy a producción
```

## Documentación de la API

La referencia completa vive en [`docs/api/`](docs/api/) y está escrita para ser leída por un LLM:

| Documento | Contenido |
|---|---|
| [`docs/api/README.md`](docs/api/README.md) | Referencia narrativa: cada endpoint, cada código de error, cómo funciona el ranking, cuándo reintentar y cuándo no. |
| [`docs/api/openapi.yaml`](docs/api/openapi.yaml) | El mismo contrato, machine-readable (OpenAPI 3.1). |
| [`docs/api/vocabulario.md`](docs/api/vocabulario.md) | Marcas y categorías reales del catálogo. Generado con `npm run docs:vocabulario`. |
| [`docs/kapso/README.md`](docs/kapso/README.md) | Cómo conectar todo esto al agente de WhatsApp aplicando el margen fuera del modelo. |

Resumen de endpoints (todos con `x-api-key`):

- `GET /search?q=...` — buscar por texto libre; `marca`, `categoria`, `precio_max`, `solo_con_stock`, `limite`.
- `GET /product?sku=...` — ficha completa de un SKU.
- `GET /price?sku=|mpn=|upc=` — cotizar un identificador conocido, sin pasar por el catálogo.
- `GET /facetas` — vocabulario del catálogo (uso de build-time, no como tool de un LLM).
- `POST /credito/mock` — cupo de crédito disponible. **Mock**: siempre responde línea de 10.000.000 CLP con 4.000.000 utilizados, sin importar el RUT. Ver abajo.

### Crédito (mock)

```bash
curl -X POST https://api.pyxis-latam.cl/rr/captador-precios/credito/mock \
  -H "x-api-key: $API_SECRET_KEY" -H "content-type: application/json" \
  -d '{"rut":"111111111","total_clp":12000000}'
```

Devuelve `aprobado`, `disponible_clp` y `faltante_clp`. Un cupo insuficiente es `200` con `aprobado: false`, no un error.

Mientras sea un mock, la ruta lleva `/mock` y toda respuesta trae `"mock": true`: un mock de crédito que se pueda confundir con el real aprueba compras que nadie autorizó. Cuando exista la integración con RRS, vivirá en `/credito`.

Es el único endpoint que usa `POST` y el único que habla en **pesos chilenos** — el resto de la API cotiza en USD.

`docs/api/` no se desactualiza en silencio: [`tests/docs.test.ts`](tests/docs.test.ts) falla si las rutas, los códigos de error, los status, los nombres de campo o las constantes citadas dejan de coincidir con el código.

### Catálogo

El catálogo de **cada proveedor** se descarga al arrancar y se refresca cada 24 horas, con copia propia en `cache/catalog-<proveedor>.json` (la carpeta se configura con `CATALOG_CACHE_DIR`). Los tres se refrescan en paralelo: que un proveedor esté caído no deja sin catálogo a los demás, y el reintento se agenda solo para el que falló. Mientras la primera descarga no termina, estos tres endpoints responden **503 `catalogo_no_disponible`**. Si el refresco falla pero hay copia en disco, se sigue usando la copia vencida: el precio siempre se consulta en vivo, así que lo único desactualizado sería el surtido. Si la descarga inicial falla (por ejemplo, Intcomex caído en un arranque en frío) y no hay copia en disco, se reintenta cada 5 minutos en vez de esperar las 24 horas completas.

> **Importante:** las respuestas de búsqueda traen el precio de **costo**. Si el consumidor es un LLM que habla con clientes finales, el margen debe aplicarse en un nodo determinista antes de que la respuesta entre al contexto del modelo.

## Proveedores

El negocio compra a tres distribuidores. Cada uno tiene su propio catálogo, sus
propios SKU y su propio precio; lo único comparable entre ellos es el `mpn`
(part number del fabricante).

| Proveedor | Ruta | Estado |
|---|---|---|
| `intcomex` | `/api/intcomex/{search,product,facetas}` | En producción |
| `tecnoglobal` | `/api/tecnoglobal/{search,product,facetas}` | Integrado y verificado contra su API real |
| `ingram` | `/api/ingram/{search,product,facetas}` | Integrado; **falta que Ingram entregue client_id / client_secret** |

`/api/search`, `/api/product` y `/api/facetas` sin proveedor **siguen siendo
Intcomex** y responden exactamente lo mismo que antes: existen para que el
agente Rayo no tenga que cambiar nada.

Un proveedor sin credenciales responde `503 proveedor_no_configurado` en sus
rutas y queda fuera del refresco de catálogos, en vez de reintentar cada 5
minutos algo que no puede funcionar.

**Todavía no existe el endpoint de "mejor precio"** entre los tres. Cada
proveedor se consulta por separado. Comparar es el paso siguiente y tiene su
propio diseño.

### Notas por proveedor

**Tecnoglobal.** Un solo servicio entrega catálogo, precio y stock juntos, todo
en USD, y sus dos endpoints se comportan muy distinto — medido contra el
servicio real, no documentado por ellos:

| Endpoint | Costo | Cuota observada |
|---|---|---|
| `/price` (catálogo completo, ~500 KB, 1.488 productos) | ~3 s | Se agota en **pocas llamadas** y sigue rechazando (401, "Excede la cantidad máx. de consultas en el tiempo [10 min.]") **bastante más** que esos 10 minutos |
| `/price/{sku}` | ~1,5 s cada una, **no mejora en paralelo** | Aguantó 12 llamadas seguidas sin quejarse |

De ahí el reparto que hace el módulo:

- **Pocos SKU** (≤ 5: una ficha de `/product`, una cotización de `/price`) se
  piden en vivo por SKU. Es el precio del momento, y son las llamadas que de
  verdad se cotizan a un cliente.
- **Muchos SKU** (el ranking de un `/search`) salen de una foto en memoria del
  último volcado, refrescable como mucho cada hora
  (`TECNOGLOBAL_PRECIOS_TTL_MS`). Pedir 25 en vivo serían ~37 s de espera.
- Si el refresco de la foto es rechazado por cuota, **se sigue usando la foto
  vencida**: es el ranking de una búsqueda, y el precio definitivo se confirma
  con `/product`.

La foto se guarda en disco junto a los catálogos (`tecnoglobal-precios.json`), así que un reinicio no obliga a gastar una descarga del volcado.

> **Para el consumidor:** el precio que trae `/search` de Tecnoglobal puede
> tener hasta una hora. El de `/product` y `/price` es del momento. Si el
> agente va a comprometer un precio con el cliente, que lo confirme con
> `/product`.

La cuota exacta del volcado no está documentada: conviene confirmarla con su
área TI antes de subir el tráfico.

**Ingram Micro.** OAuth2 `client_credentials` con el token cacheado en memoria,
catálogo paginado de a 100 y precios en lotes de 50 (el tope de su endpoint). El
endpoint de token está verificado contra producción; las formas de catálogo y de
precios salen de la OpenAPI que Ingram publica en
`ingrammicro-xvantage/xi-sdk-openapispec` y **quedan sin verificar contra el
tenant real hasta tener credenciales**.

### Probar Ingram sin credenciales

`scripts/mock-ingram.ts` levanta un servidor que imita el contrato publicado de
Ingram, para ejercitar el módulo de punta a punta (ruta HTTP → handler →
proveedor → red). Verifica el **cableado**, no que le hayamos acertado a la
forma real del tenant:

```bash
npx tsx scripts/mock-ingram.ts    # queda escuchando en :4010
```

Y en otra terminal, `npm run serve` con `INGRAM_BASE_URL=http://127.0.0.1:4010`,
`INGRAM_TOKEN_URL=http://127.0.0.1:4010/oauth/oauth30/token` y cualquier valor
en `INGRAM_CLIENT_ID`, `INGRAM_CLIENT_SECRET` e `INGRAM_CUSTOMER_NUMBER`.

Cuando lleguen las credenciales reales, sirve para comparar la respuesta
simulada con la de verdad.

### Agregar un proveedor nuevo

1. Escribir `lib/providers/<nombre>.ts` exportando un objeto que cumpla
   `Proveedor` (`lib/types.ts`): `cargarCatalogo`, `getPrecios`, `getPrecio`,
   `maxSkusPorLote` y `estaConfigurado`. La normalización a
   `ProductoNormalizado` ocurre **dentro** del módulo; ni el catálogo ni el
   buscador ven nunca una respuesta cruda.
2. Sumarlo a `PROVEEDORES` en `lib/providers/index.ts`.
3. Documentar sus variables en `.env.example`.

Con eso quedan andando sus tres rutas, su catálogo con caché propio
(`cache/catalog-<nombre>.json`) y su refresco en paralelo. No hay nada más que
tocar: `tests/paridad-proveedores.test.ts` verifica que el proveedor nuevo
responda el mismo contrato que los demás.

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
