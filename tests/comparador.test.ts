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
