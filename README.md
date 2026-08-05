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

Referencia IWS: https://iws.intcomex.com/reference/api.html
