'use client';
import { useEffect, useState } from 'react';
import { contarUnidades, leerCarro } from '../../src/lib/carro.js';

export function Header() {
  const [unidades, setUnidades] = useState(0);
  useEffect(() => {
    const refrescar = () => setUnidades(contarUnidades(leerCarro()));
    refrescar();
    window.addEventListener('carro-cambio', refrescar);
    window.addEventListener('storage', refrescar);
    return () => {
      window.removeEventListener('carro-cambio', refrescar);
      window.removeEventListener('storage', refrescar);
    };
  }, []);

  return (
    <header className="cabecera">
      <div className="interior">
        <a href="/" className="marca">
          <span className="sigla">Dr</span> Computación
        </a>
        <a href="/carro" className="link-carro">
          Carro
          {unidades > 0 ? (
            <span className="conteo" aria-label={`${unidades} unidades en el carro`}>{unidades}</span>
          ) : null}
        </a>
      </div>
    </header>
  );
}
