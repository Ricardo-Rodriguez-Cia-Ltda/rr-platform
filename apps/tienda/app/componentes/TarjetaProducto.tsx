import type { ProductoTienda } from '../../src/lib/catalogo.js';
import { leerFicha } from '../../src/lib/ficha.js';
import { BotonAgregar } from './BotonAgregar.js';

/**
 * La tarjeta: arriba la foto del banco cuando existe; si no, la misma caja
 * neutral con marca y part number. El nombre del catalogo se lee como lo que
 * ya era (identificador + specs + resto) y cada pieza ocupa su lugar: marca
 * y disponibilidad arriba, el equipo al medio, el identificador y el precio
 * abajo. La caja cuadrada siempre esta: pareja la grilla cuando la cobertura
 * de fotos es parcial.
 */
export function TarjetaProducto({ producto }: { producto: ProductoTienda }) {
  const ficha = leerFicha(producto.nombre, producto.marca);

  return (
    <article className="ficha">
      {producto.foto ? (
        <div className="foto">
          {/* <img> y no next/image: las fotos ya vienen a 500-640 px desde el
              banco y asi no dependemos de la optimizacion de Vercel. */}
          <img src={producto.foto} alt={ficha.titulo || producto.nombre} loading="lazy" decoding="async" />
        </div>
      ) : (
        <div className="foto vacia" aria-hidden="true">
          <span className="vacia-marca">{producto.marca ?? 'Sin marca'}</span>
          <span className="vacia-mpn">{producto.mpn ?? producto.sku}</span>
        </div>
      )}

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
