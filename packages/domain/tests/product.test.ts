import { describe, expect, it } from 'vitest';
import { unionKey, compactMpn, canonicalBrand } from '@rr/domain/product';
import type { NormalizedProduct } from '@rr/domain/product';

function producto(campos: Partial<NormalizedProduct>): NormalizedProduct {
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

describe('compactMpn', () => {
  it('quita puntuacion y mayusculas', () => {
    expect(compactMpn('2N6G5LT#ABM')).toBe('2n6g5ltabm');
  });

  // El mismo producto viaja escrito distinto entre distribuidores: si la
  // compactacion no los junta, la comparacion de precios nunca los empareja.
  it('iguala las variantes de un mismo MPN', () => {
    expect(compactMpn('2N6G5LT-ABM')).toBe(compactMpn('2N6G5LT#ABM'));
    expect(compactMpn('920-008813')).toBe(compactMpn('920 008813'));
  });

  it('devuelve vacio para un MPN ausente o sin caracteres utiles', () => {
    expect(compactMpn(null)).toBe('');
    expect(compactMpn('   ')).toBe('');
    expect(compactMpn('---')).toBe('');
  });
});

// Medido sobre los catalogos reales: cada distribuidor le pega su unidad de
// negocio a la marca, y comparar la cadena completa descartaba 13 de cada 14
// cruces entre proveedores (36 productos en los tres, contra 479 posibles).
describe('canonicalBrand', () => {
  it('se queda con la primera palabra de la marca', () => {
    expect(canonicalBrand('Kingston')).toBe('kingston');
    expect(canonicalBrand('HP')).toBe('hp');
  });

  it.each([
    ['BROTHER - SUMINISTROS', 'Brother'],
    ['SAMSUNG MONITORES Y TV', 'Samsung'],
    ['ASUS ACCESORIOS', 'ASUS'],
    ['HPE SERVER  STOCK  SCSB', 'HPE'],
    ['lenovo rel monitores', 'LENOVO monitores'],
    ['HP  SUMINISTROS TONER', 'Hp'],
  ])('ignora el sufijo de unidad de negocio: %s = %s', (largo, corto) => {
    expect(canonicalBrand(largo)).toBe(canonicalBrand(corto));
  });

  // Estas no comparten primera palabra: sin tabla de alias quedan separadas
  // aunque sean la misma marca.
  it.each([
    ['AMERICAN POWER', 'APC'],
    ['Hewlett Packard Enterprise', 'HPE'],
  ])('reconoce el alias %s = %s', (a, b) => {
    expect(canonicalBrand(a)).toBe(canonicalBrand(b));
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
    expect(canonicalBrand(comprada)).toBe(canonicalBrand(duena));
  });

  // HP Inc y HPE son empresas distintas.
  it('no confunde Hewlett Packard con Hewlett Packard Enterprise', () => {
    expect(canonicalBrand('Hewlett Packard')).not.toBe(canonicalBrand('Hewlett Packard Enterprise'));
  });

  it('devuelve vacio cuando no hay marca', () => {
    expect(canonicalBrand(null)).toBe('');
    expect(canonicalBrand('  -- ')).toBe('');
  });
});

describe('unionKey', () => {
  it('combina MPN compactado y marca canonica', () => {
    expect(unionKey(producto({ mpn: '2N6G5LT#ABM', marca: 'HP' }))).toBe('2n6g5ltabm|hp');
  });

  // El caso real que motivo el cambio: el mismo UPS en los tres proveedores.
  it('empareja el mismo producto pese a que cada proveedor nombre la marca distinto', () => {
    const intcomex = producto({ sku: 'UP001APC42', mpn: 'BVG700I-MSX', marca: 'APC' });
    const tecnoglobal = producto({ sku: 'UPS-284', mpn: 'BVG700IMSX', marca: 'AMERICAN POWER' });
    const ingram = producto({ sku: '6823346', mpn: 'BVG700I-MSX', marca: 'Apc' });

    expect(unionKey(tecnoglobal)).toBe(unionKey(intcomex));
    expect(unionKey(ingram)).toBe(unionKey(intcomex));
  });

  // La unica colision real de MPN en 10.411 productos de Intcomex: tres
  // adaptadores de marcas distintas con el mismo part number. La marca es lo
  // que evita cotizar el Trendnet cuando piden el MSI.
  it('mantiene separados los productos que comparten MPN entre marcas distintas', () => {
    const claves = ['Trendnet', 'Eufy', 'MSI'].map((marca) =>
      unionKey(producto({ mpn: '98PT0G1299', marca })),
    );
    expect(new Set(claves).size).toBe(3);
  });

  it('empareja el mismo producto escrito distinto por dos proveedores', () => {
    const a = producto({ sku: 'NT016HPQ53', mpn: '2N6G5LT#ABM', marca: 'HP' });
    const b = producto({ sku: 'IM-99887', mpn: '2n6g5lt-abm', marca: 'hp' });
    expect(unionKey(a)).toBe(unionKey(b));
  });

  it('no empareja el mismo MPN de marcas distintas', () => {
    const a = producto({ mpn: 'X100', marca: 'HP' });
    const b = producto({ mpn: 'X100', marca: 'Dell' });
    expect(unionKey(a)).not.toBe(unionKey(b));
  });

  // Decision del spec: sin MPN no se compara. Preferimos perder un match
  // antes que inventarlo: un falso positivo aqui cotiza un producto que no es.
  it('devuelve null cuando no hay MPN', () => {
    expect(unionKey(producto({ mpn: null, marca: 'HP' }))).toBeNull();
    expect(unionKey(producto({ mpn: '---', marca: 'HP' }))).toBeNull();
  });

  it('devuelve null cuando no hay marca', () => {
    expect(unionKey(producto({ mpn: 'X100', marca: null }))).toBeNull();
  });
});
