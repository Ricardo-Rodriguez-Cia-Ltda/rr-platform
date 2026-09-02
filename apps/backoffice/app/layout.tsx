import './globals.css';
import { Archivo, Public_Sans } from 'next/font/google';
import { Nav } from './componentes/Nav.js';

// Tipografia de la casa: Archivo para titulos y numeros (geometrica, con
// tabular-nums decentes), Public Sans para el texto. next/font las sirve
// self-hosted desde el build — sin requests a Google en runtime.
const display = Archivo({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-display' });
const texto = Public_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-texto' });

export const metadata = { title: 'RR Backoffice' };
export const viewport = { themeColor: '#3b3bb3' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es" className={`${display.variable} ${texto.variable}`}>
      <body>
        <Nav />
        <main>{children}</main>
      </body>
    </html>
  );
}
