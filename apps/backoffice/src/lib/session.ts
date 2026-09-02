// Sesion del backoffice: token `exp.firma` donde exp es epoch-ms de
// vencimiento y firma es HMAC-SHA256(exp, secret) en base64url. Web Crypto
// (no node:crypto) porque el middleware de Next corre en el runtime Edge.
export const VIGENCIA_MS = 30 * 24 * 60 * 60 * 1000;
export const COOKIE_NOMBRE = 'bo_session';

async function hmac(datos: string, secret: string): Promise<string> {
  const key = await crypto.subtle.importKey(
    'raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'],
  );
  const firma = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(datos));
  const bytes = new Uint8Array(firma);
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// Comparacion de tiempo constante sobre strings del mismo largo.
function igualesConstante(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function crearToken(secret: string, ahoraMs: number): Promise<string> {
  const exp = String(ahoraMs + VIGENCIA_MS);
  return `${exp}.${await hmac(exp, secret)}`;
}

export async function tokenValido(token: string | undefined, secret: string, ahoraMs: number): Promise<boolean> {
  if (!token || !secret) return false;
  const punto = token.indexOf('.');
  if (punto < 1) return false;
  const exp = token.slice(0, punto);
  const firma = token.slice(punto + 1);
  if (!/^\d+$/.test(exp) || Number(exp) <= ahoraMs) return false;
  return igualesConstante(firma, await hmac(exp, secret));
}
