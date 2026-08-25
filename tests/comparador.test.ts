import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  catalogosNoDisponibles,
  claveDeSku,
  compararPorClave,
  hayAlgunCatalogo,
  resolverClaves,
} from '../lib/comparador.js';
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

  // Ambos en cero confirmado: el unico caso en que 'no se puede entregar' es
  // verdad. Un null aca significaria otra cosa y se prueba aparte.
  it('sin stock en ninguno, elige el mas barato y lo marca', async () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    catalogos.set('b', [producto({ sku: 'B1' })]);
    const registro = {
      a: proveedorFalso('a', { A1: { price: 130, currency: 'USD', inStock: 0 } }),
      b: proveedorFalso('b', { B1: { price: 100, currency: 'USD', inStock: 0 } }),
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

  // Un precio no positivo no es un precio, es ausencia de precio. Intcomex
  // devuelve 0 en ~4 de cada 300 SKUs; ese cero no puede ganar y salir
  // cotizado a un cliente real.
  it('un precio 0 no gana: el proveedor queda en incompleta como sin_precio', async () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    const registro = { a: proveedorFalso('a', { A1: { price: 0, currency: 'USD', inStock: 0 } }) };

    const r = await compararPorClave(CLAVE, registro);

    expect(r.mejor).toBeNull();
    expect(r.ofertas).toEqual([]);
    expect(r.incompleta).toEqual([
      { proveedor: 'a', error: 'sin_precio', detail: expect.any(String) },
    ]);
  });

  it('un precio 0 no le gana a un precio valido aunque ninguno tenga stock', async () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    catalogos.set('b', [producto({ sku: 'B1' })]);
    const registro = {
      a: proveedorFalso('a', { A1: { price: 0, currency: 'USD', inStock: 0 } }),
      b: proveedorFalso('b', { B1: { price: 100, currency: 'USD', inStock: 0 } }),
    };

    const r = await compararPorClave(CLAVE, registro);

    expect(r.mejor).toMatchObject({ proveedor: 'b', precio: 100 });
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

describe('catalogosNoDisponibles', () => {
  // resolverClaves salta en silencio los catalogos sin cargar; esta funcion
  // es como el llamador se entera de a quien se salteo, para no afirmar
  // "nadie lo vende" cuando en realidad no se pudo preguntar a todos.
  it('lista los proveedores cuyo catalogo no cargo', () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    const registro = { a: proveedorFalso('a', {}), b: proveedorFalso('b', {}) };

    expect(catalogosNoDisponibles(registro)).toEqual([
      { proveedor: 'b', error: 'catalogo_no_disponible', detail: expect.any(String) },
    ]);
  });

  it('vacio cuando todos los catalogos cargaron', () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    catalogos.set('b', [producto({ sku: 'B1' })]);

    expect(
      catalogosNoDisponibles({ a: proveedorFalso('a', {}), b: proveedorFalso('b', {}) }),
    ).toEqual([]);
  });

  // Un proveedor sin credenciales nunca carga catalogo (server.ts lo excluye
  // del refresco), asi que sin este chequeo caeria siempre en
  // catalogo_no_disponible: transitorio, cuando en realidad es permanente.
  it('distingue un proveedor sin credenciales del que simplemente no cargo', () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    const sinLlaves = proveedorFalso('b', {}, { configurado: false });
    const registro = { a: proveedorFalso('a', {}), b: sinLlaves };

    expect(catalogosNoDisponibles(registro)).toEqual([
      { proveedor: 'b', error: 'proveedor_no_configurado', detail: expect.any(String) },
    ]);
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

// El stock nulo es "el proveedor no lo dijo", no "no hay". Confundirlos hace
// que una oferta mas barata pierda contra una mas cara, y encima le dice al
// cliente que no se puede entregar cuando lo unico que falta es el dato.
describe('stock desconocido', () => {
  it('prefiere el que tiene stock confirmado sobre el desconocido', async () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    catalogos.set('b', [producto({ sku: 'B1' })]);
    const registro = {
      a: proveedorFalso('a', { A1: { price: 130, currency: 'USD', inStock: 5 } }),
      b: proveedorFalso('b', { B1: { price: 100, currency: 'USD', inStock: null } }),
    };

    const r = await compararPorClave(CLAVE, registro);

    expect(r.mejor).toMatchObject({ proveedor: 'a', criterio: 'mas_barato_con_stock' });
  });

  // Desconocido gana contra un cero confirmado: "no se sabe" deja abierta la
  // venta, "no hay" la cierra.
  it('el stock desconocido le gana al cero confirmado', async () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    catalogos.set('b', [producto({ sku: 'B1' })]);
    const registro = {
      a: proveedorFalso('a', { A1: { price: 130, currency: 'USD', inStock: 0 } }),
      b: proveedorFalso('b', { B1: { price: 200, currency: 'USD', inStock: null } }),
    };

    const r = await compararPorClave(CLAVE, registro);

    expect(r.mejor).toMatchObject({ proveedor: 'b', criterio: 'stock_desconocido' });
  });

  it('con todos desconocidos gana el mas barato y lo dice', async () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    catalogos.set('b', [producto({ sku: 'B1' })]);
    const registro = {
      a: proveedorFalso('a', { A1: { price: 130, currency: 'USD', inStock: null } }),
      b: proveedorFalso('b', { B1: { price: 100, currency: 'USD', inStock: null } }),
    };

    const r = await compararPorClave(CLAVE, registro);

    expect(r.mejor).toMatchObject({ proveedor: 'b', criterio: 'stock_desconocido' });
  });

  it('con todos en cero confirmado sigue diciendo sin stock', async () => {
    catalogos.set('a', [producto({ sku: 'A1' })]);
    const registro = { a: proveedorFalso('a', { A1: { price: 130, currency: 'USD', inStock: 0 } }) };

    const r = await compararPorClave(CLAVE, registro);

    expect(r.mejor).toMatchObject({ criterio: 'mas_barato_sin_stock' });
  });
});
