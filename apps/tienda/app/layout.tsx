import './globals.css';
import { Bricolage_Grotesque, IBM_Plex_Mono, IBM_Plex_Sans } from 'next/font/google';
import { Header } from './componentes/Header.js';

// Tres roles, tres voces: Bricolage para los titulos (una grotesca con
// caracter, usada con restriccion), Plex Sans para leer, y Plex Mono para todo
// lo que es un DATO — precio, MPN, specs, cantidades. En una tienda sin fotos,
// la monoespaciada es lo que hace que un dato parezca medido y no escrito.
const display = Bricolage_Grotesque({ subsets: ['latin'], weight: ['600', '700'], variable: '--font-display' });
const texto = IBM_Plex_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-texto' });
const datos = IBM_Plex_Mono({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-datos' });

export const metadata = {
  title: 'Dr. Computación',
  description: 'Tecnología con diagnóstico: comparamos el precio de tres mayoristas y te damos el mejor, con stock real y respaldo formal.',
};
export const viewport = { themeColor: '#0e1a20' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const rayoWa = process.env.NEXT_PUBLIC_RAYO_WA ?? '';
  return (
    <html lang="es" className={`${display.variable} ${texto.variable} ${datos.variable}`}>
      <body>
        <Header />
        <main>{children}</main>
        <footer className="pie">
          <span>Dr. Computación · Ricardo Rodríguez y Cía. Ltda. — División Informática</span>
          {rayoWa ? (
            <a href={`https://wa.me/${rayoWa}`} target="_blank" rel="noreferrer">
              ¿Dudas? Escríbele al Rayo por WhatsApp
            </a>
          ) : null}
        </footer>
      </body>
    </html>
  );
}
