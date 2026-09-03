import type { ProductoTienda } from '../../src/lib/catalogo.js';
import { leerFicha } from '../../src/lib/ficha.js';
import { BotonAgregar } from './BotonAgregar.js';

/**
 * La ficha: sin fotos, el dato es la imagen. El nombre del catalogo se lee
 * como lo que ya era (identificador + specs + resto) y cada pieza ocupa su
 * lugar en la lectura: marca y disponibilidad arriba, el equipo al medio, el
 * identificador y el precio abajo, separados por la linea del pie.
 */
export function TarjetaProducto({ producto }: { producto: ProductoTienda }) {
  const ficha = leerFicha(producto.nombre, producto.marca);

  return (
    <article className="ficha">
      <div className="encabezado">
        <span className="marca-prod">{producto.marca ?? 'Sin marca'}</span>
        <span className={producto.disponible ? 'estado hay' : 'estado no'}>
          {producto.disponible ? 'En stock' : 'Por encargo'}
        </span>
      </div>

      <h3 className="titulo">{ficha.titulo || producto.nombre}</h3>

      {ficha.specs.length > 0 ? (
        <div className="specs">
          {ficha.specs.map((s) => (
            <span key={s}>{s}</span>
          ))}
        </div>
      ) : null}

      {ficha.detalle ? <p className="detalle">{ficha.detalle}</p> : null}

      <div className="pie">
        <div>
          <div className="mpn">{producto.mpn ?? producto.sku}</div>
          <div className="precio">{producto.precioFmt}</div>
          <div className="leyenda-iva">IVA incluido</div>
        </div>
        <BotonAgregar producto={producto} />
      </div>
    </article>
  );
}
