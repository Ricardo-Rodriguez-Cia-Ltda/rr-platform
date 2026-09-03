import './globals.css';
import { Fraunces, Instrument_Sans } from 'next/font/google';
import { Header } from './componentes/Header.js';

const marca = Fraunces({ subsets: ['latin'], weight: ['500', '600', '700'], variable: '--font-marca' });
const texto = Instrument_Sans({ subsets: ['latin'], weight: ['400', '500', '600'], variable: '--font-texto' });

export const metadata = {
  title: 'Dr. Computación',
  description: 'Tecnología con diagnóstico experto: busca, compara y compra con el mejor precio de tres mayoristas.',
};
export const viewport = { themeColor: '#0f6b5e' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const rayoWa = process.env.NEXT_PUBLIC_RAYO_WA ?? '';
  return (
    <html lang="es" className={`${marca.variable} ${texto.variable}`}>
      <body>
        <Header />
        <main>{children}</main>
        <footer className="pie">
          <span>Dr. Computación — venta de tecnología con respaldo formal.</span>
          {rayoWa ? (
            <a href={`https://wa.me/${rayoWa}`} target="_blank" rel="noreferrer">
              ¿Dudas? Háblale al Rayo por WhatsApp
            </a>
          ) : null}
        </footer>
      </body>
    </html>
  );
}
