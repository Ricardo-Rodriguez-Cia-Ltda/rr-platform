import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PROVIDERS } from '@rr/providers';
import { normalizeProduct as normalizeIngram } from '@rr/providers/ingram';
import { normalizeProduct as normalizeIntcomex } from '@rr/providers/intcomex';
import { normalizeProduct as normalizeTecnoglobal } from '@rr/providers/tecnoglobal';
import { unionKey } from '@rr/domain/product';
import type { NormalizedProduct } from '@rr/domain/product';

// Paridad de contrato entre proveedores.
//
// Los handlers son una sola implementacion parametrizada, pero cada proveedor
// aporta su propia normalizacion. Si uno devuelve una llave de menos, el
// agente que consume /product recibe undefined solo contra ese proveedor, y
// ningun test por proveedor lo detecta.

const getCatalogMock = vi.fn();

vi.mock('@rr/providers/catalog', async () => {
  const actual = await vi.importActual<typeof import('@rr/providers/catalog')>('@rr/providers/catalog');
  return { ...actual, getCatalog: () => getCatalogMock() };
});

const { default: productByRoute } = await import('../api/[proveedor]/product.js');
const { default: facetasByRoute } = await import('../api/[proveedor]/facetas.js');

const PRODUCT: NormalizedProduct = {
  sku: 'SKU1',
  mpn: 'MPN1',
  nombre: 'Producto de prueba',
  marca: 'HP',
  categoria: 'Computadores',
  subcategorias: ['Notebooks'],
  tipo: null,
};

const PRODUCT_KEYS = [
  'sku',
  'mpn',
  'nombre',
  'marca',
  'categoria',
  'subcategorias',
  'tipo',
  'precio',
  'moneda',
  'stock',
];

function makeReq(query: Record<string, string>): VercelRequest {
  return { query, headers: { 'x-api-key': 'test-secret' }, method: 'GET' } as unknown as VercelRequest;
}

function makeRes(): VercelResponse & { statusCode: number; body: any } {
  const res: any = {
    statusCode: 0,
    body: undefined,
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
  };
  return res;
}

const NAMES = Object.keys(PROVIDERS);

beforeEach(() => {
  vi.stubEnv('API_SECRET_KEY', 'test-secret');
  getCatalogMock.mockReset().mockReturnValue([PRODUCT]);
  for (const provider of Object.values(PROVIDERS)) {
    vi.spyOn(provider, 'isConfigured').mockReturnValue(true);
    vi.spyOn(provider, 'getPrices').mockResolvedValue(
      new Map([['SKU1', { price: 100, currency: 'USD', inStock: 3 }]]),
    );
  }
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe('paridad de contrato entre proveedores', () => {
  it('estan registrados los tres proveedores del negocio', () => {
    expect(NAMES.sort()).toEqual(['ingram', 'intcomex', 'tecnoglobal']);
  });

  it.each(NAMES)('/api/%s/product devuelve exactamente las mismas llaves', async (name) => {
    const res = makeRes();
    await productByRoute(makeReq({ proveedor: name, sku: 'SKU1' }), res);

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([...PRODUCT_KEYS].sort());
  });

  it.each(NAMES)('/api/%s/facetas devuelve las mismas llaves', async (name) => {
    const res = makeRes();
    await facetasByRoute(makeReq({ proveedor: name }), res);

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['categoria', 'marca', 'total_productos']);
  });

  // Cada proveedor trae su propia respuesta cruda. El catalogo, el buscador y
  // la comparacion futura leen los campos por nombre: uno que normalice a otra
  // forma los rompe en silencio.
  const NORMALIZERS: [string, () => NormalizedProduct][] = [
    [
      'intcomex',
      () =>
        normalizeIntcomex({
          Sku: 'SKU1',
          Mpn: 'MPN1',
          Description: 'Producto de prueba',
          Brand: { Description: 'HP' },
          Category: { Description: 'Computadores', Subcategories: [{ Description: 'Notebooks' }] },
        }),
    ],
    [
      'tecnoglobal',
      () =>
        normalizeTecnoglobal({
          codigoTg: 'SKU1',
          pnFabricante: 'MPN1',
          descripcion: 'Producto de prueba',
          marca: 'HP',
          categoria: 'Computadores',
          subCategoria: 'Notebooks',
        }),
    ],
    [
      'ingram',
      () =>
        normalizeIngram({
          ingramPartNumber: 'SKU1',
          vendorPartNumber: 'MPN1',
          description: 'Producto de prueba',
          vendorName: 'HP',
          category: 'Computadores',
          subCategory: 'Notebooks',
        }),
    ],
  ];

  it('hay un normalizador cubierto por proveedor registrado', () => {
    expect(NORMALIZERS.map(([n]) => n).sort()).toEqual(NAMES.sort());
  });

  it.each(NORMALIZERS)('%s normaliza a la forma comun de NormalizedProduct', (_n, normalize) => {
    const product = normalize();
    expect(Object.keys(product).sort()).toEqual([...Object.keys(PRODUCT)].sort());
    expect(product).toMatchObject({
      sku: 'SKU1',
      mpn: 'MPN1',
      nombre: 'Producto de prueba',
      marca: 'HP',
      categoria: 'Computadores',
      subcategorias: ['Notebooks'],
    });
  });

  // El "mejor precio" empareja por MPN + marca. Si dos proveedores producen
  // claves distintas para el mismo producto, la comparacion nunca los junta.
  it('el mismo producto en los tres proveedores produce la misma clave de union', () => {
    const keys = new Set(NORMALIZERS.map(([, normalize]) => unionKey(normalize())));
    expect(keys.size).toBe(1);
    expect([...keys][0]).not.toBeNull();
  });

  it.each(NAMES)('%s declara un tope de lote propio y positivo', (name) => {
    expect(PROVIDERS[name].maxSkusPerBatch).toBeGreaterThan(0);
  });
});
