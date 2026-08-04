# Diseño: API de precios de proveedores (price-fetcher)

**Fecha:** 2026-08-04
**Estado:** Aprobado

## Problema

Ricardo Rodríguez & Cía. necesita consultar por API el precio de un producto en sus proveedores. El primer proveedor es Intcomex (vía IWS, su API oficial). Más adelante se agregarán otros proveedores y un endpoint de comparación ("¿cuál es el más barato?").

## Alcance

**Incluido en esta fase:**
- Endpoint `GET /api/price` desplegado en Vercel que devuelve precio, moneda, stock y descripción de un producto de Intcomex.
- Búsqueda por `sku` (código Intcomex), `mpn` (número de parte del fabricante) o `upc`.
- Autenticación del endpoint con API key propia (header `x-api-key`).
- Estructura de providers que permita agregar proveedores futuros sin tocar el endpoint.

**Fuera de alcance (futuro):**
- Otros proveedores.
- Endpoint de comparación multi-proveedor.
- Interfaz web / dashboard.
- Caché de precios.

## Arquitectura

Vercel Functions puras en TypeScript, sin framework.

```
scrapper-proveedores/
├── api/
│   └── price.ts              # GET /api/price — el endpoint
├── lib/
│   ├── auth.ts               # valida el header x-api-key
│   ├── types.ts              # PriceResult, interfaz Provider
│   └── providers/
│       └── intcomex.ts       # firma de requests + llamada a /getproduct
├── package.json
├── tsconfig.json
└── vercel.json
```

Cada proveedor implementa la interfaz `Provider`:

```ts
interface Provider {
  name: string;
  getPrice(query: { sku?: string; mpn?: string; upc?: string }): Promise<PriceResult>;
}
```

El futuro endpoint de comparación iterará sobre la lista de providers registrados.

## Contrato de la API

### Request

```
GET /api/price?mpn=AAA-01148
Header: x-api-key: <API_SECRET_KEY>
```

- Se acepta **exactamente uno** de `sku`, `mpn`, `upc`.
- Parámetro opcional `provider` (default y único valor actual: `intcomex`).

### Respuesta 200

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

El campo `price` se devuelve tal cual lo entrega el proveedor, sin redondear.

### Errores

Formato: `{ "error": "...", "detail": "..." }`

| Código | Cuándo |
|---|---|
| 401 | `x-api-key` ausente o inválida |
| 400 | Ninguno (o más de uno) de `sku`/`mpn`/`upc`, o `provider` desconocido |
| 404 | Intcomex no encuentra el producto |
| 502 | Intcomex falla o no responde (detalle en el body, sin filtrar claves) |

## Integración con Intcomex (IWS)

Referencia: https://iws.intcomex.com/reference/api.html (spec OpenAPI en `/reference/iws-openapi-en.yaml`).

- **Base URLs:** test `https://intcomex-test.apigee.net/v1/`, producción `https://intcomex-prod.apigee.net/v1/`.
- **Endpoint usado:** `GET /getproduct` con `sku` | `mpn` | `upc`, `includePriceData=true`, `includeInventoryData=true`. Devuelve `Price.UnitPrice`, `Price.CurrencyId`, `InStock`, `Description`, `Sku`, `Mpn`.

### Autenticación por request

1. Timestamp UTC actual, formato `YYYY-MM-DDTHH:mm:ssZ`.
2. Firma: `SHA-256("apiKey,accessKey,timestamp")` (string separado por comas; `crypto` nativo de Node).
3. Header: `Authorization: Bearer apiKey=<apiKey>&utcTimeStamp=<ts>&signature=<firma>`.
4. El token vale 5 minutos; se genera uno nuevo en cada request (sin estado, ideal para serverless).

La Access Key es secreta: nunca va en URLs, bodies, logs ni en el repo.

## Configuración

| Variable | Descripción |
|---|---|
| `INTCOMEX_API_KEY` | Clave pública de Intcomex (dev o prod según entorno) |
| `INTCOMEX_ACCESS_KEY` | Clave privada de Intcomex — solo en Vercel y `.env.local` |
| `INTCOMEX_BASE_URL` | Base URL de IWS (test en preview, prod en producción) |
| `API_SECRET_KEY` | Clave que el sistema consumidor envía en `x-api-key` |

- En Vercel: los deploys de **preview** usan credenciales de desarrollo y el entorno test de IWS; **producción** usa las de producción.
- `.env.local` está en `.gitignore`. Ninguna clave se commitea.
- Nota de seguridad: las apiKeys públicas circularon por chat; se recomienda pedir rotación a Intcomex.

## Manejo de errores

- Errores de IWS (firma inválida, timestamp vencido, IP no autorizada, producto inexistente) se traducen a los códigos HTTP del contrato.
- Los mensajes de error hacia el cliente nunca incluyen claves ni el token firmado.

## Pruebas

- **Unitarias (Vitest):**
  - Generación de firma contra el ejemplo documentado por IWS (resultado conocido).
  - Normalización de la respuesta de `/getproduct` a `PriceResult`.
  - Validación de parámetros (ninguno / más de uno / provider desconocido).
  - Validación de `x-api-key`.
  - La llamada HTTP a IWS se mockea.
- **Smoke test manual:** `npm run check` consulta un SKU real contra el entorno test de IWS para validar credenciales de punta a punta.
- **Desarrollo local:** `vercel dev` + `.env.local`.
