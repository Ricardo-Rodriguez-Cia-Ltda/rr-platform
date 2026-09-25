import { describe, expect, it } from 'vitest';
import {
  admiteRecepcion, compraAtrasada, estadoTrasRecepcion, hoySantiago, transicionCompraValida,
} from '../src/lib/compras.js';

describe('transicionCompraValida', () => {
  it('por_comprar solo va a comprada o anulada', () => {
    expect(transicionCompraValida('por_comprar', 'comprada', null)).toBe(true);
    expect(transicionCompraValida('por_comprar', 'anulada', null)).toBe(true);
    expect(transicionCompraValida('por_comprar', 'en_camino', 'despacho_mayorista')).toBe(false);
  });
  it('desde comprada, el siguiente estado depende de la modalidad', () => {
    expect(transicionCompraValida('comprada', 'por_retirar', 'retiro')).toBe(true);
    expect(transicionCompraValida('comprada', 'por_retirar', 'despacho_mayorista')).toBe(false);
    expect(transicionCompraValida('comprada', 'en_camino', 'despacho_mayorista')).toBe(true);
    expect(transicionCompraValida('comprada', 'directo_al_cliente', 'directo_cliente')).toBe(true);
    expect(transicionCompraValida('comprada', 'directo_al_cliente', 'retiro')).toBe(false);
  });
  it('directo_al_cliente termina en entregada_al_cliente; recibida y anulada son finales', () => {
    expect(transicionCompraValida('directo_al_cliente', 'entregada_al_cliente', 'directo_cliente')).toBe(true);
    expect(transicionCompraValida('recibida', 'anulada', 'retiro')).toBe(false);
    expect(transicionCompraValida('anulada', 'comprada', null)).toBe(false);
  });
});

describe('admiteRecepcion', () => {
  it('solo con la compra hecha y si no va directo al cliente', () => {
    expect(admiteRecepcion('comprada', 'retiro')).toBe(true);
    expect(admiteRecepcion('en_camino', 'despacho_mayorista')).toBe(true);
    expect(admiteRecepcion('recibida_parcial', 'retiro')).toBe(true);
    expect(admiteRecepcion('por_comprar', null)).toBe(false);
    expect(admiteRecepcion('recibida', 'retiro')).toBe(false);
    expect(admiteRecepcion('comprada', 'directo_cliente')).toBe(false);
  });
});

describe('estadoTrasRecepcion', () => {
  const comprado = new Map([['A', 2], ['B', 1]]);
  it('recibida cuando cada linea alcanzo lo comprado; si no, recibida_parcial', () => {
    expect(estadoTrasRecepcion(comprado, new Map([['A', 2], ['B', 1]]))).toBe('recibida');
    expect(estadoTrasRecepcion(comprado, new Map([['A', 2]]))).toBe('recibida_parcial');
    expect(estadoTrasRecepcion(comprado, new Map([['A', 1], ['B', 1]]))).toBe('recibida_parcial');
  });
});

describe('compraAtrasada', () => {
  it('llegada estimada vencida y sin recibir', () => {
    expect(compraAtrasada({ estado_compra: 'en_camino', llegada_estimada: '2026-09-20' }, '2026-09-25')).toBe(true);
    expect(compraAtrasada({ estado_compra: 'en_camino', llegada_estimada: '2026-09-25' }, '2026-09-25')).toBe(false);
    expect(compraAtrasada({ estado_compra: 'recibida', llegada_estimada: '2026-09-20' }, '2026-09-25')).toBe(false);
    expect(compraAtrasada({ estado_compra: 'comprada', llegada_estimada: null }, '2026-09-25')).toBe(false);
  });
  it('hoySantiago da la fecha local de Chile', () => {
    // 2026-09-26 02:00 UTC es todavia 25 en Santiago (UTC-3).
    expect(hoySantiago(new Date('2026-09-26T02:00:00Z'))).toBe('2026-09-25');
  });
});
