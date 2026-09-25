import { describe, expect, it } from 'vitest';
import { requisitoTransicion, transicionDespachoValida } from '../src/lib/despachos.js';

describe('transicionDespachoValida', () => {
  it('camino normal por courier o despacho propio', () => {
    expect(transicionDespachoValida('por_preparar', 'listo', 'courier')).toBe(true);
    expect(transicionDespachoValida('listo', 'en_ruta', 'courier')).toBe(true);
    expect(transicionDespachoValida('en_ruta', 'entregado', 'propio')).toBe(true);
    expect(transicionDespachoValida('listo', 'entregado', 'propio')).toBe(false);
  });
  it('retiro en oficina pasa de listo a entregado, sin ruta', () => {
    expect(transicionDespachoValida('listo', 'entregado', 'retiro_oficina')).toBe(true);
    expect(transicionDespachoValida('listo', 'en_ruta', 'retiro_oficina')).toBe(false);
  });
  it('fallido se reprograma o se anula; entregado y anulado son finales', () => {
    expect(transicionDespachoValida('en_ruta', 'fallido', 'courier')).toBe(true);
    expect(transicionDespachoValida('fallido', 'listo', 'courier')).toBe(true);
    expect(transicionDespachoValida('fallido', 'anulado', 'courier')).toBe(true);
    expect(transicionDespachoValida('entregado', 'anulado', 'courier')).toBe(false);
    expect(transicionDespachoValida('anulado', 'listo', 'courier')).toBe(false);
    expect(transicionDespachoValida('en_ruta', 'anulado', 'courier')).toBe(false);
  });
});

describe('requisitoTransicion', () => {
  it('courier en ruta exige numero de seguimiento', () => {
    expect(requisitoTransicion({ modalidad: 'courier', numero_seguimiento: null }, 'en_ruta')).toMatch(/seguimiento/);
    expect(requisitoTransicion({ modalidad: 'courier', numero_seguimiento: '  ' }, 'en_ruta')).toMatch(/seguimiento/);
    expect(requisitoTransicion({ modalidad: 'courier', numero_seguimiento: '123' }, 'en_ruta')).toBeNull();
    expect(requisitoTransicion({ modalidad: 'propio', numero_seguimiento: null }, 'en_ruta')).toBeNull();
  });
});
