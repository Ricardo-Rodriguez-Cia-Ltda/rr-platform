import { describe, expect, it } from 'vitest';
import { isAuthorized } from '@rr/http/auth';

describe('isAuthorized', () => {
  it('accepts matching keys', () => {
    expect(isAuthorized('super-secret', 'super-secret')).toBe(true);
  });

  it('rejects wrong keys', () => {
    expect(isAuthorized('wrong', 'super-secret')).toBe(false);
  });

  it('rejects keys of different length', () => {
    expect(isAuthorized('super-secret-longer', 'super-secret')).toBe(false);
  });

  it('rejects missing provided key', () => {
    expect(isAuthorized(undefined, 'super-secret')).toBe(false);
  });

  it('rejects when the server key is not configured', () => {
    expect(isAuthorized('anything', undefined)).toBe(false);
    expect(isAuthorized('', '')).toBe(false);
  });
});
