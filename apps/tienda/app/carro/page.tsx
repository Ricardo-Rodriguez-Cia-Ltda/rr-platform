import type { Metadata } from 'next';
import { cfgPrecios } from '../../src/lib/precios.js';
import { Checkout } from './Checkout.js';

export const metadata: Metadata = { title: 'Tu carro — Dr. Computación', robots: { index: false } };
// El IVA se lee en el servidor en cada request: IVA_RATE es una env var
// server-side y el total del carro tiene que calcularse con la MISMA tasa que
// usa generar-cotizacion-v2.
export const dynamic = 'force-dynamic';

export default function Carro() {
  const cfg = cfgPrecios();
  // Sin config de precios el catalogo tampoco carga, asi que el carro estaria
  // vacio; el 0.19 es solo para no romper el render de esa pagina vacia.
  return <Checkout iva={cfg?.iva ?? 0.19} />;
}
