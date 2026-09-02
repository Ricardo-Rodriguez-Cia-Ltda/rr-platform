'use client';
import { usePathname } from 'next/navigation';
import { KAPSO_URL } from '../../src/lib/constantes.js';

// Una sola fuente de verdad para las vistas: la barra superior (escritorio)
// y la barra inferior (movil) se dibujan desde esta lista. El estado activo
// necesita usePathname, por eso este es el unico pedazo cliente del marco.
const VISTAS = [
  { href: '/', label: 'Pedidos', icon: <path d="M3 7.5 12 3l9 4.5v9L12 21l-9-4.5v-9Zm0 0L12 12m0 0 9-4.5M12 12v9" /> },
  { href: '/cotizaciones', label: 'Cotizaciones', icon: <path d="M6 3h8l4 4v14H6V3Zm8 0v4h4M9 12h6M9 16h6" /> },
  { href: '/clientes', label: 'Clientes', icon: <><circle cx="12" cy="8" r="3.5" /><path d="M5 20c1.3-3.5 4-5.2 7-5.2s5.7 1.7 7 5.2" /></> },
  { href: '/salud', label: 'Salud', icon: <path d="M3 12h4l3-7 4 14 3-7h4" /> },
];

function Icono({ children }: { children: React.ReactNode }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      {children}
    </svg>
  );
}

function activo(pathname: string, href: string): boolean {
  return href === '/' ? pathname === '/' : pathname.startsWith(href);
}

export function Nav() {
  const pathname = usePathname();
  if (pathname === '/login') return null;

  return (
    <>
      <nav className="barra">
        <a href="/" className="logo" aria-label="Pedidos">R</a>
        <div className="barra-vistas">
          {VISTAS.map((v) => (
            <a key={v.href} href={v.href} className={activo(pathname, v.href) ? 'activo' : ''}>
              {v.label}
            </a>
          ))}
        </div>
        <div className="barra-extras">
          <a href={KAPSO_URL} target="_blank" rel="noreferrer">Conversaciones ↗</a>
          <a href="/api/logout" className="salir">Salir</a>
        </div>
      </nav>
      <nav className="barra-movil">
        {VISTAS.map((v) => (
          <a key={v.href} href={v.href} className={activo(pathname, v.href) ? 'activo' : ''}>
            <Icono>{v.icon}</Icono>
            <span>{v.label}</span>
          </a>
        ))}
      </nav>
    </>
  );
}
