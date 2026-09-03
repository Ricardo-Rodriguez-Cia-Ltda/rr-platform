import { describe, expect, it } from 'vitest';
import { leerFicha } from '../src/lib/ficha.js';

// Nombres REALES del catalogo (copiados de una respuesta de la pricing-api).
const HP = 'HP 240 G5 - Core i5 6200U / 2.3 GHz - FreeDOS 2.0 - 4 GB RAM - 1 TB HDD - 14" 1366 x 768 (HD) - HD Graphics 520 - negro (teclado), ceniza oscura';
const LENOVO = 'Lenovo Yoga Tablet 8 - ZA09 - 8" - 16 GB - 800 x 1280 - 1 GB RAM - Android 5.1 - Tarjetas de memoria flash compatibles: microSD - Cámara de visión posterior - APQ 8009 - Black';
const CABLE = 'Nexxt Enterprise Cat6 U/UTP Cable 4P 23AWG CM 305m GR';
const PATCH = 'Eaton Tripp Lite Series 24-Port Cat5e Cat5 Rackmount Patch Panel 568B 110 Punch 1URM - Tablero de conexiones - CAT 5e - 1U - 19" - 24 puertos';

describe('leerFicha', () => {
  it('el titulo es el primer segmento, antes del primer guion', () => {
    expect(leerFicha(HP).titulo).toBe('HP 240 G5');
    expect(leerFicha(PATCH).titulo).toBe('Eaton Tripp Lite Series 24-Port Cat5e Cat5 Rackmount Patch Panel 568B 110 Punch 1URM');
  });

  it('sin guiones, el nombre entero es el titulo y no hay detalle', () => {
    const f = leerFicha(CABLE);
    expect(f.titulo).toBe(CABLE);
    expect(f.detalle).toBe('');
  });

  it('extrae las specs de un notebook en orden fijo: CPU, RAM, disco, pantalla', () => {
    expect(leerFicha(HP).specs).toEqual(['Core i5', '4 GB RAM', '1 TB HDD', '14"']);
  });

  it('lee GB de RAM y pulgadas aunque el nombre mezcle otras medidas', () => {
    // "16 GB" (almacenamiento del tablet) NO es RAM; la RAM esta declarada aparte.
    expect(leerFicha(LENOVO).specs).toEqual(['1 GB RAM', '8"']);
  });

  it('un accesorio sin specs reconocibles devuelve lista vacia, no basura', () => {
    expect(leerFicha(PATCH).specs).toEqual(['19"']);
    expect(leerFicha(CABLE).specs).toEqual([]);
  });

  it('el detalle es el resto del nombre, sin repetir el titulo', () => {
    const f = leerFicha(HP);
    expect(f.detalle.startsWith('Core i5 6200U')).toBe(true);
    expect(f.detalle).not.toContain('HP 240 G5 -');
  });

  it('nunca devuelve mas de cuatro specs (la ficha tiene que caber)', () => {
    const cargado = 'Dell XPS - Core i7 1360P - 32 GB RAM - 2 TB SSD - 15.6" - Windows 11 Pro - RTX 4060';
    expect(leerFicha(cargado).specs.length).toBeLessThanOrEqual(4);
    expect(leerFicha(cargado).specs[0]).toBe('Core i7');
  });

  it('aguanta nombre vacio o basura sin lanzar', () => {
    expect(leerFicha('').titulo).toBe('');
    expect(leerFicha('   -   -  ').specs).toEqual([]);
  });
});

// Casos que solo apareceron al mirar la tienda con el catalogo REAL: los
// tests sinteticos no los cubrian.
describe('leerFicha con nombres reales del catalogo', () => {
  const NEXXT = 'Nexxt - Cable de interconexión - RJ-45 (M) a RJ-45 (M) - 90 cm - UTP - CAT 5e - moldeado, trenzado - gris';
  const XIAOMI = 'Xiaomi Redmi 9A - 4G smartphone - SIM doble - RAM 2 GB / Memoria interna 32 GB - microSD slot - 6.53" - 1600 x 720 pixels';

  it('una pantalla de 6.53" no se lee como 53"', () => {
    // El decimal de dos digitos hacia que el patron tomara solo "53".
    expect(leerFicha(XIAOMI).specs).toContain('6.53"');
    expect(leerFicha(XIAOMI).specs).not.toContain('53"');
  });

  it('lee la RAM tambien cuando el nombre la escribe al reves ("RAM 2 GB")', () => {
    expect(leerFicha(XIAOMI).specs).toContain('2 GB RAM');
  });

  it('si el primer segmento es solo la marca, el titulo pasa al siguiente', () => {
    // "Nexxt" ya se muestra como marca arriba de la ficha: repetirlo de titulo
    // deja la tarjeta sin decir QUE es el producto.
    expect(leerFicha(NEXXT, 'Nexxt').titulo).toBe('Cable de interconexión');
    expect(leerFicha(NEXXT, 'Nexxt').detalle).not.toContain('Cable de interconexión');
  });

  it('sin marca conocida, el titulo sigue siendo el primer segmento', () => {
    expect(leerFicha(NEXXT).titulo).toBe('Nexxt');
  });

  it('la marca solo se salta si el segmento es SOLO la marca', () => {
    const hp = 'HP 240 G5 - Core i5 6200U - 4 GB RAM';
    expect(leerFicha(hp, 'HP').titulo).toBe('HP 240 G5');
  });
});

describe('leerFicha: marca con varias palabras', () => {
  // El catalogo llama "Nexxt Solutions Infrastructure" a lo que el nombre del
  // producto abrevia como "Nexxt". Misma regla de primera palabra que el resto
  // del repo usa para unir marcas entre mayoristas.
  const NEXXT = 'Nexxt - Cable de interconexión - RJ-45 (M) a RJ-45 (M) - 90 cm - UTP';

  it('salta el segmento si es la primera palabra de la marca', () => {
    expect(leerFicha(NEXXT, 'Nexxt Solutions Infrastructure').titulo).toBe('Cable de interconexión');
  });

  it('no salta un segmento de varias palabras aunque empiece con la marca', () => {
    const hp = 'HP 240 G5 - Core i5 6200U - 4 GB RAM';
    expect(leerFicha(hp, 'HP Inc.').titulo).toBe('HP 240 G5');
  });

  it('si saltar dejaria la ficha sin titulo, no salta', () => {
    expect(leerFicha('Nexxt', 'Nexxt Solutions').titulo).toBe('Nexxt');
  });
});
