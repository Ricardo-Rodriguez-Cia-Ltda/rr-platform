import { describe, expect, it } from 'vitest';
import { formatCLP, fechaCorta } from '../src/lib/formato.js';

describe('formato', () => {
  it('CLP con puntos de miles', () => {
    expect(formatCLP(1221795)).toBe('$1.221.795');
  });
  it('fecha corta en hora de Santiago (UTC-4 el 1 de septiembre)', () => {
    expect(fechaCorta('2026-09-01T18:00:00.000Z')).toBe('01-09-2026 14:00');
  });
});
