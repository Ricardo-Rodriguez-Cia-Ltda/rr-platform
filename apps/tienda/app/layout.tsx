import './globals.css';
import type { Metadata } from 'next';
import { Bricolage_Grotesque, IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import { Header } from './componentes/Header.js';

// Tres roles, tres voces: Bricolage para titulos (una grotesca con caracter),
// Plex Sans para leer, Plex Mono para todo lo que es un DATO — precio, MPN,
// specs, cantidades. En una tienda sin fotos, la monoespaciada es lo que hace
// que un numero parezca medido y no escrito.
const display = Bricolage_Grotesque({ subsets: ['latin'], weight: ['600', '700'], variable: '--font-display' });
const texto = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-texto' });
const datos = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-datos' });

const DESCRIPCION =
  'Buscamos lo que necesitas en tres mayoristas y te damos el mejor precio, con stock real y factura. Ricardo Rodríguez y Cía. Ltda., más de 30 años vendiendo tecnología en Chile.';

export const metadata: Metadata = {
  title: { default: 'Dr. Computación', template: '%s · Dr. Computación' },
  description: DESCRIPCION,
  applicationName: 'Dr. Computación',
  openGraph: {
    title: 'Dr. Computación',
    description: DESCRIPCION,
    type: 'website',
    locale: 'es_CL',
  },
  icons: {
    // Favicon inline: la sigla de la marca, sin archivo binario que mantener.
    icon: [
      {
        url:
          "data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='7' fill='%230f5f57'/%3E%3Ctext x='16' y='22' font-family='Georgia,serif' font-size='16' font-weight='bold' fill='%23fafbfa' text-anchor='middle'%3EDr%3C/text%3E%3C/svg%3E",
        type: 'image/svg+xml',
      },
    ],
  },
};
export const viewport = { themeColor: '#f3f5f4' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const rayoWa = process.env.NEXT_PUBLIC_RAYO_WA ?? '';
  return (
    <html lang="es" className={`${display.variable} ${texto.variable} ${datos.variable}`}>
      <body>
        <a className="saltar" href="#contenido">Saltar al contenido</a>
        <Header />
        <main id="contenido">{children}</main>
        <footer className="pie">
          <div className="interior">
            <span>
              Dr. Computación · Ricardo Rodríguez y Cía. Ltda. — División Informática ·
              José M. Infante 2629, Ñuñoa, Santiago
            </span>
            <nav aria-label="Enlaces del pie">
              {rayoWa ? (
                <a href={`https://wa.me/${rayoWa}`} target="_blank" rel="noreferrer">
                  Escríbele al Rayo por WhatsApp
                </a>
              ) : null}
              <a href="/garantias">Garantías y devoluciones</a>
            </nav>
          </div>
        </footer>
      </body>
    </html>
  );
}
