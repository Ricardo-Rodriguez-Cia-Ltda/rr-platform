import { describe, expect, it } from 'vitest';
import { describirPago, type EstadoPago } from '../src/lib/pago.js';

const base: EstadoPago = {
  estado: 'pendiente', monto_clp: 1058793, intentos_rechazados: 0,
  expira_at: '2026-09-16T18:00:00Z', init_point: 'https://mp/pagar',
};

describe('describirPago', () => {
  it('pendiente y vigente: falta pagar, con boton, sigue consultando, sin comprobante', () => {
    const d = describirPago(base);
    expect(d.sello).toBe('Falta pagar');
    expect(d.titulo).toBe('Tu pedido está listo para pagar.');
    expect(d.accion).toBe('pagar');
    expect(d.seguirConsultando).toBe(true);
    expect(d.comprobante).toBe(false);
  });
  it('pendiente con rechazos: lo dice y ofrece reintentar con el mismo link', () => {
    const d = describirPago({ ...base, intentos_rechazados: 1 });
    expect(d.sello).toBe('Pago rechazado');
    expect(d.texto).toContain('reintentar');
    expect(d.accion).toBe('pagar');
    expect(d.seguirConsultando).toBe(true);
  });
  it('pendiente sin init_point: el link vencio, volver a la tienda, no sigue consultando', () => {
    const { init_point: _sinLink, ...vencida } = base;
    const d = describirPago(vencida);
    expect(d.sello).toBe('Link vencido');
    expect(d.texto).toContain('Vuelve a armar el pedido');
    expect(d.accion).toBe('volver');
    expect(d.seguirConsultando).toBe(false);
  });
  it('aprobado: recibimos tu pago, estamos cursando, sigue consultando', () => {
    const d = describirPago({ ...base, estado: 'aprobado', init_point: undefined });
    expect(d.sello).toBe('Pago recibido');
    expect(d.texto).toContain('Estamos cursando el pedido');
    expect(d.accion).toBe('ninguna');
    expect(d.seguirConsultando).toBe(true);
    expect(d.comprobante).toBe(false);
  });
  it('emitido: pedido cursado, comprobante, deja de consultar', () => {
    const d = describirPago({ ...base, estado: 'emitido', init_point: undefined });
    expect(d.sello).toBe('Pedido cursado');
    expect(d.titulo).toBe('Pago recibido ✅ Tu pedido quedó cursado.');
    expect(d.accion).toBe('ninguna');
    expect(d.seguirConsultando).toBe(false);
    expect(d.comprobante).toBe(true);
  });
  it('aprobado_sin_emitir: honesto, no promete que el pedido quedo cursado', () => {
    const d = describirPago({ ...base, estado: 'aprobado_sin_emitir', init_point: undefined });
    expect(d.sello).toBe('Pago recibido');
    expect(d.texto).toContain('te contactamos');
    expect(d.texto).not.toMatch(/cursado/i);
    expect(d.seguirConsultando).toBe(false);
    expect(d.comprobante).toBe(true);
  });
  it('null (404 del rele): no encontramos ese pedido, volver', () => {
    const d = describirPago(null);
    expect(d.titulo).toBe('No encontramos ese pedido.');
    expect(d.accion).toBe('volver');
    expect(d.seguirConsultando).toBe(false);
    expect(d.comprobante).toBe(false);
  });
  it('nunca dice "pagar" sin init_point, ni afirma cursado fuera de emitido', () => {
    for (const estado of ['aprobado', 'emitido', 'aprobado_sin_emitir'] as const) {
      const d = describirPago({ ...base, estado, init_point: undefined });
      expect(d.accion).not.toBe('pagar');
      if (estado !== 'emitido') expect(`${d.titulo} ${d.texto}`).not.toMatch(/quedó cursado/);
    }
  });

  describe('retornoAprobado (query param del retorno de Mercado Pago)', () => {
    it('con flag y pendiente vigente: no ofrece pagar, sigue consultando, sin comprobante', () => {
      const d = describirPago(base, { retornoAprobado: true });
      expect(d.accion).not.toBe('pagar');
      expect(d.accion).toBe('ninguna');
      expect(d.seguirConsultando).toBe(true);
      expect(d.comprobante).toBe(false);
      expect(d.sello).toBe('Pago en confirmación');
      expect(d.titulo).toBe('Estamos confirmando tu pago.');
    });
    it('con flag y pendiente con rechazos: igual se degrada, no ofrece pagar', () => {
      const d = describirPago({ ...base, intentos_rechazados: 1 }, { retornoAprobado: true });
      expect(d.accion).not.toBe('pagar');
      expect(d.seguirConsultando).toBe(true);
    });
    it('con flag y pendiente sin init_point (vencido): igual se degrada, no manda a volver', () => {
      const { init_point: _sinLink, ...vencida } = base;
      const d = describirPago(vencida, { retornoAprobado: true });
      expect(d.accion).not.toBe('volver');
      expect(d.accion).toBe('ninguna');
      expect(d.seguirConsultando).toBe(true);
    });
    it('con flag y emitido: igual que sin flag (el query param solo degrada, nunca sube la vista)', () => {
      const conFlag = describirPago({ ...base, estado: 'emitido', init_point: undefined }, { retornoAprobado: true });
      const sinFlag = describirPago({ ...base, estado: 'emitido', init_point: undefined });
      expect(conFlag).toEqual(sinFlag);
    });
    it('con flag y aprobado: igual que sin flag', () => {
      const conFlag = describirPago({ ...base, estado: 'aprobado', init_point: undefined }, { retornoAprobado: true });
      const sinFlag = describirPago({ ...base, estado: 'aprobado', init_point: undefined });
      expect(conFlag).toEqual(sinFlag);
    });
    it('con flag y aprobado_sin_emitir: igual que sin flag', () => {
      const conFlag = describirPago({ ...base, estado: 'aprobado_sin_emitir', init_point: undefined }, { retornoAprobado: true });
      const sinFlag = describirPago({ ...base, estado: 'aprobado_sin_emitir', init_point: undefined });
      expect(conFlag).toEqual(sinFlag);
    });
    it('sin flag: todo se comporta como antes', () => {
      const d = describirPago(base);
      expect(d.accion).toBe('pagar');
      expect(d.sello).toBe('Falta pagar');
    });
  });

  it('estado desconocido (cast): no lanza, forma conservadora, no ofrece pagar', () => {
    const d = describirPago({ ...base, estado: 'algo_nuevo' as EstadoPago['estado'], init_point: undefined });
    expect(d.sello).toBe('Pago en revisión');
    expect(d.titulo).toBe('Estamos revisando tu pedido.');
    expect(d.texto).toContain('WhatsApp');
    expect(d.accion).toBe('ninguna');
    expect(d.seguirConsultando).toBe(false);
    expect(d.comprobante).toBe(false);
  });
});
