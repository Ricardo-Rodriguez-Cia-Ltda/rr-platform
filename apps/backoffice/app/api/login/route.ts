import { crearToken, COOKIE_NOMBRE, VIGENCIA_MS } from '../../../src/lib/session.js';

// Comparacion de tiempo constante via digests SHA-256 (largos iguales, sin
// fuga de longitud de la clave real).
async function claveCorrecta(entregada: string, real: string): Promise<boolean> {
  const [a, b] = await Promise.all([
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(entregada)),
    crypto.subtle.digest('SHA-256', new TextEncoder().encode(real)),
  ]);
  const va = new Uint8Array(a); const vb = new Uint8Array(b);
  let diff = 0;
  for (let i = 0; i < va.length; i++) diff |= va[i] ^ vb[i];
  return diff === 0;
}

export async function POST(req: Request): Promise<Response> {
  const form = await req.formData().catch(() => null);
  const password = String(form?.get('password') ?? '');
  const real = process.env.BACKOFFICE_PASSWORD ?? '';
  const secret = process.env.BACKOFFICE_SESSION_SECRET ?? '';

  // Sin secretos configurados nadie entra (real vacia nunca calza porque
  // igual pasa por el digest, y ademas se exige no-vacia).
  const ok = real !== '' && secret !== '' && (await claveCorrecta(password, real));
  if (!ok) {
    await new Promise((r) => setTimeout(r, 1000)); // freno de fuerza bruta
    return new Response(null, { status: 303, headers: { Location: '/login?error=1' } });
  }
  const token = await crearToken(secret, Date.now());
  return new Response(null, {
    status: 303,
    headers: {
      Location: '/',
      'Set-Cookie': `${COOKIE_NOMBRE}=${token}; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=${Math.floor(VIGENCIA_MS / 1000)}`,
    },
  });
}
