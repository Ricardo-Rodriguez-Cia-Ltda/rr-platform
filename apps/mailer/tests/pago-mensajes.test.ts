import { describe, expect, it } from 'vitest';
import { mensajeRechazo, motivoRechazo } from '../src/pago/mensajes.js';

describe('motivoRechazo', () => {
  it('agrupa los status_detail de Mercado Pago por lo que el cliente puede hacer', () => {
    expect(motivoRechazo('cc_rejected_bad_filled_security_code')).toBe('datos');
    expect(motivoRechazo('cc_rejected_bad_filled_date')).toBe('datos');
    expect(motivoRechazo('cc_rejected_bad_filled_card_number')).toBe('datos');
    expect(motivoRechazo('cc_rejected_bad_filled_other')).toBe('datos');
    expect(motivoRechazo('cc_rejected_call_for_authorize')).toBe('banco');
    expect(motivoRechazo('cc_rejected_card_disabled')).toBe('banco');
    expect(motivoRechazo('cc_rejected_insufficient_amount')).toBe('fondos');
    expect(motivoRechazo('cc_rejected_high_risk')).toBe('otro');
    expect(motivoRechazo('cc_rejected_other_reason')).toBe('otro');
  });

  it('un motivo desconocido o ausente cae al generico', () => {
    expect(motivoRechazo('cc_rejected_algo_nuevo')).toBe('otro');
    expect(motivoRechazo(undefined)).toBe('otro');
    expect(motivoRechazo('')).toBe('otro');
  });
});

describe('mensajeRechazo', () => {
  it('siempre dice que el pago fue rechazado y explica que hacer segun el motivo', () => {
    const datos = mensajeRechazo('cc_rejected_bad_filled_security_code', true);
    expect(datos).toMatch(/^El pago fue rechazado/);
    expect(datos).toContain('dato de la tarjeta');

    expect(mensajeRechazo('cc_rejected_call_for_authorize', true)).toContain('Tu banco pidió autorizar el pago');
    expect(mensajeRechazo('cc_rejected_insufficient_amount', true)).toContain('cupo suficiente');
    expect(mensajeRechazo('cc_rejected_high_risk', true)).toContain('otra tarjeta');
  });

  it('con el link vigente invita a reintentar con el mismo link', () => {
    expect(mensajeRechazo('cc_rejected_insufficient_amount', true)).toContain('mismo link');
  });

  it('con el link vencido no ofrece reintentar: pide escribir para un link nuevo', () => {
    const m = mensajeRechazo('cc_rejected_insufficient_amount', false);
    expect(m).not.toContain('mismo link');
    expect(m).toContain('venció');
    expect(m).toContain('precios vigentes');
  });

  it('no ofrece otra forma de pago: la unica es la tarjeta por Mercado Pago', () => {
    for (const d of ['cc_rejected_bad_filled_date', 'cc_rejected_call_for_authorize', 'cc_rejected_insufficient_amount', 'x']) {
      for (const vigente of [true, false]) {
        expect(mensajeRechazo(d, vigente)).not.toMatch(/otra forma de pago/i);
      }
    }
  });
});
