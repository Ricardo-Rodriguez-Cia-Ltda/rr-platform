import { describe, expect, it } from 'vitest';
import { claveUnion, compactarMpn, marcaCanonica } from '../lib/producto.js';
import type { ProductoNormalizado } from '../lib/producto.js';

function producto(campos: Partial<ProductoNormalizado>): ProductoNormalizado {
  return {
    sku: 'SKU1',
    mpn: null,
    nombre: null,
    marca: null,
    categoria: null,
    subcategorias: [],
    tipo: null,
    ...campos,
  };
}

describe('compactarMpn', () => {
  it('quita puntuacion y mayusculas', () => {
    expect(compactarMpn('2N6G5LT#ABM')).toBe('2n6g5ltabm');
  });

  // El mismo producto viaja escrito distinto entre distribuidores: si la
  // compactacion no los junta, la comparacion de precios nunca los empareja.
  it('iguala las variantes de un mismo MPN', () => {
    expect(compactarMpn('2N6G5LT-ABM')).toBe(compactarMpn('2N6G5LT#ABM'));
    expect(compactarMpn('920-008813')).toBe(compactarMpn('920 008813'));
  });

  it('devuelve vacio para un MPN ausente o sin caracteres utiles', () => {
    expect(compactarMpn(null)).toBe('');
    expect(compactarMpn('   ')).toBe('');
    expect(compactarMpn('---')).toBe('');
  });
});

// Medido sobre los catalogos reales: cada distribuidor le pega su unidad de
// negocio a la marca, y comparar la cadena completa descartaba 13 de cada 14
// cruces entre proveedores (36 productos en los tres, contra 479 posibles).
describe('marcaCanonica', () => {
  it('se queda con la primera palabra de la marca', () => {
    expect(marcaCanonica('Kingston')).toBe('kingston');
    expect(marcaCanonica('HP')).toBe('hp');
  });

  it.each([
    ['BROTHER - SUMINISTROS', 'Brother'],
    ['SAMSUNG MONITORES Y TV', 'Samsung'],
    ['ASUS ACCESORIOS', 'ASUS'],
    ['HPE SERVER  STOCK  SCSB', 'HPE'],
    ['lenovo rel monitores', 'LENOVO monitores'],
    ['HP  SUMINISTROS TONER', 'Hp'],
  ])('ignora el sufijo de unidad de negocio: %s = %s', (largo, corto) => {
    expect(marcaCanonica(largo)).toBe(marcaCanonica(corto));
  });

  // Estas no comparten primera palabra: sin tabla de alias quedan separadas
  // aunque sean la misma marca.
  it.each([
    ['AMERICAN POWER', 'APC'],
    ['Hewlett Packard Enterprise', 'HPE'],
  ])('reconoce el alias %s = %s', (a, b) => {
    expect(marcaCanonica(a)).toBe(marcaCanonica(b));
  });

  // Adquisiciones. Ingram etiqueta como "Hp" tanto un teclado HyperX como un
  // headset Poly, mientras Intcomex conserva la marca comprada: si no se
  // resuelven hacia la dueña, esos productos no se cruzan nunca.
  it.each([
    ['HyperX', 'Hp'],
    ['Poly', 'Hp'],
    ['HP - POLY VIDEO', 'Hp'],
    ['Aruba', 'HPE'],
    ['Meraki', 'Cisco'],
  ])('resuelve %s hacia %s', (comprada, duena) => {
    expect(marcaCanonica(comprada)).toBe(marcaCanonica(duena));
  });

  // HP Inc y HPE son empresas distintas.
  it('no confunde Hewlett Packard con Hewlett Packard Enterprise', () => {
    expect(marcaCanonica('Hewlett Packard')).not.toBe(marcaCanonica('Hewlett Packard Enterprise'));
  });

  it('devuelve vacio cuando no hay marca', () => {
    expect(marcaCanonica(null)).toBe('');
    expect(marcaCanonica('  -- ')).toBe('');
  });
});

describe('claveUnion', () => {
  it('combina MPN compactado y marca canonica', () => {
    expect(claveUnion(producto({ mpn: '2N6G5LT#ABM', marca: 'HP' }))).toBe('2n6g5ltabm|hp');
  });

  // El caso real que motivo el cambio: el mismo UPS en los tres proveedores.
  it('empareja el mismo producto pese a que cada proveedor nombre la marca distinto', () => {
    const intcomex = producto({ sku: 'UP001APC42', mpn: 'BVG700I-MSX', marca: 'APC' });
    const tecnoglobal = producto({ sku: 'UPS-284', mpn: 'BVG700IMSX', marca: 'AMERICAN POWER' });
    const ingram = producto({ sku: '6823346', mpn: 'BVG700I-MSX', marca: 'Apc' });

    expect(claveUnion(tecnoglobal)).toBe(claveUnion(intcomex));
    expect(claveUnion(ingram)).toBe(claveUnion(intcomex));
  });

  // La unica colision real de MPN en 10.411 productos de Intcomex: tres
  // adaptadores de marcas distintas con el mismo part number. La marca es lo
  // que evita cotizar el Trendnet cuando piden el MSI.
  it('mantiene separados los productos que comparten MPN entre marcas distintas', () => {
    const claves = ['Trendnet', 'Eufy', 'MSI'].map((marca) =>
      claveUnion(producto({ mpn: '98PT0G1299', marca })),
    );
    expect(new Set(claves).size).toBe(3);
  });

  it('empareja el mismo producto escrito distinto por dos proveedores', () => {
    const a = producto({ sku: 'NT016HPQ53', mpn: '2N6G5LT#ABM', marca: 'HP' });
    const b = producto({ sku: 'IM-99887', mpn: '2n6g5lt-abm', marca: 'hp' });
    expect(claveUnion(a)).toBe(claveUnion(b));
  });

  it('no empareja el mismo MPN de marcas distintas', () => {
    const a = producto({ mpn: 'X100', marca: 'HP' });
    const b = producto({ mpn: 'X100', marca: 'Dell' });
    expect(claveUnion(a)).not.toBe(claveUnion(b));
  });

  // Decision del spec: sin MPN no se compara. Preferimos perder un match
  // antes que inventarlo: un falso positivo aqui cotiza un producto que no es.
  it('devuelve null cuando no hay MPN', () => {
    expect(claveUnion(producto({ mpn: null, marca: 'HP' }))).toBeNull();
    expect(claveUnion(producto({ mpn: '---', marca: 'HP' }))).toBeNull();
  });

  it('devuelve null cuando no hay marca', () => {
    expect(claveUnion(producto({ mpn: 'X100', marca: null }))).toBeNull();
  });
});
