# Price-Fetcher API — Plan de Implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** API en Vercel (`GET /api/price`) que devuelve precio, moneda, stock y descripción de un producto consultando la API IWS de Intcomex, protegida con API key propia.

**Architecture:** Vercel Functions puras en TypeScript. El endpoint `api/price.ts` valida la API key propia y los parámetros, y delega en un provider (`lib/providers/intcomex.ts`) que firma cada request con SHA-256 y llama a `GET /getproduct` de IWS. Interfaz `Provider` genérica para sumar proveedores después.

**Tech Stack:** Node 20+, TypeScript 5 (strict), Vercel Functions (`@vercel/node`), Vitest, tsx (solo para el smoke script). Sin dependencias de runtime.

**Spec:** `docs/superpowers/specs/2026-08-04-price-fetcher-design.md`

## Global Constraints

- Sin dependencias de producción: solo devDependencies. El runtime usa `fetch` y `node:crypto` nativos.
- Secretos SOLO en variables de entorno: `INTCOMEX_API_KEY`, `INTCOMEX_ACCESS_KEY`, `INTCOMEX_BASE_URL`, `API_SECRET_KEY`. Nunca en código, logs, mensajes de error ni git.
- `price` se devuelve sin redondear, tal cual `Price.UnitPrice` de IWS.
- Formato de error uniforme: `{ "error": "...", "detail": "..." }`.
- ESM (`"type": "module"`), TypeScript strict.
- Firma IWS: `SHA-256("apiKey,accessKey,utcTimeStamp")` en hex minúsculas; timestamp `YYYY-MM-DDTHH:mm:ssZ`; token válido 5 minutos, se genera uno por request.

---

### Task 1: Scaffold del proyecto

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.gitignore`
- Create: `.env.example`
- Create: `vercel.json`

**Interfaces:**
- Consumes: nada.
- Produces: proyecto npm instalable donde `npm test` y `npm run typecheck` pasan. Scripts: `test` (vitest run), `typecheck` (tsc --noEmit), `check` (tsx --env-file=.env.local scripts/check.ts).

- [ ] **Step 1: Crear `package.json`**

```json
{
  "name": "scrapper-proveedores",
  "private": true,
  "type": "module",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "test": "vitest run --passWithNoTests",
    "typecheck": "tsc --noEmit",
    "check": "tsx --env-file=.env.local scripts/check.ts"
  },
  "devDependencies": {
    "@types/node": "^22",
    "@vercel/node": "^5",
    "tsx": "^4",
    "typescript": "^5",
    "vitest": "^3"
  }
}
```

- [ ] **Step 2: Crear `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "lib": ["ES2022"],
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "noEmit": true,
    "types": ["node"]
  },
  "include": ["api/**/*.ts", "lib/**/*.ts", "scripts/**/*.ts", "tests/**/*.ts"]
}
```

- [ ] **Step 3: Crear `.gitignore`**

```
node_modules/
.vercel/
.env
.env.*
!.env.example
```

- [ ] **Step 4: Crear `.env.example`** (valores de ejemplo, NO reales)

```
# Clave publica de Intcomex (dev o prod segun entorno)
INTCOMEX_API_KEY=00000000-0000-0000-0000-000000000000
# Clave privada de Intcomex - NUNCA commitear el valor real
INTCOMEX_ACCESS_KEY=changeme
# test: https://intcomex-test.apigee.net/v1/  |  prod: https://intcomex-prod.apigee.net/v1/
INTCOMEX_BASE_URL=https://intcomex-test.apigee.net/v1/
# Clave que el sistema consumidor manda en el header x-api-key
API_SECRET_KEY=changeme
```

- [ ] **Step 5: Crear `vercel.json`**

```json
{
  "functions": {
    "api/**/*.ts": {
      "maxDuration": 30
    }
  }
}
```

- [ ] **Step 6: Instalar dependencias**

Run: `npm install`
Expected: instala sin errores, crea `package-lock.json`.

- [ ] **Step 7: Verificar que typecheck y test pasan en vacío**

Run: `npm run typecheck` y luego `npm test`
Expected: ambos terminan con exit code 0 (vitest dice "no test files found" pero pasa por `--passWithNoTests`).

- [ ] **Step 8: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore .env.example vercel.json
git commit -m "chore: scaffold TypeScript Vercel project"
```

---

### Task 2: Tipos y firma de autenticación de Intcomex

**Files:**
- Create: `lib/types.ts`
- Create: `lib/providers/intcomex.ts` (solo la parte de firma/token)
- Test: `tests/intcomex-auth.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces:
  - `lib/types.ts`: `interface PriceQuery { sku?: string; mpn?: string; upc?: string }` · `interface PriceResult { provider: string; sku: string | null; mpn: string | null; description: string | null; price: number; currency: string; inStock: number | null }` · `interface Provider { name: string; getPrice(query: PriceQuery): Promise<PriceResult> }` · `class ProviderError extends Error { kind: 'not_found' | 'upstream'; detail?: string }`
  - `lib/providers/intcomex.ts`: `formatUtcTimestamp(date: Date): string` · `buildSignature(apiKey: string, accessKey: string, utcTimeStamp: string): string` · `buildAuthToken(apiKey: string, accessKey: string, now: Date): string`

- [ ] **Step 1: Crear `lib/types.ts`**

```ts
export interface PriceQuery {
  sku?: string;
  mpn?: string;
  upc?: string;
}

export interface PriceResult {
  provider: string;
  sku: string | null;
  mpn: string | null;
  description: string | null;
  price: number;
  currency: string;
  inStock: number | null;
}

export interface Provider {
  name: string;
  getPrice(query: PriceQuery): Promise<PriceResult>;
}

export type ProviderErrorKind = 'not_found' | 'upstream';

export class ProviderError extends Error {
  constructor(
    public readonly kind: ProviderErrorKind,
    message: string,
    public readonly detail?: string,
  ) {
    super(message);
    this.name = 'ProviderError';
  }
}
```

- [ ] **Step 2: Escribir el test que falla (`tests/intcomex-auth.test.ts`)**

El hash esperado es SHA-256 real de `"myApiKey,myAccessKey,2020-01-20T15:10:00Z"` (precalculado).

```ts
import { describe, expect, it } from 'vitest';
import {
  buildAuthToken,
  buildSignature,
  formatUtcTimestamp,
} from '../lib/providers/intcomex';

describe('formatUtcTimestamp', () => {
  it('formats as YYYY-MM-DDTHH:mm:ssZ without milliseconds', () => {
    const date = new Date('2020-01-20T15:10:00.123Z');
    expect(formatUtcTimestamp(date)).toBe('2020-01-20T15:10:00Z');
  });
});

describe('buildSignature', () => {
  it('returns SHA-256 hex of "apiKey,accessKey,timestamp"', () => {
    const signature = buildSignature('myApiKey', 'myAccessKey', '2020-01-20T15:10:00Z');
    expect(signature).toBe(
      'd6364b68908f32c6da6f7fae1a35a8259c886d764701825cca7bc0188d07033d',
    );
  });
});

describe('buildAuthToken', () => {
  it('assembles apiKey, timestamp and signature', () => {
    const token = buildAuthToken('myApiKey', 'myAccessKey', new Date('2020-01-20T15:10:00.000Z'));
    expect(token).toBe(
      'apiKey=myApiKey&utcTimeStamp=2020-01-20T15:10:00Z&signature=d6364b68908f32c6da6f7fae1a35a8259c886d764701825cca7bc0188d07033d',
    );
  });
});
```

- [ ] **Step 3: Verificar que falla**

Run: `npx vitest run tests/intcomex-auth.test.ts`
Expected: FAIL — no existe `lib/providers/intcomex.ts`.

- [ ] **Step 4: Implementar la firma en `lib/providers/intcomex.ts`**

```ts
import { createHash } from 'node:crypto';

export function formatUtcTimestamp(date: Date): string {
  return date.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

export function buildSignature(
  apiKey: string,
  accessKey: string,
  utcTimeStamp: string,
): string {
  return createHash('sha256')
    .update(`${apiKey},${accessKey},${utcTimeStamp}`)
    .digest('hex');
}

export function buildAuthToken(apiKey: string, accessKey: string, now: Date): string {
  const utcTimeStamp = formatUtcTimestamp(now);
  const signature = buildSignature(apiKey, accessKey, utcTimeStamp);
  return `apiKey=${apiKey}&utcTimeStamp=${utcTimeStamp}&signature=${signature}`;
}
```

- [ ] **Step 5: Verificar que pasa**

Run: `npx vitest run tests/intcomex-auth.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 6: Commit**

```bash
git add lib/types.ts lib/providers/intcomex.ts tests/intcomex-auth.test.ts
git commit -m "feat: add core types and Intcomex request signing"
```

---

### Task 3: Provider Intcomex — getPrice

**Files:**
- Modify: `lib/providers/intcomex.ts` (agregar config, provider y normalización)
- Test: `tests/intcomex-provider.test.ts`

**Interfaces:**
- Consumes: `buildAuthToken` (Task 2), `PriceQuery`/`PriceResult`/`Provider`/`ProviderError` de `lib/types.ts` (Task 2). Env vars `INTCOMEX_API_KEY`, `INTCOMEX_ACCESS_KEY`, `INTCOMEX_BASE_URL`.
- Produces: `export const intcomex: Provider` — llama `GET {INTCOMEX_BASE_URL}getproduct` y normaliza a `PriceResult`. Lanza `ProviderError('not_found', ...)` en 404 o sin precio; `ProviderError('upstream', ...)` en cualquier otro fallo.

- [ ] **Step 1: Escribir tests que fallan (`tests/intcomex-provider.test.ts`)**

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { intcomex } from '../lib/providers/intcomex';
import { ProviderError } from '../lib/types';

const IWS_PRODUCT = {
  Sku: 'SE001MSE01',
  Mpn: 'AAA-01148',
  Description: 'Microsoft Access 2013 - License - 1 PC',
  Price: { UnitPrice: 103.5294, CurrencyId: 'US' },
  InStock: 203,
};

describe('intcomex.getPrice', () => {
  beforeEach(() => {
    vi.stubEnv('INTCOMEX_API_KEY', 'pub-key');
    vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret-key');
    vi.stubEnv('INTCOMEX_BASE_URL', 'https://intcomex-test.apigee.net/v1/');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
  });

  it('calls /getproduct with the query param and auth header, and normalizes the response', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(JSON.stringify(IWS_PRODUCT), { status: 200 }),
    );
    vi.stubGlobal('fetch', fetchMock);

    const result = await intcomex.getPrice({ sku: 'SE001MSE01' });

    expect(result).toEqual({
      provider: 'intcomex',
      sku: 'SE001MSE01',
      mpn: 'AAA-01148',
      description: 'Microsoft Access 2013 - License - 1 PC',
      price: 103.5294,
      currency: 'US',
      inStock: 203,
    });

    const [url, init] = fetchMock.mock.calls[0] as [URL, RequestInit];
    expect(url.href).toContain('https://intcomex-test.apigee.net/v1/getproduct');
    expect(url.href).toContain('sku=SE001MSE01');
    expect(url.href).toContain('includePriceData=true');
    expect(url.href).toContain('includeInventoryData=true');
    const auth = new Headers(init.headers).get('authorization') ?? '';
    expect(auth).toMatch(/^Bearer apiKey=pub-key&utcTimeStamp=.+&signature=[0-9a-f]{64}$/);
  });

  it('throws not_found on HTTP 404', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ Code: 20, Message: 'Invalid product.' }), { status: 404 }),
      ),
    );

    await expect(intcomex.getPrice({ mpn: 'NOPE' })).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('throws not_found when the product has no price data', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ Sku: 'X', Price: null }), { status: 200 }),
      ),
    );

    await expect(intcomex.getPrice({ sku: 'X' })).rejects.toMatchObject({
      kind: 'not_found',
    });
  });

  it('throws upstream on HTTP 500 without leaking credentials', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(new Response('kaboom', { status: 500 })),
    );

    const error = await intcomex.getPrice({ sku: 'X' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).kind).toBe('upstream');
    expect((error as ProviderError).message).not.toContain('secret-key');
    expect((error as ProviderError).detail ?? '').not.toContain('secret-key');
  });

  it('throws upstream when credentials are not configured', async () => {
    vi.stubEnv('INTCOMEX_ACCESS_KEY', '');

    await expect(intcomex.getPrice({ sku: 'X' })).rejects.toMatchObject({
      kind: 'upstream',
    });
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `npx vitest run tests/intcomex-provider.test.ts`
Expected: FAIL — `intcomex` no está exportado.

- [ ] **Step 3: Implementar el provider (agregar al final de `lib/providers/intcomex.ts`)**

```ts
import type { PriceQuery, PriceResult, Provider } from '../types';
import { ProviderError } from '../types';
```

(unificar con los imports existentes al inicio del archivo)

```ts
interface IwsProduct {
  Sku?: string;
  Mpn?: string;
  Description?: string;
  Price?: { UnitPrice?: number; CurrencyId?: string } | null;
  InStock?: number;
}

function getConfig(): { apiKey: string; accessKey: string; baseUrl: string } {
  const apiKey = process.env.INTCOMEX_API_KEY;
  const accessKey = process.env.INTCOMEX_ACCESS_KEY;
  const baseUrl = process.env.INTCOMEX_BASE_URL;
  if (!apiKey || !accessKey || !baseUrl) {
    throw new ProviderError('upstream', 'Intcomex credentials are not configured');
  }
  return { apiKey, accessKey, baseUrl };
}

export const intcomex: Provider = {
  name: 'intcomex',

  async getPrice(query: PriceQuery): Promise<PriceResult> {
    const { apiKey, accessKey, baseUrl } = getConfig();

    const url = new URL('getproduct', baseUrl);
    if (query.sku) url.searchParams.set('sku', query.sku);
    if (query.mpn) url.searchParams.set('mpn', query.mpn);
    if (query.upc) url.searchParams.set('upc', query.upc);
    url.searchParams.set('includePriceData', 'true');
    url.searchParams.set('includeInventoryData', 'true');

    let response: Response;
    try {
      response = await fetch(url, {
        headers: {
          Authorization: `Bearer ${buildAuthToken(apiKey, accessKey, new Date())}`,
        },
      });
    } catch {
      throw new ProviderError('upstream', 'Could not reach Intcomex');
    }

    if (response.status === 404) {
      throw new ProviderError('not_found', 'Product not found at Intcomex');
    }
    if (!response.ok) {
      const body = await response.text().catch(() => '');
      throw new ProviderError(
        'upstream',
        `Intcomex responded with HTTP ${response.status}`,
        body.slice(0, 500),
      );
    }

    const product = (await response.json()) as IwsProduct;
    if (product.Price?.UnitPrice == null) {
      throw new ProviderError('not_found', 'Intcomex returned no price for this product');
    }

    return {
      provider: 'intcomex',
      sku: product.Sku ?? null,
      mpn: product.Mpn ?? null,
      description: product.Description ?? null,
      price: product.Price.UnitPrice,
      currency: product.Price.CurrencyId ?? 'USD',
      inStock: product.InStock ?? null,
    };
  },
};
```

- [ ] **Step 4: Verificar que pasan**

Run: `npx vitest run tests/intcomex-provider.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Correr toda la suite + typecheck**

Run: `npm test` y `npm run typecheck`
Expected: todo PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add lib/providers/intcomex.ts tests/intcomex-provider.test.ts
git commit -m "feat: implement Intcomex getPrice provider"
```

---

### Task 4: Autenticación del endpoint propio

**Files:**
- Create: `lib/auth.ts`
- Test: `tests/auth.test.ts`

**Interfaces:**
- Consumes: nada.
- Produces: `isAuthorized(providedKey: string | undefined, expectedKey: string | undefined): boolean` — comparación en tiempo constante; `false` si cualquiera falta o está vacía.

- [ ] **Step 1: Escribir el test que falla (`tests/auth.test.ts`)**

```ts
import { describe, expect, it } from 'vitest';
import { isAuthorized } from '../lib/auth';

describe('isAuthorized', () => {
  it('accepts matching keys', () => {
    expect(isAuthorized('super-secret', 'super-secret')).toBe(true);
  });

  it('rejects wrong keys', () => {
    expect(isAuthorized('wrong', 'super-secret')).toBe(false);
  });

  it('rejects keys of different length', () => {
    expect(isAuthorized('super-secret-longer', 'super-secret')).toBe(false);
  });

  it('rejects missing provided key', () => {
    expect(isAuthorized(undefined, 'super-secret')).toBe(false);
  });

  it('rejects when the server key is not configured', () => {
    expect(isAuthorized('anything', undefined)).toBe(false);
    expect(isAuthorized('', '')).toBe(false);
  });
});
```

- [ ] **Step 2: Verificar que falla**

Run: `npx vitest run tests/auth.test.ts`
Expected: FAIL — no existe `lib/auth.ts`.

- [ ] **Step 3: Implementar `lib/auth.ts`**

```ts
import { timingSafeEqual } from 'node:crypto';

export function isAuthorized(
  providedKey: string | undefined,
  expectedKey: string | undefined,
): boolean {
  if (!providedKey || !expectedKey) return false;
  const provided = Buffer.from(providedKey);
  const expected = Buffer.from(expectedKey);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
```

- [ ] **Step 4: Verificar que pasa**

Run: `npx vitest run tests/auth.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add lib/auth.ts tests/auth.test.ts
git commit -m "feat: add x-api-key validation helper"
```

---

### Task 5: Endpoint GET /api/price

**Files:**
- Create: `api/price.ts`
- Test: `tests/price-endpoint.test.ts`

**Interfaces:**
- Consumes: `isAuthorized` (Task 4), `intcomex` (Task 3), `Provider`/`ProviderError` (Task 2). Env var `API_SECRET_KEY`.
- Produces: `export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void>` — contrato HTTP completo del spec (200/400/401/404/502).

- [ ] **Step 1: Escribir tests que fallan (`tests/price-endpoint.test.ts`)**

Se mockea el módulo del provider para no tocar la red. `makeReq`/`makeRes` simulan los objetos de Vercel.

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { ProviderError } from '../lib/types';

const getPriceMock = vi.fn();

vi.mock('../lib/providers/intcomex', () => ({
  intcomex: {
    name: 'intcomex',
    getPrice: (query: unknown) => getPriceMock(query),
  },
}));

const { default: handler } = await import('../api/price');

function makeReq(
  query: Record<string, string | string[]>,
  headers: Record<string, string> = {},
): VercelRequest {
  return { query, headers } as unknown as VercelRequest;
}

function makeRes(): VercelResponse & { statusCode: number; body: unknown } {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res as unknown as VercelResponse & { statusCode: number; body: unknown };
}

const AUTH = { 'x-api-key': 'test-secret' };

describe('GET /api/price', () => {
  beforeEach(() => {
    vi.stubEnv('API_SECRET_KEY', 'test-secret');
    getPriceMock.mockReset();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('returns 401 without x-api-key', async () => {
    const res = makeRes();
    await handler(makeReq({ sku: 'X' }), res);
    expect(res.statusCode).toBe(401);
    expect(res.body).toMatchObject({ error: 'unauthorized' });
  });

  it('returns 401 with wrong x-api-key', async () => {
    const res = makeRes();
    await handler(makeReq({ sku: 'X' }, { 'x-api-key': 'nope' }), res);
    expect(res.statusCode).toBe(401);
  });

  it('returns 400 when no identifier is given', async () => {
    const res = makeRes();
    await handler(makeReq({}, AUTH), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request' });
  });

  it('returns 400 when more than one identifier is given', async () => {
    const res = makeRes();
    await handler(makeReq({ sku: 'X', mpn: 'Y' }, AUTH), res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 400 for an unknown provider', async () => {
    const res = makeRes();
    await handler(makeReq({ sku: 'X', provider: 'nadie' }, AUTH), res);
    expect(res.statusCode).toBe(400);
  });

  it('returns 200 with the provider result', async () => {
    const result = {
      provider: 'intcomex',
      sku: 'SE001MSE01',
      mpn: 'AAA-01148',
      description: 'Microsoft Access 2013',
      price: 103.5294,
      currency: 'US',
      inStock: 203,
    };
    getPriceMock.mockResolvedValue(result);

    const res = makeRes();
    await handler(makeReq({ mpn: 'AAA-01148' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(result);
    expect(getPriceMock).toHaveBeenCalledWith({ sku: undefined, mpn: 'AAA-01148', upc: undefined });
  });

  it('maps ProviderError not_found to 404', async () => {
    getPriceMock.mockRejectedValue(new ProviderError('not_found', 'Product not found at Intcomex'));
    const res = makeRes();
    await handler(makeReq({ sku: 'NOPE' }, AUTH), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found' });
  });

  it('maps ProviderError upstream to 502', async () => {
    getPriceMock.mockRejectedValue(new ProviderError('upstream', 'Intcomex responded with HTTP 500'));
    const res = makeRes();
    await handler(makeReq({ sku: 'X' }, AUTH), res);
    expect(res.statusCode).toBe(502);
    expect(res.body).toMatchObject({ error: 'upstream' });
  });

  it('maps unexpected errors to 502 without leaking details', async () => {
    getPriceMock.mockRejectedValue(new Error('ECONNRESET at secret-host'));
    const res = makeRes();
    await handler(makeReq({ sku: 'X' }, AUTH), res);
    expect(res.statusCode).toBe(502);
    expect(JSON.stringify(res.body)).not.toContain('secret-host');
  });
});
```

- [ ] **Step 2: Verificar que fallan**

Run: `npx vitest run tests/price-endpoint.test.ts`
Expected: FAIL — no existe `api/price.ts`.

- [ ] **Step 3: Implementar `api/price.ts`**

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '../lib/auth';
import { intcomex } from '../lib/providers/intcomex';
import type { Provider } from '../lib/types';
import { ProviderError } from '../lib/types';

const providers: Record<string, Provider> = {
  intcomex,
};

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const apiKeyHeader = firstString(req.headers['x-api-key']);
  if (!isAuthorized(apiKeyHeader, process.env.API_SECRET_KEY)) {
    res.status(401).json({ error: 'unauthorized', detail: 'Missing or invalid x-api-key header' });
    return;
  }

  const sku = firstString(req.query.sku);
  const mpn = firstString(req.query.mpn);
  const upc = firstString(req.query.upc);
  const identifiers = [sku, mpn, upc].filter(Boolean);
  if (identifiers.length !== 1) {
    res.status(400).json({
      error: 'bad_request',
      detail: 'Provide exactly one of: sku, mpn, upc',
    });
    return;
  }

  const providerName = firstString(req.query.provider) ?? 'intcomex';
  const provider = providers[providerName];
  if (!provider) {
    res.status(400).json({
      error: 'bad_request',
      detail: `Unknown provider '${providerName}'. Available: ${Object.keys(providers).join(', ')}`,
    });
    return;
  }

  try {
    const result = await provider.getPrice({ sku, mpn, upc });
    res.status(200).json(result);
  } catch (error) {
    if (error instanceof ProviderError) {
      const status = error.kind === 'not_found' ? 404 : 502;
      res.status(status).json({ error: error.kind, detail: error.message });
      return;
    }
    res.status(502).json({ error: 'upstream', detail: 'Unexpected error calling provider' });
  }
}
```

- [ ] **Step 4: Verificar que pasan**

Run: `npx vitest run tests/price-endpoint.test.ts`
Expected: PASS (9 tests).

- [ ] **Step 5: Correr toda la suite + typecheck**

Run: `npm test` y `npm run typecheck`
Expected: todo PASS, exit 0.

- [ ] **Step 6: Commit**

```bash
git add api/price.ts tests/price-endpoint.test.ts
git commit -m "feat: add GET /api/price endpoint"
```

---

### Task 6: Smoke script, README y push

**Files:**
- Create: `scripts/check.ts`
- Create: `README.md`

**Interfaces:**
- Consumes: `intcomex` (Task 3). `.env.local` con credenciales reales (el usuario lo crea a mano a partir de `.env.example`).
- Produces: `npm run check -- <SKU|mpn:<MPN>|upc:<UPC>>` imprime el `PriceResult` real desde el entorno test de IWS. README con uso y deploy.

- [ ] **Step 1: Crear `scripts/check.ts`**

```ts
import { intcomex } from '../lib/providers/intcomex';

const raw = process.argv[2];
if (!raw) {
  console.error('Usage: npm run check -- <SKU>  |  mpn:<MPN>  |  upc:<UPC>');
  process.exit(1);
}

const query = raw.startsWith('mpn:')
  ? { mpn: raw.slice(4) }
  : raw.startsWith('upc:')
    ? { upc: raw.slice(4) }
    : { sku: raw };

try {
  const result = await intcomex.getPrice(query);
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error('FAILED:', error);
  process.exit(1);
}
```

- [ ] **Step 2: Verificar typecheck**

Run: `npm run typecheck`
Expected: exit 0.

- [ ] **Step 3: Smoke test manual (solo si existe `.env.local` con credenciales reales)**

Run: `npm run check -- <un SKU real del catálogo>`
Expected: imprime JSON con `price` numérico. Si no hay `.env.local`, saltar este paso y dejarlo anotado para el usuario.

- [ ] **Step 4: Crear `README.md`**

````markdown
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
````

- [ ] **Step 5: Suite completa final**

Run: `npm test` y `npm run typecheck`
Expected: todo PASS.

- [ ] **Step 6: Commit y push**

```bash
git add scripts/check.ts README.md
git commit -m "feat: add smoke-check script and README"
git push -u origin main
```

---

## Post-implementación (manual, con el usuario)

1. Crear `.env.local` con las credenciales reales de desarrollo y correr `npm run check -- <SKU>` para validar la firma de punta a punta.
2. `vercel link` + cargar las 4 variables de entorno en Vercel (Preview con credenciales dev, Production con credenciales prod).
3. Deploy preview y probar `GET /api/price` con `curl`.
4. Deploy a producción.
