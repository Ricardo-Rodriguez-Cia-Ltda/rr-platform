import './globals.css';
import { KAPSO_URL } from '../src/lib/constantes.js';
export const metadata = { title: 'RR Backoffice' };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="es">
      <body>
        <nav className="barra">
          <span className="logo">RR</span>
          <a href="/">Pedidos</a>
          <a href="/cotizaciones">Cotizaciones</a>
          <a href="/clientes">Clientes</a>
          <a href="/salud">Salud</a>
          <a href={KAPSO_URL} target="_blank" rel="noreferrer">Conversaciones ↗</a>
          <a href="/api/logout" className="salir">Salir</a>
        </nav>
        <main>{children}</main>
      </body>
    </html>
  );
}
