import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { PROVIDERS } from '@rr/providers';
import { normalizeProduct as normalizarIngram } from '@rr/providers/ingram';
import { normalizeProduct as normalizarIntcomex } from '@rr/providers/intcomex';
import { normalizeProduct as normalizarTecnoglobal } from '@rr/providers/tecnoglobal';
import { unionKey } from '@rr/domain/product';
import type { NormalizedProduct } from '@rr/domain/product';

// Paridad de contrato entre proveedores.
//
// Los handlers son una sola implementacion parametrizada, pero cada proveedor
// aporta su propia normalizacion. Si uno devuelve una llave de menos, el
// agente que consume /product recibe undefined solo contra ese proveedor, y
// ningun test por proveedor lo detecta.

const obtenerCatalogoMock = vi.fn();

vi.mock('@rr/providers/catalog', async () => {
  const actual = await vi.importActual<typeof import('@rr/providers/catalog')>('@rr/providers/catalog');
  return { ...actual, getCatalog: () => obtenerCatalogoMock() };
});

const { default: porRutaProduct } = await import('../api/[proveedor]/product.js');
const { default: porRutaFacetas } = await import('../api/[proveedor]/facetas.js');

const PRODUCTO: NormalizedProduct = {
  sku: 'SKU1',
  mpn: 'MPN1',
  nombre: 'Producto de prueba',
  marca: 'HP',
  categoria: 'Computadores',
  subcategorias: ['Notebooks'],
  tipo: null,
};

const LLAVES_PRODUCT = [
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

const NOMBRES = Object.keys(PROVIDERS);

beforeEach(() => {
  vi.stubEnv('API_SECRET_KEY', 'test-secret');
  obtenerCatalogoMock.mockReset().mockReturnValue([PRODUCTO]);
  for (const proveedor of Object.values(PROVIDERS)) {
    vi.spyOn(proveedor, 'isConfigured').mockReturnValue(true);
    vi.spyOn(proveedor, 'getPrecios').mockResolvedValue(
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
    expect(NOMBRES.sort()).toEqual(['ingram', 'intcomex', 'tecnoglobal']);
  });

  it.each(NOMBRES)('/api/%s/product devuelve exactamente las mismas llaves', async (nombre) => {
    const res = makeRes();
    await porRutaProduct(makeReq({ proveedor: nombre, sku: 'SKU1' }), res);

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual([...LLAVES_PRODUCT].sort());
  });

  it.each(NOMBRES)('/api/%s/facetas devuelve las mismas llaves', async (nombre) => {
    const res = makeRes();
    await porRutaFacetas(makeReq({ proveedor: nombre }), res);

    expect(res.statusCode).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(['categoria', 'marca', 'total_productos']);
  });

  // Cada proveedor trae su propia respuesta cruda. El catalogo, el buscador y
  // la comparacion futura leen los campos por nombre: uno que normalice a otra
  // forma los rompe en silencio.
  const NORMALIZADORES: [string, () => NormalizedProduct][] = [
    [
      'intcomex',
      () =>
        normalizarIntcomex({
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
        normalizarTecnoglobal({
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
        normalizarIngram({
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
    expect(NORMALIZADORES.map(([n]) => n).sort()).toEqual(NOMBRES.sort());
  });

  it.each(NORMALIZADORES)('%s normaliza a la forma comun de NormalizedProduct', (_n, normalize) => {
    const producto = normalize();
    expect(Object.keys(producto).sort()).toEqual([...Object.keys(PRODUCTO)].sort());
    expect(producto).toMatchObject({
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
    const claves = new Set(NORMALIZADORES.map(([, normalize]) => unionKey(normalize())));
    expect(claves.size).toBe(1);
    expect([...claves][0]).not.toBeNull();
  });

  it.each(NOMBRES)('%s declara un tope de lote propio y positivo', (nombre) => {
    expect(PROVIDERS[nombre].maxSkusPorLote).toBeGreaterThan(0);
  });
});
