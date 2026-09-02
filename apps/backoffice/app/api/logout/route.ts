import { COOKIE_NOMBRE } from '../../../src/lib/session.js';
export async function GET(): Promise<Response> {
  return new Response(null, {
    status: 303,
    headers: { Location: '/login', 'Set-Cookie': `${COOKIE_NOMBRE}=; HttpOnly; Secure; SameSite=Lax; Path=/; Max-Age=0` },
  });
}
