import { timingSafeEqual } from 'node:crypto';

export function isAuthorized(
  providedKey: string | undefined,
  expectedKey: string | undefined,
): boolean {
  if (!providedKey || !expectedKey) return false;
  const provided = Buffer.from(providedKey);
  const expected = Buffer.from(expectedKey);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}
