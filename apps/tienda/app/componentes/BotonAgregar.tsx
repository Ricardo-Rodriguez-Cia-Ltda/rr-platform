'use client';
import { useState } from 'react';
import { agregar, guardarCarro, leerCarro } from '../../src/lib/carro.js';
import type { ProductoTienda } from '../../src/lib/catalogo.js';

export function BotonAgregar({ producto }: { producto: ProductoTienda }) {
  const [estado, setEstado] = useState<'listo' | 'agregado' | string>('listo');
  function alCarro() {
    const resultado = agregar(leerCarro(), {
      sku: producto.sku, mpn: producto.mpn, marca: producto.marca,
      nombre: producto.nombre, cantidad: 1,
      // El neto es lo que suma el total (como el bot); el otro es para mostrar.
      precioNetoClp: producto.precioNetoClp, precioTiendaClp: producto.precioClp,
    });
    if ('error' in resultado) { setEstado(resultado.error); return; }
    guardarCarro(resultado);
    setEstado('agregado');
    setTimeout(() => setEstado('listo'), 1500);
  }
  if (!producto.disponible) return <span className="agotado">Sin stock inmediato</span>;
  return (
    <>
      <button className="boton-compra" onClick={alCarro}>
        {estado === 'agregado' ? 'Agregado ✓' : 'Agregar al carro'}
      </button>
      {estado !== 'listo' && estado !== 'agregado' ? <span className="agotado">{estado}</span> : null}
    </>
  );
}
