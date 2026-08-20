# Comparación de precios entre proveedores — Plan de implementación

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Que `GET /api/mejor-precio` devuelva el precio más bajo entre todos los proveedores registrados para un producto dado, diciendo explícitamente a quién no pudo consultar.

**Architecture:** Un módulo nuevo `lib/comparador.ts` resuelve el producto contra los catálogos en memoria usando `claveUnion`, cotiza en paralelo a cada proveedor que lo tenga y elige el más barato con stock. No menciona ningún proveedor por nombre: recorre el registro `PROVEEDORES`, que recibe por parámetro para poder testearlo con proveedores de mentira. Encima va una fábrica de handler en `lib/handlers/mejor-precio.ts` y un envoltorio en `api/mejor-precio.ts`, siguiendo el patrón que ya usan los otros cuatro endpoints.

**Tech Stack:** TypeScript ESM sobre Node ≥20, vitest, `@vercel/node`. Sin dependencias nuevas.

**Spec:** `docs/superpowers/specs/2026-08-20-mejor-precio-design.md`

## Global Constraints

- **Ninguna aserción de contrato de los endpoints existentes puede cambiar.** `/api/price`, `/api/search`, `/api/product`, `/api/facetas` y sus variantes por proveedor responden hoy exactamente lo mismo que después de este plan. Si un test de `tests/contrato-errores.test.ts`, `tests/search-endpoint.test.ts` o `tests/product-endpoint.test.ts` falla, es una regresión real.
- La suite arranca en **469 tests en verde**. `npm test` y `npm run typecheck` deben quedar en verde al final de cada tarea.
- Español para nombres de dominio (`comparar`, `oferta`, `proveedor`) y comentarios; inglés donde el código ya lo usa (`getPrecios`, `PriceInfo`). Seguir el estilo del archivo que se toca.
- Los comentarios explican **por qué**, no qué.
- `lib/comparador.ts` **no puede importar** `./providers/intcomex.js`, `./providers/tecnoglobal.js` ni `./providers/ingram.js`. Solo el registro. Un test lo verifica.
- Commit por tarea, no por paso.

---

### Task 1: El comparador — cotizar y elegir

**Files:**
- Create: `lib/comparador.ts`
- Test: `tests/comparador.test.ts` (crear)

**Interfaces:**
- Consumes: `Proveedor` y `PriceInfo` de `lib/types.js`, `ProductoNormalizado` y `claveUnion` de `lib/producto.js`, `obtenerCatalogo` y `CatalogUnavailableError` de `lib/catalog.js`, `PROVEEDORES` de `lib/providers/index.js`.
- Produces, desde `lib/comparador.js`:
  - `interface Oferta { proveedor: string; sku: string; precio: number; moneda: string; stock: number | null }`
  - `type Criterio = 'mas_barato_con_stock' | 'mas_barato_sin_stock'`
  - `interface OfertaGanadora extends Oferta { criterio: Criterio }`
  - `interface ProveedorAusente { proveedor: string; error: 'catalogo_no_disponible' | 'proveedor_no_configurado' | 'sin_precio' | 'upstream'; detail: string }`
  - `interface Comparacion { clave: string; mpn: string | null; marca: string | null; nombre: string | null; mejor: OfertaGanadora | null; ofertas: Oferta[]; incompleta: ProveedorAusente[] }`
  - `compararPorClave(clave: string, registro?: Record<string, Proveedor>): Promise<Comparacion>`

**Nota sobre el spec:** el spec declara `Promise<Comparacion | null>`. Devolver siempre una `Comparacion`, con `mejor: null` cuando no hubo ofertas, conserva `incompleta` en ese caso — que es justo lo que el consumidor necesita para distinguir "nadie lo vende" de "no pudimos preguntarle a nadie". El handler de la Task 3 decide el status según `mejor`.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `tests/comparador.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { compararPorClave } from '../lib/comparador.js';
import type { ProductoNormalizado } from '../lib/producto.js';
import type { PriceInfo, Proveedor } from '../lib/types.js';
import { ProviderError } from '../lib/types.js';

const catalogos = new Map<string, ProductoNormalizado[]>();

vi.mock('../lib/catalog.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/catalog.js')>('../lib/catalog.js');
  return {
    ...actual,
    obtenerCatalogo: (proveedor: string) => {
      const c = catalogos.get(proveedor);
      if (!c) throw new actual.CatalogUnavailableError();
      return c;
    },
  };
});

function producto(campos: Partial<ProductoNormalizado>): ProductoNormalizado {
  return {
    sku: 'SKU',
    mpn: 'MPN1',
    nombre: 'Producto de prueba',
    marca: 'HP',
    categoria: null,
    subcategorias: [],
    tipo: null,
    ...campos,
  };
}

/** Proveedor de mentira: el comparador no debe saber de ninguno en particular. */
function proveedorFalso(
  nombre: string,
  precios: Record<string, PriceInfo>,
  opciones: { configurado?: boolean; falla?: Error } = {},
): Proveedor {
  return {
    nombre,
    maxSkusPorLote: 50,
    estaConfigurado: () => opciones.configurado ?? true,
    cargarCatalogo: async () => [],
    getPrecios: async (skus: string[]) => {
      if (opciones.falla) throw opciones.falla;
      const m = new Map<string, PriceInfo>();
      for (const sku of skus) if (precios[sku]) m.set(sku, precios[sku]);
      return m;
    },
    getPrecio: async () => {
      throw new Error('no usado');
    },
  };
}

const CLAVE = 'mpn1|hp';

beforeEach(() => {
  catalogos.clear();
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('compararPorClave', () => {
  it('devuelve las ofertas ordenadas por precio', async () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    catalogos.set('b', [producto({ sku: 'B1' })]);
    const registro = {
      a: proveedorFalso('a', { A1: { price: 130, currency: 'USD', inStock: 5 } }),
      b: proveedorFalso('b', { B1: { price: 120, currency: 'USD', inStock: 2 } }),
    };

    const r = await compararPorClave(CLAVE, registro);

    expect(r.ofertas.map((o) => o.proveedor)).toEqual(['b', 'a']);
    expect(r.mejor).toMatchObject({ proveedor: 'b', precio: 120, criterio: 'mas_barato_con_stock' });
    expect(r.incompleta).toEqual([]);
  });

  // Cotizar el mas barato sin stock es cotizar algo que no se puede entregar.
  it('prefiere el mas barato CON stock aunque haya uno mas barato sin stock', async () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    catalogos.set('b', [producto({ sku: 'B1' })]);
    const registro = {
      a: proveedorFalso('a', { A1: { price: 130, currency: 'USD', inStock: 5 } }),
      b: proveedorFalso('b', { B1: { price: 100, currency: 'USD', inStock: 0 } }),
    };

    const r = await compararPorClave(CLAVE, registro);

    expect(r.mejor).toMatchObject({ proveedor: 'a', precio: 130, criterio: 'mas_barato_con_stock' });
    // La oferta sin stock igual se informa: el agente puede querer encargarla.
    expect(r.ofertas.map((o) => o.proveedor)).toEqual(['b', 'a']);
  });

  it('sin stock en ninguno, elige el mas barato y lo marca', async () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    catalogos.set('b', [producto({ sku: 'B1' })]);
    const registro = {
      a: proveedorFalso('a', { A1: { price: 130, currency: 'USD', inStock: 0 } }),
      b: proveedorFalso('b', { B1: { price: 100, currency: 'USD', inStock: null } }),
    };

    const r = await compararPorClave(CLAVE, registro);

    expect(r.mejor).toMatchObject({ proveedor: 'b', precio: 100, criterio: 'mas_barato_sin_stock' });
  });

  // Los tres proveedores cortan por cuota o se caen seguido: exigirlos a todos
  // dejaria al agente sin comparacion la mitad del tiempo.
  it('un proveedor que falla al cotizar no cancela la comparacion', async () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    catalogos.set('b', [producto({ sku: 'B1' })]);
    const registro = {
      a: proveedorFalso('a', { A1: { price: 130, currency: 'USD', inStock: 5 } }),
      b: proveedorFalso('b', {}, { falla: new ProviderError('upstream', 'se cayo') }),
    };

    const r = await compararPorClave(CLAVE, registro);

    expect(r.mejor).toMatchObject({ proveedor: 'a' });
    expect(r.incompleta).toEqual([
      { proveedor: 'b', error: 'upstream', detail: expect.stringContaining('se cayo') },
    ]);
  });

  it('un proveedor sin catalogo cargado aparece en incompleta', async () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    const registro = {
      a: proveedorFalso('a', { A1: { price: 130, currency: 'USD', inStock: 5 } }),
      b: proveedorFalso('b', {}),
    };

    const r = await compararPorClave(CLAVE, registro);

    expect(r.incompleta).toEqual([
      { proveedor: 'b', error: 'catalogo_no_disponible', detail: expect.any(String) },
    ]);
  });

  it('un proveedor sin credenciales aparece en incompleta y no se le pregunta', async () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    const sinLlaves = proveedorFalso('b', {}, { configurado: false });
    const espia = vi.spyOn(sinLlaves, 'getPrecios');
    const registro = {
      a: proveedorFalso('a', { A1: { price: 130, currency: 'USD', inStock: 5 } }),
      b: sinLlaves,
    };

    const r = await compararPorClave(CLAVE, registro);

    expect(r.incompleta[0]).toMatchObject({ proveedor: 'b', error: 'proveedor_no_configurado' });
    expect(espia).not.toHaveBeenCalled();
  });

  it('un proveedor que tiene el producto pero no entrega precio aparece en incompleta', async () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    catalogos.set('b', [producto({ sku: 'B1' })]);
    const registro = {
      a: proveedorFalso('a', { A1: { price: 130, currency: 'USD', inStock: 5 } }),
      b: proveedorFalso('b', {}),
    };

    const r = await compararPorClave(CLAVE, registro);

    expect(r.incompleta).toEqual([
      { proveedor: 'b', error: 'sin_precio', detail: expect.any(String) },
    ]);
  });

  // Que un proveedor no venda el producto es una respuesta definitiva, no un
  // hueco: su catalogo se reviso. Meterlo en incompleta seria mentir.
  it('un proveedor que no vende el producto no aparece en ningun lado', async () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    catalogos.set('b', [producto({ sku: 'B9', mpn: 'OTRO', marca: 'Dell' })]);
    const registro = {
      a: proveedorFalso('a', { A1: { price: 130, currency: 'USD', inStock: 5 } }),
      b: proveedorFalso('b', { B9: { price: 10, currency: 'USD', inStock: 1 } }),
    };

    const r = await compararPorClave(CLAVE, registro);

    expect(r.ofertas.map((o) => o.proveedor)).toEqual(['a']);
    expect(r.incompleta).toEqual([]);
  });

  it('sin ninguna oferta devuelve mejor en null pero conserva incompleta', async () => {
    const registro = { a: proveedorFalso('a', {}) };

    const r = await compararPorClave(CLAVE, registro);

    expect(r.mejor).toBeNull();
    expect(r.ofertas).toEqual([]);
    expect(r.incompleta[0]).toMatchObject({ error: 'catalogo_no_disponible' });
  });

  // Duplicados del propio catalogo, no ofertas distintas.
  it('con varios productos del mismo proveedor bajo la misma clave, gana el mas barato de ese proveedor', async () => {
    catalogos.set('a', [producto({ sku: 'A1' }), producto({ sku: 'A2' })]);
    const registro = {
      a: proveedorFalso('a', {
        A1: { price: 130, currency: 'USD', inStock: 5 },
        A2: { price: 110, currency: 'USD', inStock: 5 },
      }),
    };

    const r = await compararPorClave(CLAVE, registro);

    expect(r.ofertas).toHaveLength(1);
    expect(r.ofertas[0]).toMatchObject({ sku: 'A2', precio: 110 });
  });

  it('describe el producto con los datos del catalogo', async () => {
    catalogos.set('a', [producto({ sku: 'A1', mpn: 'MPN1', marca: 'HP', nombre: 'Notebook HP' })]);
    const registro = { a: proveedorFalso('a', { A1: { price: 1, currency: 'USD', inStock: 1 } }) };

    const r = await compararPorClave(CLAVE, registro);

    expect(r).toMatchObject({ clave: CLAVE, mpn: 'MPN1', marca: 'HP', nombre: 'Notebook HP' });
  });

  // El requisito de extensibilidad: un proveedor nuevo entra sin tocar el modulo.
  it('incluye a un proveedor recien registrado sin cambiarle una linea al comparador', async () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    catalogos.set('nuevo', [producto({ sku: 'N1' })]);
    const registro = {
      a: proveedorFalso('a', { A1: { price: 130, currency: 'USD', inStock: 5 } }),
      nuevo: proveedorFalso('nuevo', { N1: { price: 90, currency: 'USD', inStock: 3 } }),
    };

    const r = await compararPorClave(CLAVE, registro);

    expect(r.mejor).toMatchObject({ proveedor: 'nuevo', precio: 90 });
  });

  it('no le pide mas SKUs de los que el proveedor acepta por lote', async () => {
    const muchos = Array.from({ length: 60 }, (_, i) => producto({ sku: `A${i}` }));
    catalogos.set('a', muchos);
    const proveedor = proveedorFalso('a', { A0: { price: 5, currency: 'USD', inStock: 1 } });
    proveedor.maxSkusPorLote = 10;
    const espia = vi.spyOn(proveedor, 'getPrecios');

    await compararPorClave(CLAVE, { a: proveedor });

    expect(espia.mock.calls[0][0]).toHaveLength(10);
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/comparador.test.ts`
Expected: FAIL — `Cannot find module '../lib/comparador.js'`.

- [ ] **Step 3: Implementar `lib/comparador.ts`**

```ts
import { CatalogUnavailableError, obtenerCatalogo } from './catalog.js';
import { claveUnion, type ProductoNormalizado } from './producto.js';
import { PROVEEDORES } from './providers/index.js';
import type { PriceInfo, Proveedor } from './types.js';

export interface Oferta {
  proveedor: string;
  sku: string;
  precio: number;
  moneda: string;
  stock: number | null;
}

export type Criterio = 'mas_barato_con_stock' | 'mas_barato_sin_stock';

export interface OfertaGanadora extends Oferta {
  criterio: Criterio;
}

export interface ProveedorAusente {
  proveedor: string;
  error: 'catalogo_no_disponible' | 'proveedor_no_configurado' | 'sin_precio' | 'upstream';
  detail: string;
}

export interface Comparacion {
  clave: string;
  mpn: string | null;
  marca: string | null;
  nombre: string | null;
  /** null cuando ningun proveedor entrego una oferta. */
  mejor: OfertaGanadora | null;
  ofertas: Oferta[];
  incompleta: ProveedorAusente[];
}

/**
 * Gana el mas barato CON stock: cotizar el mas barato sin stock es cotizar algo
 * que no se puede entregar. Si ninguno tiene, gana el mas barato igual pero
 * marcado, para que el consumidor sepa que el ganador no sale hoy.
 */
function elegirMejor(ofertas: Oferta[]): OfertaGanadora | null {
  if (ofertas.length === 0) return null;
  const conStock = ofertas.filter((o) => (o.stock ?? 0) > 0);
  const candidatas = conStock.length > 0 ? conStock : ofertas;
  const ganadora = candidatas.reduce((a, b) => (b.precio < a.precio ? b : a));
  return {
    ...ganadora,
    criterio: conStock.length > 0 ? 'mas_barato_con_stock' : 'mas_barato_sin_stock',
  };
}

function masBarata(proveedor: string, precios: Map<string, PriceInfo>): Oferta | null {
  let mejor: Oferta | null = null;
  for (const [sku, precio] of precios) {
    if (!mejor || precio.price < mejor.precio) {
      mejor = {
        proveedor,
        sku,
        precio: precio.price,
        moneda: precio.currency,
        stock: precio.inStock,
      };
    }
  }
  return mejor;
}

async function cotizar(
  proveedor: Proveedor,
  productos: ProductoNormalizado[],
): Promise<Oferta | ProveedorAusente> {
  // Varios productos con la misma clave son duplicados del propio catalogo del
  // proveedor, no ofertas distintas: se piden juntos y gana el mas barato.
  const skus = productos.slice(0, proveedor.maxSkusPorLote).map((p) => p.sku);

  try {
    const oferta = masBarata(proveedor.nombre, await proveedor.getPrecios(skus));
    if (oferta) return oferta;
    return {
      proveedor: proveedor.nombre,
      error: 'sin_precio',
      detail: 'Tiene el producto en catalogo pero no entrego precio',
    };
  } catch (error) {
    return {
      proveedor: proveedor.nombre,
      error: 'upstream',
      detail: error instanceof Error ? error.message : 'Error inesperado al cotizar',
    };
  }
}

function esAusente(r: Oferta | ProveedorAusente): r is ProveedorAusente {
  return 'error' in r;
}

/**
 * Compara el mismo producto entre todos los proveedores del registro.
 *
 * No nombra a ninguno: recorre lo que le pasen, con PROVEEDORES por defecto.
 * Agregar un proveedor nuevo no toca este modulo.
 */
export async function compararPorClave(
  clave: string,
  registro: Record<string, Proveedor> = PROVEEDORES,
): Promise<Comparacion> {
  const incompleta: ProveedorAusente[] = [];
  const conElProducto: { proveedor: Proveedor; productos: ProductoNormalizado[] }[] = [];
  let descripcion: ProductoNormalizado | null = null;

  for (const proveedor of Object.values(registro)) {
    if (!proveedor.estaConfigurado()) {
      incompleta.push({
        proveedor: proveedor.nombre,
        error: 'proveedor_no_configurado',
        detail: `El proveedor '${proveedor.nombre}' no tiene credenciales configuradas`,
      });
      continue;
    }

    let catalogo: ProductoNormalizado[];
    try {
      catalogo = obtenerCatalogo(proveedor.nombre);
    } catch (error) {
      if (!(error instanceof CatalogUnavailableError)) throw error;
      incompleta.push({
        proveedor: proveedor.nombre,
        error: 'catalogo_no_disponible',
        detail: `El catalogo de '${proveedor.nombre}' aun no esta disponible`,
      });
      continue;
    }

    const suyos = catalogo.filter((p) => claveUnion(p) === clave);
    // Que no lo venda es una respuesta definitiva, no un hueco: su catalogo se
    // reviso. Solo se omite.
    if (suyos.length === 0) continue;

    descripcion ??= suyos[0];
    conElProducto.push({ proveedor, productos: suyos });
  }

  const resultados = await Promise.all(
    conElProducto.map(({ proveedor, productos }) => cotizar(proveedor, productos)),
  );

  const ofertas: Oferta[] = [];
  for (const r of resultados) {
    if (esAusente(r)) incompleta.push(r);
    else ofertas.push(r);
  }
  ofertas.sort((a, b) => a.precio - b.precio);

  return {
    clave,
    mpn: descripcion?.mpn ?? null,
    marca: descripcion?.marca ?? null,
    nombre: descripcion?.nombre ?? null,
    mejor: elegirMejor(ofertas),
    ofertas,
    incompleta,
  };
}
```

- [ ] **Step 4: Correr los tests**

Run: `npx vitest run tests/comparador.test.ts`
Expected: PASS, 13 tests.

- [ ] **Step 5: Suite completa y typecheck**

Run: `npm test && npm run typecheck`
Expected: verde, 482 tests.

- [ ] **Step 6: Commit**

```bash
git add lib/comparador.ts tests/comparador.test.ts
git commit -m "feat: comparador de precios agnostico de proveedores"
```

---

### Task 2: Resolver el producto desde un identificador

**Files:**
- Modify: `lib/comparador.ts`
- Test: `tests/comparador.test.ts`

**Interfaces:**
- Consumes: `compactarMpn`, `marcaCanonica` y `claveUnion` de `lib/producto.js`.
- Produces, desde `lib/comparador.js`:
  - `resolverClaves(mpn: string, marca?: string, registro?: Record<string, Proveedor>): string[]`
  - `type ResolucionSku = { estado: 'ok'; clave: string } | { estado: 'catalogo_no_disponible' } | { estado: 'sku_desconocido' } | { estado: 'no_comparable' }`
  - `claveDeSku(proveedor: string, sku: string): ResolucionSku`
  - `hayAlgunCatalogo(registro?: Record<string, Proveedor>): boolean`

`claveDeSku` devuelve un estado y no `string | null` porque el handler tiene que distinguir tres fracasos que son tres respuestas HTTP distintas: catálogo sin cargar (503), SKU inexistente (404) y producto sin clave de unión (409).

- [ ] **Step 1: Escribir los tests que fallan**

Agregar al final de `tests/comparador.test.ts`:

```ts
describe('resolverClaves', () => {
  it('encuentra la clave de un MPN presente en los catalogos', () => {
    catalogos.set('a', [producto({ sku: 'A1', mpn: '2N6G5LT#ABM', marca: 'HP' })]);

    expect(resolverClaves('2n6g5lt-abm', undefined, { a: proveedorFalso('a', {}) })).toEqual([
      '2n6g5ltabm|hp',
    ]);
  });

  it('devuelve vacio si ningun proveedor lo tiene', () => {
    catalogos.set('a', [producto({ sku: 'A1', mpn: 'OTRO', marca: 'HP' })]);

    expect(resolverClaves('NOEXISTE', undefined, { a: proveedorFalso('a', {}) })).toEqual([]);
  });

  it('junta la misma clave aunque cada proveedor escriba la marca distinto', () => {
    catalogos.set('a', [producto({ sku: 'A1', mpn: 'BVG700I-MSX', marca: 'APC' })]);
    catalogos.set('b', [producto({ sku: 'B1', mpn: 'BVG700IMSX', marca: 'AMERICAN POWER' })]);

    const claves = resolverClaves('BVG700I-MSX', undefined, {
      a: proveedorFalso('a', {}),
      b: proveedorFalso('b', {}),
    });

    expect(claves).toHaveLength(1);
  });

  // El caso 98PT0G1299: un MPN bajo tres marcas. Elegir por el consumidor
  // seria cotizarle un producto que no pidio.
  it('devuelve una clave por cada marca cuando el MPN colisiona', () => {
    catalogos.set('a', [
      producto({ sku: 'A1', mpn: '98PT0G1299', marca: 'Trendnet' }),
      producto({ sku: 'A2', mpn: '98PT0G1299', marca: 'MSI' }),
    ]);

    expect(resolverClaves('98PT0G1299', undefined, { a: proveedorFalso('a', {}) })).toHaveLength(2);
  });

  it('la marca desambigua y deja una sola clave', () => {
    catalogos.set('a', [
      producto({ sku: 'A1', mpn: '98PT0G1299', marca: 'Trendnet' }),
      producto({ sku: 'A2', mpn: '98PT0G1299', marca: 'MSI' }),
    ]);

    expect(resolverClaves('98PT0G1299', 'MSI', { a: proveedorFalso('a', {}) })).toEqual([
      '98pt0g1299|msi',
    ]);
  });

  it('ignora los catalogos que no estan cargados en vez de fallar', () => {
    catalogos.set('a', [producto({ sku: 'A1', mpn: 'MPN1', marca: 'HP' })]);

    const claves = resolverClaves('MPN1', undefined, {
      a: proveedorFalso('a', {}),
      b: proveedorFalso('b', {}),
    });

    expect(claves).toEqual(['mpn1|hp']);
  });

  it('devuelve vacio para un MPN sin caracteres utiles', () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);

    expect(resolverClaves('---', undefined, { a: proveedorFalso('a', {}) })).toEqual([]);
  });
});

describe('claveDeSku', () => {
  it('devuelve la clave del producto que ese proveedor identifica con el SKU', () => {
    catalogos.set('a', [producto({ sku: 'A1', mpn: 'MPN1', marca: 'HP' })]);

    expect(claveDeSku('a', 'A1')).toEqual({ estado: 'ok', clave: 'mpn1|hp' });
  });

  it('distingue el catalogo sin cargar', () => {
    expect(claveDeSku('a', 'A1')).toEqual({ estado: 'catalogo_no_disponible' });
  });

  it('distingue el SKU que ese proveedor no conoce', () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);

    expect(claveDeSku('a', 'NOEXISTE')).toEqual({ estado: 'sku_desconocido' });
  });

  // Sin MPN o sin marca el producto no se puede comparar. Decirlo es mejor que
  // un 404, que sugiere que el producto no existe.
  it('distingue el producto que no tiene clave de union', () => {
    catalogos.set('a', [producto({ sku: 'A1', mpn: null })]);

    expect(claveDeSku('a', 'A1')).toEqual({ estado: 'no_comparable' });
  });
});

describe('hayAlgunCatalogo', () => {
  it('es false cuando ningun proveedor cargo su catalogo', () => {
    expect(hayAlgunCatalogo({ a: proveedorFalso('a', {}) })).toBe(false);
  });

  it('es true con que uno lo tenga', () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);

    expect(hayAlgunCatalogo({ a: proveedorFalso('a', {}), b: proveedorFalso('b', {}) })).toBe(true);
  });
});
```

Y cambiar el import del principio del archivo:

```ts
import {
  claveDeSku,
  compararPorClave,
  hayAlgunCatalogo,
  resolverClaves,
} from '../lib/comparador.js';
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/comparador.test.ts`
Expected: FAIL — `resolverClaves is not a function`.

- [ ] **Step 3: Implementar**

En `lib/comparador.ts`, cambiar el import de `./producto.js` a:

```ts
import {
  claveUnion,
  compactarMpn,
  marcaCanonica,
  type ProductoNormalizado,
} from './producto.js';
```

Y agregar al final del archivo:

```ts
function catalogoDe(proveedor: string): ProductoNormalizado[] | null {
  try {
    return obtenerCatalogo(proveedor);
  } catch (error) {
    if (error instanceof CatalogUnavailableError) return null;
    throw error;
  }
}

/**
 * Claves de union que un MPN produce en los catalogos cargados.
 *
 * Devuelve mas de una cuando el mismo part number existe bajo marcas distintas
 * —raro, una sola vez en los 10.411 productos de Intcomex, pero real—. El
 * llamador tiene que pedir desambiguacion en vez de elegir por el consumidor.
 */
export function resolverClaves(
  mpn: string,
  marca?: string,
  registro: Record<string, Proveedor> = PROVEEDORES,
): string[] {
  const compacto = compactarMpn(mpn);
  if (!compacto) return [];

  const filtro = marca ? marcaCanonica(marca) : null;
  const claves = new Set<string>();

  for (const nombre of Object.keys(registro)) {
    for (const p of catalogoDe(nombre) ?? []) {
      if (compactarMpn(p.mpn) !== compacto) continue;
      if (filtro && marcaCanonica(p.marca) !== filtro) continue;
      const clave = claveUnion(p);
      if (clave) claves.add(clave);
    }
  }
  return [...claves].sort();
}

export type ResolucionSku =
  | { estado: 'ok'; clave: string }
  | { estado: 'catalogo_no_disponible' }
  | { estado: 'sku_desconocido' }
  | { estado: 'no_comparable' };

/**
 * Clave de union del producto que un proveedor identifica con ese SKU.
 *
 * Devuelve un estado y no un string nulo porque los tres fracasos son tres
 * respuestas HTTP distintas.
 */
export function claveDeSku(proveedor: string, sku: string): ResolucionSku {
  const catalogo = catalogoDe(proveedor);
  if (!catalogo) return { estado: 'catalogo_no_disponible' };

  const producto = catalogo.find((p) => p.sku === sku);
  if (!producto) return { estado: 'sku_desconocido' };

  const clave = claveUnion(producto);
  return clave ? { estado: 'ok', clave } : { estado: 'no_comparable' };
}

export function hayAlgunCatalogo(
  registro: Record<string, Proveedor> = PROVEEDORES,
): boolean {
  return Object.keys(registro).some((nombre) => catalogoDe(nombre) !== null);
}
```

- [ ] **Step 4: Correr los tests**

Run: `npx vitest run tests/comparador.test.ts`
Expected: PASS, 26 tests.

- [ ] **Step 5: Verificar que el comparador no conoce a ningun proveedor**

Run: `grep -nE "intcomex|tecnoglobal|ingram" lib/comparador.ts`
Expected: sin resultados. Es el requisito de extensibilidad: el modulo solo conoce el registro.

- [ ] **Step 6: Suite completa y typecheck**

Run: `npm test && npm run typecheck`
Expected: verde, 495 tests.

- [ ] **Step 7: Commit**

```bash
git add lib/comparador.ts tests/comparador.test.ts
git commit -m "feat: resolver el producto a comparar desde mpn o proveedor+sku"
```

---

### Task 3: El endpoint `/api/mejor-precio`

**Files:**
- Create: `lib/handlers/mejor-precio.ts`, `api/mejor-precio.ts`
- Test: `tests/mejor-precio-endpoint.test.ts` (crear)

**Interfaces:**
- Consumes: `compararPorClave`, `resolverClaves`, `claveDeSku`, `hayAlgunCatalogo` de `lib/comparador.js`; `resolverOResponder` de `lib/handlers/guardas.js`; `isAuthorized` de `lib/auth.js`; `firstString` y `Handler` de `lib/handlers/tipos.js`.
- Produces: `crearHandlerMejorPrecio(): Handler` desde `lib/handlers/mejor-precio.js`, y el default export de `api/mejor-precio.ts`.

- [ ] **Step 1: Escribir los tests que fallan**

Crear `tests/mejor-precio-endpoint.test.ts`:

```ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';

const compararMock = vi.fn();
const resolverClavesMock = vi.fn();
const claveDeSkuMock = vi.fn();
const hayAlgunCatalogoMock = vi.fn();

vi.mock('../lib/comparador.js', () => ({
  compararPorClave: (...a: unknown[]) => compararMock(...a),
  resolverClaves: (...a: unknown[]) => resolverClavesMock(...a),
  claveDeSku: (...a: unknown[]) => claveDeSkuMock(...a),
  hayAlgunCatalogo: () => hayAlgunCatalogoMock(),
}));

const { default: handler } = await import('../api/mejor-precio.js');

const COMPARACION = {
  clave: 'mpn1|hp',
  mpn: 'MPN1',
  marca: 'HP',
  nombre: 'Notebook HP',
  mejor: {
    proveedor: 'ingram',
    sku: 'IM1',
    precio: 100,
    moneda: 'USD',
    stock: 4,
    criterio: 'mas_barato_con_stock',
  },
  ofertas: [{ proveedor: 'ingram', sku: 'IM1', precio: 100, moneda: 'USD', stock: 4 }],
  incompleta: [],
};

function makeReq(query: Record<string, string>, headers: Record<string, string> = {}, method = 'GET'): VercelRequest {
  return { query, headers, method } as unknown as VercelRequest;
}

function makeRes(): VercelResponse & { statusCode: number; body: any } {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(code: number) { res.statusCode = code; return res; },
    json(payload: unknown) { res.body = payload; return res; },
  };
  return res;
}

const AUTH = { 'x-api-key': 'test-secret' };

beforeEach(() => {
  vi.stubEnv('API_SECRET_KEY', 'test-secret');
  vi.stubEnv('INTCOMEX_API_KEY', 'pub');
  vi.stubEnv('INTCOMEX_ACCESS_KEY', 'secret');
  vi.stubEnv('INTCOMEX_BASE_URL', 'https://x/');
  compararMock.mockReset().mockResolvedValue(COMPARACION);
  resolverClavesMock.mockReset().mockReturnValue(['mpn1|hp']);
  claveDeSkuMock.mockReset().mockReturnValue({ estado: 'ok', clave: 'mpn1|hp' });
  hayAlgunCatalogoMock.mockReset().mockReturnValue(true);
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('GET /mejor-precio', () => {
  it('devuelve 401 sin x-api-key y no toca los catalogos', async () => {
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }), res);
    expect(res.statusCode).toBe(401);
    expect(resolverClavesMock).not.toHaveBeenCalled();
  });

  it('devuelve 405 para metodos que no son GET', async () => {
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }, AUTH, 'POST'), res);
    expect(res.statusCode).toBe(405);
  });

  it('devuelve 400 sin identificador', async () => {
    const res = makeRes();
    await handler(makeReq({}, AUTH), res);
    expect(res.statusCode).toBe(400);
    expect(res.body).toMatchObject({ error: 'bad_request' });
  });

  // Pedir por los dos caminos a la vez es ambiguo: no se adivina cual gana.
  it('devuelve 400 con mpn y proveedor+sku a la vez', async () => {
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1', proveedor: 'intcomex', sku: 'A1' }, AUTH), res);
    expect(res.statusCode).toBe(400);
  });

  it('devuelve 400 con el par proveedor+sku incompleto', async () => {
    const res = makeRes();
    await handler(makeReq({ proveedor: 'intcomex' }, AUTH), res);
    expect(res.statusCode).toBe(400);
  });

  it('devuelve la comparacion completa por mpn', async () => {
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body).toEqual(COMPARACION);
    expect(compararMock).toHaveBeenCalledWith('mpn1|hp');
  });

  it('pasa la marca a la resolucion cuando viene', async () => {
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1', marca: 'HP' }, AUTH), res);
    expect(resolverClavesMock).toHaveBeenCalledWith('MPN1', 'HP');
  });

  it('resuelve por proveedor + sku', async () => {
    const res = makeRes();
    await handler(makeReq({ proveedor: 'intcomex', sku: 'A1' }, AUTH), res);

    expect(claveDeSkuMock).toHaveBeenCalledWith('intcomex', 'A1');
    expect(res.statusCode).toBe(200);
  });

  it('devuelve 404 proveedor_desconocido para un proveedor que no existe', async () => {
    const res = makeRes();
    await handler(makeReq({ proveedor: 'nadie', sku: 'A1' }, AUTH), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'proveedor_desconocido' });
  });

  // Elegir una marca por el consumidor es cotizarle un producto que no pidio.
  it('devuelve 409 ambiguo cuando el MPN existe bajo varias marcas', async () => {
    resolverClavesMock.mockReturnValue(['98pt0g1299|trendnet', '98pt0g1299|msi']);
    const res = makeRes();
    await handler(makeReq({ mpn: '98PT0G1299' }, AUTH), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'ambiguo', marcas: ['trendnet', 'msi'] });
    expect(compararMock).not.toHaveBeenCalled();
  });

  it('devuelve 404 cuando ningun proveedor tiene ese MPN', async () => {
    resolverClavesMock.mockReturnValue([]);
    const res = makeRes();
    await handler(makeReq({ mpn: 'NOEXISTE' }, AUTH), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found' });
  });

  // Sin ningun catalogo la respuesta no es "no existe", es "todavia no se".
  it('devuelve 503 cuando no hay ningun catalogo cargado', async () => {
    resolverClavesMock.mockReturnValue([]);
    hayAlgunCatalogoMock.mockReturnValue(false);
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }, AUTH), res);

    expect(res.statusCode).toBe(503);
    expect(res.body).toMatchObject({ error: 'catalogo_no_disponible' });
  });

  it('devuelve 503 cuando el catalogo de ese proveedor no esta cargado', async () => {
    claveDeSkuMock.mockReturnValue({ estado: 'catalogo_no_disponible' });
    const res = makeRes();
    await handler(makeReq({ proveedor: 'intcomex', sku: 'A1' }, AUTH), res);
    expect(res.statusCode).toBe(503);
  });

  it('devuelve 404 para un SKU que ese proveedor no conoce', async () => {
    claveDeSkuMock.mockReturnValue({ estado: 'sku_desconocido' });
    const res = makeRes();
    await handler(makeReq({ proveedor: 'intcomex', sku: 'NOEXISTE' }, AUTH), res);
    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({ error: 'not_found' });
  });

  // Un 404 sugeriria que el producto no existe; existe, pero sin MPN o sin
  // marca no se puede comparar con nadie.
  it('devuelve 409 no_comparable para un producto sin clave de union', async () => {
    claveDeSkuMock.mockReturnValue({ estado: 'no_comparable' });
    const res = makeRes();
    await handler(makeReq({ proveedor: 'intcomex', sku: 'A1' }, AUTH), res);

    expect(res.statusCode).toBe(409);
    expect(res.body).toMatchObject({ error: 'no_comparable' });
  });

  // El agente tiene que poder distinguir "nadie lo vende" de "no pudimos
  // preguntarle a nadie".
  it('devuelve 404 conservando incompleta cuando no hubo ninguna oferta', async () => {
    compararMock.mockResolvedValue({
      ...COMPARACION,
      mejor: null,
      ofertas: [],
      incompleta: [{ proveedor: 'ingram', error: 'upstream', detail: 'se cayo' }],
    });
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }, AUTH), res);

    expect(res.statusCode).toBe(404);
    expect(res.body).toMatchObject({
      error: 'not_found',
      incompleta: [{ proveedor: 'ingram', error: 'upstream' }],
    });
  });

  it('responde 200 aunque la comparacion sea parcial', async () => {
    compararMock.mockResolvedValue({
      ...COMPARACION,
      incompleta: [{ proveedor: 'tecnoglobal', error: 'upstream', detail: 'cuota' }],
    });
    const res = makeRes();
    await handler(makeReq({ mpn: 'MPN1' }, AUTH), res);

    expect(res.statusCode).toBe(200);
    expect(res.body.incompleta).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/mejor-precio-endpoint.test.ts`
Expected: FAIL — `Cannot find module '../api/mejor-precio.js'`.

- [ ] **Step 3: Implementar la fabrica del handler**

Crear `lib/handlers/mejor-precio.ts`:

```ts
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '../auth.js';
import {
  claveDeSku,
  compararPorClave,
  hayAlgunCatalogo,
  resolverClaves,
} from '../comparador.js';
import { resolverOResponder } from './guardas.js';
import { firstString, type Handler } from './tipos.js';

/** La marca que sigue al separador de la clave de union. */
function marcaDeClave(clave: string): string {
  return clave.split('|')[1] ?? clave;
}

export function crearHandlerMejorPrecio(): Handler {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method && req.method !== 'GET') {
      res.status(405).json({ error: 'method_not_allowed', detail: 'Use GET' });
      return;
    }
    if (!isAuthorized(firstString(req.headers['x-api-key']), process.env.API_SECRET_KEY)) {
      res.status(401).json({ error: 'unauthorized', detail: 'Missing or invalid x-api-key header' });
      return;
    }

    const mpn = firstString(req.query.mpn)?.trim();
    const nombreProveedor = firstString(req.query.proveedor)?.trim();
    const sku = firstString(req.query.sku)?.trim();
    const marca = firstString(req.query.marca)?.trim();

    const porMpn = Boolean(mpn);
    const porSku = Boolean(nombreProveedor || sku);
    if (porMpn === porSku) {
      res.status(400).json({
        error: 'bad_request',
        detail: 'Indica mpn, o bien el par proveedor y sku. Uno de los dos, no ambos.',
      });
      return;
    }
    if (porSku && !(nombreProveedor && sku)) {
      res.status(400).json({
        error: 'bad_request',
        detail: 'Para buscar por sku hay que indicar tambien el proveedor',
      });
      return;
    }

    let clave: string;

    if (porMpn) {
      const claves = resolverClaves(mpn!, marca);

      // Elegir una marca por el consumidor es cotizarle un producto que no
      // pidio; se le pide que acote, igual que /search con demasiado_amplio.
      if (claves.length > 1) {
        res.status(409).json({
          error: 'ambiguo',
          detail: `El MPN ${mpn} existe bajo ${claves.length} marcas. Repite la consulta con &marca=`,
          marcas: claves.map(marcaDeClave),
        });
        return;
      }
      if (claves.length === 0) {
        if (!hayAlgunCatalogo()) {
          res.status(503).json({
            error: 'catalogo_no_disponible',
            detail: 'Ningun catalogo esta disponible todavia. Reintenta mas tarde.',
          });
          return;
        }
        res.status(404).json({
          error: 'not_found',
          detail: `Ningun proveedor tiene el MPN ${mpn}`,
        });
        return;
      }
      clave = claves[0];
    } else {
      const proveedor = resolverOResponder(nombreProveedor, res);
      if (!proveedor) return;

      const resolucion = claveDeSku(proveedor.nombre, sku!);

      if (resolucion.estado === 'catalogo_no_disponible') {
        res.status(503).json({
          error: 'catalogo_no_disponible',
          detail: `El catalogo de '${proveedor.nombre}' aun no esta disponible. Reintenta mas tarde.`,
        });
        return;
      }
      if (resolucion.estado === 'sku_desconocido') {
        res.status(404).json({
          error: 'not_found',
          detail: `'${proveedor.nombre}' no tiene el SKU ${sku}`,
        });
        return;
      }
      if (resolucion.estado === 'no_comparable') {
        res.status(409).json({
          error: 'no_comparable',
          detail:
            'El producto no tiene MPN y marca, asi que no se puede comparar con otros proveedores',
        });
        return;
      }
      clave = resolucion.clave;
    }

    const comparacion = await compararPorClave(clave);

    // Sin ofertas se responde 404, pero conservando incompleta: el agente tiene
    // que poder distinguir "nadie lo vende" de "no pudimos preguntarle a nadie".
    if (!comparacion.mejor) {
      res.status(404).json({
        error: 'not_found',
        detail: 'Ningun proveedor entrego precio para este producto',
        incompleta: comparacion.incompleta,
      });
      return;
    }

    res.status(200).json({
      clave: comparacion.clave,
      mpn: comparacion.mpn,
      marca: comparacion.marca,
      nombre: comparacion.nombre,
      mejor: comparacion.mejor,
      ofertas: comparacion.ofertas,
      incompleta: comparacion.incompleta,
    });
  };
}
```

- [ ] **Step 4: Crear el envoltorio de la ruta**

Crear `api/mejor-precio.ts`:

```ts
import { crearHandlerMejorPrecio } from '../lib/handlers/mejor-precio.js';

export default crearHandlerMejorPrecio();
```

- [ ] **Step 5: Correr los tests**

Run: `npx vitest run tests/mejor-precio-endpoint.test.ts`
Expected: PASS, 17 tests.

- [ ] **Step 6: Suite completa y typecheck**

Run: `npm test && npm run typecheck`
Expected: verde. `tests/docs.test.ts` sigue pasando porque la ruta todavia no esta en `lib/server.ts`; se agrega en la Task 4.

- [ ] **Step 7: Commit**

```bash
git add lib/handlers/mejor-precio.ts api/mejor-precio.ts tests/mejor-precio-endpoint.test.ts
git commit -m "feat: endpoint /api/mejor-precio"
```

---

### Task 4: Rutear en el servidor local y sumarla al contrato de errores

**Files:**
- Modify: `lib/server.ts`, `tests/server.test.ts`, `tests/contrato-errores.test.ts`

**Interfaces:**
- Consumes: el default export de `api/mejor-precio.js` (Task 3).
- Produces: la ruta `/api/mejor-precio` (y su variante bajo `BASE_PATH`) en el servidor local.

- [ ] **Step 1: Escribir los tests que fallan**

En `tests/server.test.ts`, agregar dentro del `describe('local server adapter')`:

```ts
it('sirve /api/mejor-precio', async () => {
  const res = await fetch(`${base}/api/mejor-precio?mpn=MPN-HP1`, {
    headers: { 'x-api-key': 'test-secret' },
  });
  // El catalogo del mock tiene HP1 con MPN-HP1, asi que la ruta resuelve y
  // compara; lo que se verifica aca es que la ruta existe, no el resultado.
  expect(res.status).not.toBe(404);
});

it('devuelve 400 en /api/mejor-precio sin identificador', async () => {
  const res = await fetch(`${base}/api/mejor-precio`, {
    headers: { 'x-api-key': 'test-secret' },
  });
  expect(res.status).toBe(400);
});
```

En `tests/contrato-errores.test.ts`, agregar el import junto a los otros handlers:

```ts
const { default: mejorPrecioHandler } = await import('../api/mejor-precio.js');
```

y estas entradas al final del arreglo `CASOS`, antes del `];`:

```ts
  // --- /api/mejor-precio ---
  { nombre: 'mejor-precio sin x-api-key', handler: mejorPrecioHandler, req: makeReq({ mpn: 'X' }), status: 401, error: 'unauthorized' },
  { nombre: 'mejor-precio sin identificador', handler: mejorPrecioHandler, req: makeReq({}, AUTH), status: 400, error: 'bad_request' },
  { nombre: 'mejor-precio con metodo POST', handler: mejorPrecioHandler, req: makeReq({ mpn: 'X' }, AUTH, 'POST'), status: 405, error: 'method_not_allowed' },
```

El test `cubre los cuatro endpoints GET` de ese archivo deriva el endpoint del primer token del nombre y espera exactamente `['facetas', 'price', 'product', 'search']`. Actualizarlo:

```ts
  it('cubre los cinco endpoints GET', () => {
    const cubiertos = new Set(CASOS.map((c) => c.nombre.split(' ')[0]));
    expect([...cubiertos].sort()).toEqual(['facetas', 'mejor-precio', 'price', 'product', 'search']);
  });
```

- [ ] **Step 2: Correr y verificar que falla**

Run: `npx vitest run tests/server.test.ts`
Expected: FAIL — `/api/mejor-precio` responde 404 `Unknown route`.

- [ ] **Step 3: Agregar la ruta al servidor local**

En `lib/server.ts`, agregar el import junto a los demás de `api/`:

```ts
import mejorPrecioHandler from '../api/mejor-precio.js';
```

Agregar `'mejor-precio'` al arreglo `nombres` dentro de `rutas()`:

```ts
  const nombres = ['price', 'search', 'product', 'facetas', 'mejor-precio', 'credito/mock'];
```

Y la entrada en el objeto `handlers`:

```ts
  'mejor-precio': mejorPrecioHandler,
```

- [ ] **Step 4: Correr los tests**

Run: `npx vitest run tests/server.test.ts tests/contrato-errores.test.ts`
Expected: PASS.

- [ ] **Step 5: Suite completa**

Run: `npm test`
Expected: FALLA `tests/docs.test.ts`. Es lo esperado y es el punto: ese test deriva las rutas de `lib/server.ts` y ahora exige que `/mejor-precio` esté documentada en `docs/api/README.md` y en `openapi.yaml`. Se resuelve en la Task 5.

- [ ] **Step 6: Commit**

```bash
git add lib/server.ts tests/server.test.ts tests/contrato-errores.test.ts
git commit -m "feat: rutear /api/mejor-precio en el servidor local"
```

---

### Task 5: Documentar el endpoint

**Files:**
- Modify: `docs/api/README.md`, `docs/api/openapi.yaml`, `tests/docs.test.ts`, `README.md`

**Interfaces:**
- Consumes: la ruta y los códigos de error de las Tasks 3 y 4.
- Produces: documentación que `tests/docs.test.ts` verifica contra el código.

- [ ] **Step 1: Enseñarle al test de docs dónde vive la implementación**

En `tests/docs.test.ts`, agregar la entrada al mapa `IMPLEMENTACION`:

```ts
const IMPLEMENTACION: Record<string, string> = {
  search: 'lib/handlers/busqueda.ts',
  product: 'lib/handlers/producto.ts',
  facetas: 'lib/handlers/facetas.ts',
  'mejor-precio': 'lib/handlers/mejor-precio.ts',
};
```

Y agregar, dentro del `describe('docs/api sigue el codigo: nombres de campo de las respuestas')`, la verificación de los campos de la respuesta:

```ts
  it.each(
    clavesDelLiteral(
      FUENTES_API.find((f) => f.nombre === 'mejor-precio')!.codigo,
      'res.status(200).json({',
    ),
  )("el campo '%s' de /mejor-precio esta documentado", (campo) => {
    expect(DOCS).toContain(campo);
  });
```

- [ ] **Step 2: Correr y ver qué falta**

Run: `npx vitest run tests/docs.test.ts`
Expected: FAIL, listando la ruta sin documentar y los campos sin documentar.

- [ ] **Step 3: Documentar en `docs/api/README.md`**

Agregar la fila a la tabla de "Rutas y despliegues", después de la de Facetas:

```markdown
| Mejor precio | `/mejor-precio`, `/api/mejor-precio` | `/api/mejor-precio` |
```

Agregar los códigos nuevos a la tabla de "Formato de error", después de la fila de `demasiado_amplio`:

```markdown
| 409 | `ambiguo` | El MPN existe bajo varias marcas | Repetir con `marca=`. Ver `/mejor-precio`. |
| 409 | `no_comparable` | El producto no tiene MPN y marca, así que no se puede comparar | No reintentar. Ese producto queda fuera del mejor precio. |
```

Y agregar una sección completa antes de `## Ciclo de vida del catálogo`:

```markdown
## `GET /mejor-precio` — el precio más bajo entre todos los proveedores

Devuelve quién vende más barato un producto, consultando a todos los
proveedores registrados. Es la respuesta que se le da al cliente.

### Parámetros (query string)

Exactamente uno de los dos caminos:

| Parámetro | Cuándo | Ejemplo |
|---|---|---|
| `mpn` | Se conoce el part number del fabricante | `mpn=BVG700I-MSX` |
| `proveedor` + `sku` | Se encontró el producto con `/search` y se quiere saber si otro lo tiene más barato | `proveedor=intcomex&sku=UP001APC42` |

Opcional: `marca`, para desambiguar cuando un mismo MPN existe bajo varias.

### Respuesta `200`

```json
{
  "clave": "bvg700imsx|apc",
  "mpn": "BVG700I-MSX",
  "marca": "APC",
  "nombre": "APC Easy UPS 700VA",
  "mejor": {
    "proveedor": "ingram",
    "sku": "6823346",
    "precio": 128.40,
    "moneda": "USD",
    "stock": 6,
    "criterio": "mas_barato_con_stock"
  },
  "ofertas": [
    { "proveedor": "ingram",      "sku": "6823346",    "precio": 128.40, "moneda": "USD", "stock": 6 },
    { "proveedor": "intcomex",    "sku": "UP001APC42", "precio": 131.02, "moneda": "USD", "stock": 12 },
    { "proveedor": "tecnoglobal", "sku": "UPS-284",    "precio": 139.90, "moneda": "USD", "stock": 0 }
  ],
  "incompleta": []
}
```

`mejor` es la oferta ganadora: **la más barata con stock**. `criterio` dice por
qué ganó — `mas_barato_con_stock` normalmente, o `mas_barato_sin_stock` cuando
ningún proveedor tiene existencias y el ganador no se puede entregar hoy.

`ofertas` viene completa y ordenada por precio, no solo la ganadora: sirve para
explicar la decisión o para ofrecer el segundo lugar. Fíjate que la primera de
la lista puede no ser `mejor`, justamente cuando la más barata no tiene stock.

`clave` es el identificador interno con el que se emparejaron los productos
entre proveedores (MPN compactado + marca). Sirve para diagnosticar por qué dos
cosas se consideraron el mismo producto.

### `incompleta`: la comparación puede ser parcial

```json
"incompleta": [
  { "proveedor": "tecnoglobal", "error": "upstream",
    "detail": "Tecnoglobal rechazo la consulta por exceso de llamadas..." }
]
```

**Siempre está presente**, aunque venga vacía. Si trae entradas, el mejor precio
lo es entre los que sí respondieron: alguno de los ausentes podría haber sido
más barato.

La regla de dónde aparece cada proveedor no tiene ambigüedad:

| Dónde aparece | Qué significa |
|---|---|
| En `ofertas` | Lo vende, a ese precio |
| En `incompleta` | Podría venderlo más barato, pero no se pudo averiguar |
| En ninguna | Se revisó su catálogo y no lo vende |

Los `error` posibles en `incompleta` son `catalogo_no_disponible`,
`proveedor_no_configurado`, `sin_precio` y `upstream`.

### Respuesta `409 ambiguo`

Cuando el MPN existe bajo varias marcas, no se adivina:

```json
{
  "error": "ambiguo",
  "detail": "El MPN 98PT0G1299 existe bajo 3 marcas. Repite la consulta con &marca=",
  "marcas": ["trendnet", "eufy", "msi"]
}
```

Repetir con `&marca=msi`. Es raro —un caso cada diez mil productos— pero elegir
mal aquí es cotizarle al cliente otro producto.

### Qué NO hace

- **No aplica margen.** El precio es de costo, igual que en el resto de la API.
- **No compara por texto libre.** Hay que llegar con un `mpn` o con un
  `proveedor`+`sku`, que es lo que devuelven `/search` y `/product`.
- **No cubre todo el catálogo.** Solo alrededor de 1.400 productos existen en
  más de un proveedor; el resto devuelve una sola oferta. Eso es correcto, pero
  conviene que el agente no prometa "comparamos entre tres" en todos los casos.
```

- [ ] **Step 4: Documentar en `docs/api/openapi.yaml`**

Agregar la ruta antes de `  /{proveedor}/search:`:

```yaml
  /mejor-precio:
    get:
      operationId: mejorPrecio
      tags: [busqueda]
      summary: El precio mas bajo entre todos los proveedores
      description: |
        Devuelve quien vende mas barato un producto, consultando a todos los
        proveedores registrados.

        Gana la oferta mas barata CON stock; si ninguno tiene existencias gana
        la mas barata y `criterio` lo indica. `ofertas` viene completa y
        ordenada por precio, asi que la primera de la lista puede no ser la
        ganadora.

        `incompleta` siempre esta presente. Si trae entradas, el mejor precio lo
        es solo entre los proveedores que respondieron.
      parameters:
        - name: mpn
          in: query
          required: false
          description: Part number del fabricante. Excluyente con proveedor+sku.
          schema:
            type: string
        - name: proveedor
          in: query
          required: false
          description: Proveedor que identifica el producto con `sku`. Va junto con `sku`.
          schema:
            type: string
            enum: [intcomex, tecnoglobal, ingram]
        - name: sku
          in: query
          required: false
          description: SKU del proveedor indicado. Va junto con `proveedor`.
          schema:
            type: string
        - name: marca
          in: query
          required: false
          description: Desambigua cuando el mismo MPN existe bajo varias marcas.
          schema:
            type: string
      responses:
        '200':
          description: Comparacion resuelta (puede ser parcial, ver incompleta)
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/MejorPrecio'
        '400':
          $ref: '#/components/responses/BadRequest'
        '401':
          $ref: '#/components/responses/Unauthorized'
        '404':
          description: |
            Ningun proveedor tiene el producto, el SKU no existe en el proveedor
            indicado, o el proveedor de la consulta no existe.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '405':
          $ref: '#/components/responses/MethodNotAllowed'
        '409':
          description: |
            `ambiguo` si el MPN existe bajo varias marcas, o `no_comparable` si
            el producto no tiene MPN y marca.
          content:
            application/json:
              schema:
                $ref: '#/components/schemas/Error'
        '503':
          $ref: '#/components/responses/CatalogoNoDisponible'
```

Agregar los códigos nuevos al enum de `Error`, después de `proveedor_no_configurado`:

```yaml
            - ambiguo
            - no_comparable
```

Y los schemas, antes de `    ErrorProveedor:`:

```yaml
    Oferta:
      type: object
      required: [proveedor, sku, precio, moneda, stock]
      properties:
        proveedor:
          type: string
          description: Proveedor que ofrece este precio.
        sku:
          type: string
          description: SKU con el que ESE proveedor identifica el producto.
        precio:
          type: number
          description: Precio de costo. No incluye margen.
        moneda:
          type: string
        stock:
          type: integer
          nullable: true

    MejorPrecio:
      type: object
      required: [clave, mpn, marca, nombre, mejor, ofertas, incompleta]
      properties:
        clave:
          type: string
          description: |
            Identificador interno con el que se emparejaron los productos entre
            proveedores (MPN compactado + marca). Para diagnostico.
        mpn:
          type: string
          nullable: true
        marca:
          type: string
          nullable: true
        nombre:
          type: string
          nullable: true
        mejor:
          allOf:
            - $ref: '#/components/schemas/Oferta'
            - type: object
              properties:
                criterio:
                  type: string
                  enum: [mas_barato_con_stock, mas_barato_sin_stock]
                  description: |
                    Por que gano esta oferta. `mas_barato_sin_stock` significa
                    que ningun proveedor tiene existencias.
        ofertas:
          type: array
          description: Todas las ofertas, ordenadas por precio ascendente.
          items:
            $ref: '#/components/schemas/Oferta'
        incompleta:
          type: array
          description: |
            Proveedores que no pudieron participar. Siempre presente, puede venir
            vacia. Si trae entradas, el mejor precio lo es solo entre los que
            respondieron.
          items:
            type: object
            required: [proveedor, error, detail]
            properties:
              proveedor:
                type: string
              error:
                type: string
                enum: [catalogo_no_disponible, proveedor_no_configurado, sin_precio, upstream]
              detail:
                type: string
```

- [ ] **Step 5: Actualizar el README de la raíz**

En la lista "Resumen de endpoints", agregar después de la línea de `/price`:

```markdown
- `GET /mejor-precio?mpn=|proveedor=&sku=` — el precio más bajo entre todos los proveedores, con la lista completa de ofertas.
```

Y en la sección `## Proveedores`, reemplazar el párrafo que empieza con `**Todavía no existe el endpoint de "mejor precio"**` por:

```markdown
El endpoint `GET /api/mejor-precio` compara entre los tres. Alrededor de 1.400
productos existen en más de un proveedor; para el resto devuelve una sola
oferta. Ver [`docs/api/README.md`](docs/api/README.md).
```

- [ ] **Step 6: Correr la suite completa**

Run: `npm test && npm run typecheck`
Expected: verde. `tests/docs.test.ts` valida que la ruta esté en ambos documentos, que los status coincidan con los del handler, que los `$ref` del openapi resuelvan y que el enum de errores incluya los códigos nuevos.

- [ ] **Step 7: Commit**

```bash
git add docs/ README.md tests/docs.test.ts
git commit -m "docs: endpoint de mejor precio"
```

---

## Verificación final

- [ ] `npm test` en verde, sin ninguna aserción de contrato de `/api/price`, `/api/search`, `/api/product` o `/api/facetas` modificada.
- [ ] `npm run typecheck` limpio.
- [ ] `grep -nE "intcomex|tecnoglobal|ingram" lib/comparador.ts` → vacío. El comparador no conoce ningún proveedor por nombre.
- [ ] Prueba en vivo contra los tres proveedores reales, con el servidor local levantado y los catálogos cargados:

```bash
K=$(grep '^API_SECRET_KEY=' .env.local | cut -d= -f2-)
curl -s -H "x-api-key: $K" "http://127.0.0.1:3000/api/mejor-precio?mpn=BVG700I-MSX"
```

Esperado: `200` con `ofertas` de más de un proveedor, todas en USD, y `mejor`
apuntando a la más barata con stock. Elegir un MPN de los que existen en los
tres — se pueden listar cruzando los catálogos de `cache/`.

- [ ] Prueba en vivo del camino `proveedor`+`sku`, con un SKU sacado de un
  `/api/intcomex/search`: debe devolver la misma comparación que el `mpn` de ese
  producto.
