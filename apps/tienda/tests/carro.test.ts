import { describe, expect, it } from 'vitest';
import { agregar, cambiarCantidad, contarUnidades, MAX_LINEAS, MAX_UNIDADES, totalIndicativo, type ItemCarro } from '../src/lib/carro.js';

const item = (sku: string, cantidad = 1, precio = 1000): ItemCarro =>
  ({ sku, mpn: 'M', marca: 'HP', nombre: 'Prod', cantidad, precioTiendaClp: precio });

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
  it('total indicativo y unidades', () => {
    const items = [item('A', 2, 1000), item('B', 1, 500)];
    expect(totalIndicativo(items)).toBe(2500);
    expect(contarUnidades(items)).toBe(3);
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
