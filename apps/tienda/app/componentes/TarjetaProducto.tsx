import type { ProductoTienda } from '../../src/lib/catalogo.js';
import { BotonAgregar } from './BotonAgregar.js';

export function TarjetaProducto({ producto }: { producto: ProductoTienda }) {
  return (
    <div className="tarjeta-producto">
      <span className="marca-prod">{producto.marca ?? 'Sin marca'}</span>
      <span className="nombre">{producto.nombre}</span>
      {producto.mpn ? <span className="mpn">Modelo {producto.mpn}</span> : null}
      <div>
        <div className="precio">{producto.precioFmt}</div>
        <div className="leyenda-iva">IVA incluido</div>
      </div>
      <BotonAgregar producto={producto} />
    </div>
  );
}
