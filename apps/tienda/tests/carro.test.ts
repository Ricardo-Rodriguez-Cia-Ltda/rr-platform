import { describe, expect, it } from 'vitest';
import { agregar, cambiarCantidad, contarUnidades, MAX_LINEAS, MAX_UNIDADES, totalIndicativo, type ItemCarro } from '../src/lib/carro.js';

const item = (sku: string, cantidad = 1, neto = 1000, conIva = 1190): ItemCarro =>
  ({ sku, mpn: 'M', marca: 'HP', nombre: 'Prod', cantidad, precioNetoClp: neto, precioTiendaClp: conIva });

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
    const diez = Array.from({ length: MAX_LINEAS }, (_, i) => item(`S${i}`));
    expect(agregar(diez, item('OTRO'))).toHaveProperty('error');
  });
  it('cambiarCantidad clampa 1..20 y 0 elimina', () => {
    expect(cambiarCantidad([item('A', 5)], 'A', 0)).toHaveLength(0);
    expect(cambiarCantidad([item('A', 5)], 'A', 99)[0].cantidad).toBe(MAX_UNIDADES);
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
    expect(cambiarCantidad(items, 'A', NaN)).toEqual(items);
  });
});
