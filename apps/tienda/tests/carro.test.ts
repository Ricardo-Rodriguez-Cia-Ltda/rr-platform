import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { agregar, cambiarCantidad, claveProducto, contarUnidades, guardarCarro, leerCarro, MAX_LINEAS, MAX_UNIDADES, totalIndicativo, type ItemCarro } from '../src/lib/carro.js';
import { canonicalBrand, compactMpn } from '@rr/domain/product';

const item = (sku: string, cantidad = 1, neto = 1000, conIva = 1190, mpn = 'M', marca = 'HP'): ItemCarro =>
  ({ sku, mpn, marca, nombre: 'Prod', cantidad, precioNetoClp: neto, precioTiendaClp: conIva });

describe('carro', () => {
  it('agregar suma cantidades del mismo sku y respeta el tope por linea', () => {
    let items = agregar([], item('A', 2)) as ItemCarro[];
    items = agregar(items, item('A', 3)) as ItemCarro[];
    expect(items).toHaveLength(1);
    expect(items[0].cantidad).toBe(5);
    const tope = agregar([item('A', MAX_UNIDADES)], item('A', 1));
    expect(tope).toHaveProperty('error');
  });
  it('maximo 10 lineas', () => {
    // Cada linea es un producto distinto (mpn distinto): si compartieran mpn+marca
    // se fusionarian por clave en vez de contar como 10 productos distintos.
    const diez = Array.from({ length: MAX_LINEAS }, (_, i) => item(`S${i}`, 1, 1000, 1190, `M${i}`));
    expect(agregar(diez, item('OTRO', 1, 1000, 1190, 'MOTRO'))).toHaveProperty('error');
  });
  it('cambiarCantidad clampa 1..20 y 0 elimina', () => {
    const a = item('A', 5);
    expect(cambiarCantidad([a], claveProducto(a), 0)).toHaveLength(0);
    expect(cambiarCantidad([a], claveProducto(a), 99)[0].cantidad).toBe(MAX_UNIDADES);
  });

  // I-1: dos lineas de proveedores distintos pueden compartir sku (fallback
  // `sku:` vs una linea con mpn+marca, o dos mayoristas que reusan el mismo
  // string de sku). Identificar por sku cambiaria o borraria las dos.
  it('cambiarCantidad identifica la linea por clave, no por sku: dos lineas pueden compartir sku', () => {
    const a: ItemCarro = { sku: 'X', mpn: 'AAA111', marca: 'HP', nombre: 'Prod A', cantidad: 2, precioNetoClp: 100, precioTiendaClp: 119 };
    const b: ItemCarro = { sku: 'X', mpn: null, marca: null, nombre: 'Prod B', cantidad: 3, precioNetoClp: 200, precioTiendaClp: 238 };
    const items = [a, b];

    const cambiados = cambiarCantidad(items, claveProducto(a), 7);
    expect(cambiados.find((i) => i.nombre === 'Prod A')?.cantidad).toBe(7);
    expect(cambiados.find((i) => i.nombre === 'Prod B')?.cantidad).toBe(3);

    const eliminados = cambiarCantidad(items, claveProducto(a), 0);
    expect(eliminados).toHaveLength(1);
    expect(eliminados[0].nombre).toBe('Prod B');
  });
  it('total = suma de NETOS por linea y UNA sola aplicacion de IVA (como el bot)', () => {
    // El bot suma subtotal_neto_clp de cada linea y recien ahi aplica el IVA
    // una vez (generar-cotizacion-v2.js: neto -> iva_clp -> total_clp).
    // Aplicar IVA por linea y sumar despues da un total distinto y CADA
    // pedido rebotaria con el 409 de recotizacion.
    const items = [item('A', 2, 1000, 1190), item('B', 1, 505, 601)];
    const neto = 2 * 1000 + 505; // 2505
    expect(totalIndicativo(items, 0.19)).toBe(neto + Math.round(neto * 0.19)); // 2505 + 476 = 2981
    expect(contarUnidades(items)).toBe(3);
  });
  it('total con IVA difiere de sumar precios unitarios con IVA (por eso se guarda el neto)', () => {
    const items = [item('A', 3, 50, 60)]; // neto 50 -> round(9.5)=10 -> 60 c/u
    expect(totalIndicativo(items, 0.19)).toBe(150 + Math.round(150 * 0.19)); // 150 + 29 = 179
    expect(totalIndicativo(items, 0.19)).not.toBe(3 * 60); // 180
  });
  it('agregar valida cantidad en linea nueva', () => {
    expect(agregar([], item('A', 25))).toHaveProperty('error');
    expect(agregar([], item('A', 0))).toHaveProperty('error');
    expect(agregar([], item('A', NaN))).toHaveProperty('error');
  });
  it('cambiarCantidad con NaN devuelve items intactos', () => {
    const items = [item('A', 5)];
    expect(cambiarCantidad(items, claveProducto(items[0]), NaN)).toEqual(items);
  });

  it('agregar identifica el producto por mpn+marca, no por sku: el ganador puede cambiar de mayorista', () => {
    const previo: ItemCarro = {
      sku: 'I1', mpn: 'BX8071514100F', marca: 'Intel', nombre: 'Core i5', cantidad: 2,
      proveedor: 'intcomex', precioNetoClp: 100000, precioTiendaClp: 119000,
    };
    // Mismo MPN, marca escrita distinto (mayuscula y con sufijo), otro sku: es
    // el mismo producto pero ahora gana Ingram.
    const nuevo: ItemCarro = {
      sku: 'G1', mpn: 'BX8071514100F', marca: 'INTEL CORP', nombre: 'Core i5', cantidad: 1,
      proveedor: 'ingram', precioNetoClp: 80000, precioTiendaClp: 95200,
    };
    const items = agregar([previo], nuevo) as ItemCarro[];
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({
      cantidad: 3, sku: 'G1', proveedor: 'ingram', precioNetoClp: 80000, precioTiendaClp: 95200,
    });
  });

  it('sin mpn o marca, la clave cae al sku: dos productos distintos no se fusionan', () => {
    const a: ItemCarro = { sku: 'A', mpn: null, marca: null, nombre: 'Prod A', cantidad: 1, precioNetoClp: 100, precioTiendaClp: 119 };
    const b: ItemCarro = { sku: 'B', mpn: null, marca: null, nombre: 'Prod B', cantidad: 1, precioNetoClp: 200, precioTiendaClp: 238 };
    const items = agregar([a], b) as ItemCarro[];
    expect(items).toHaveLength(2);
  });
});

describe('leerCarro fusiona lineas guardadas con la misma clave', () => {
  const CLAVE_STORAGE = 'drc-carro';

  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal('localStorage', {
      getItem: (k: string) => (store.has(k) ? (store.get(k) as string) : null),
      setItem: (k: string, v: string) => { store.set(k, v); },
      removeItem: (k: string) => { store.delete(k); },
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it('colapsa dos lineas con el mismo mpn+marca guardadas con distinto sku, sumando cantidad', () => {
    guardarCarro([
      { sku: 'I1', mpn: 'BX8071514100F', marca: 'Intel', nombre: 'Core i5', cantidad: 2, proveedor: 'intcomex', precioNetoClp: 100000, precioTiendaClp: 119000 },
      { sku: 'G1', mpn: 'BX8071514100F', marca: 'Intel', nombre: 'Core i5', cantidad: 1, proveedor: 'ingram', precioNetoClp: 80000, precioTiendaClp: 95200 },
    ]);
    const items = leerCarro();
    expect(items).toHaveLength(1);
    // Queda la ULTIMA linea de la clave: sku, proveedor y precios de Ingram.
    expect(items[0]).toMatchObject({ cantidad: 3, sku: 'G1', proveedor: 'ingram', precioNetoClp: 80000 });
  });

  it('la fusion respeta el tope MAX_UNIDADES', () => {
    guardarCarro([
      { sku: 'I1', mpn: 'M', marca: 'HP', nombre: 'P', cantidad: 15, precioNetoClp: 1, precioTiendaClp: 1 },
      { sku: 'G1', mpn: 'M', marca: 'HP', nombre: 'P', cantidad: 10, precioNetoClp: 1, precioTiendaClp: 1 },
    ]);
    expect(leerCarro()[0].cantidad).toBe(MAX_UNIDADES);
  });

  // M-6: antes esto colaba una linea de 0 unidades, y `validarPedido` la
  // rechazaba con "Una cantidad no es valida" en vez de que el carro
  // simplemente no la mostrara.
  it('tolera basura guardada sin romper: descarta lineas con cantidad invalida o sku vacio', () => {
    localStorage.setItem(
      CLAVE_STORAGE,
      JSON.stringify([
        null,
        'texto',
        42,
        { sku: 'A' }, // sin cantidad -> NaN
        { sku: 'B', cantidad: 0 },
        { sku: 'C', cantidad: -1 },
        { sku: 'D', cantidad: NaN },
        { sku: '', cantidad: 2 },
        { sku: '   ', cantidad: 2 },
      ]),
    );
    expect(() => leerCarro()).not.toThrow();
    expect(leerCarro()).toEqual([]);
  });

  it('la fusion conserva las lineas validas aunque haya basura mezclada', () => {
    localStorage.setItem(
      CLAVE_STORAGE,
      JSON.stringify([
        { sku: 'A' }, // descartada: sin cantidad
        { sku: 'E', mpn: 'M', marca: 'HP', nombre: 'P', cantidad: 3, precioNetoClp: 1, precioTiendaClp: 1 },
      ]),
    );
    const items = leerCarro();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ sku: 'E', cantidad: 3 });
  });

  it('JSON invalido en localStorage devuelve carro vacio', () => {
    localStorage.setItem(CLAVE_STORAGE, '{no es json');
    expect(leerCarro()).toEqual([]);
  });
});

// M-3: la tienda no puede depender de @rr/domain en su codigo de produccion
// (no esta en su package.json ni en su tsconfig, que ademas excluye del build
// de paquetes del monorepo), asi que claveProducto copia a mano la tabla de
// alias de packages/domain/src/product.ts. Este test SI puede importar
// @rr/domain (corre bajo vitest, no bajo el build de Next), y pinea que la
// copia local da el mismo resultado que el original para las marcas de la
// tabla, incluyendo el caso "HP-POLY" (un token sin espacio) citado en la
// revision.
describe('claveProducto mantiene la misma tabla de alias que @rr/domain (M-3)', () => {
  const marcas = [
    'HyperX',
    'Poly',
    'HP - POLY VIDEO',
    'HP-POLY',
    'American Power Conversion',
    'Meraki Networks',
    'Hewlett Packard Enterprise',
    'Aruba Networks',
    'Dell',
    'BROTHER - SUMINISTROS',
  ];

  it.each(marcas)('la clave del carro y canonicalBrand coinciden para "%s"', (marca) => {
    const mpn = 'AB-12/34';
    const item: ItemCarro = { sku: 'S', mpn, marca, nombre: 'P', cantidad: 1, precioNetoClp: 1, precioTiendaClp: 1 };

    const clave = claveProducto(item);
    const esperado = `${compactMpn(mpn)}|${canonicalBrand(marca)}`;

    expect(clave.toLowerCase()).toBe(esperado.toLowerCase());
  });
});
