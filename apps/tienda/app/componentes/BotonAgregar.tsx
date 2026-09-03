'use client';
import { useState } from 'react';
import { agregar, guardarCarro, leerCarro } from '../../src/lib/carro.js';
import type { ProductoTienda } from '../../src/lib/catalogo.js';

type Estado = { tipo: 'listo' } | { tipo: 'agregado' } | { tipo: 'tope'; mensaje: string };

export function BotonAgregar({ producto }: { producto: ProductoTienda }) {
  const [estado, setEstado] = useState<Estado>({ tipo: 'listo' });

  function alCarro() {
    const resultado = agregar(leerCarro(), {
      sku: producto.sku,
      mpn: producto.mpn,
      marca: producto.marca,
      nombre: producto.nombre,
      cantidad: 1,
      precioNetoClp: producto.precioNetoClp,
      precioTiendaClp: producto.precioClp,
    });
    if ('error' in resultado) {
      setEstado({ tipo: 'tope', mensaje: resultado.error });
      return;
    }
    guardarCarro(resultado);
    setEstado({ tipo: 'agregado' });
    setTimeout(() => setEstado({ tipo: 'listo' }), 1600);
  }

  if (estado.tipo === 'tope') {
    return <span className="agotado">{estado.mensaje}</span>;
  }

  return (
    <button className="boton-compra" onClick={alCarro}>
      {estado.tipo === 'agregado' ? 'Agregado' : 'Agregar'}
    </button>
  );
}
