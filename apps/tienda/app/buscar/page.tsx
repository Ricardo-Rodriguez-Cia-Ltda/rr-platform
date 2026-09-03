import { buscarCatalogo } from '../../src/lib/catalogo.js';
import { TarjetaProducto } from '../componentes/TarjetaProducto.js';

export const dynamic = 'force-dynamic';

export default async function Buscar({ searchParams }: {
  searchParams: Promise<{ q?: string; categoria?: string; marca?: string }>;
}) {
  const { q, categoria, marca } = await searchParams;
  if (!q || q.trim().length < 2) {
    return <p className="vacio">Escribe qué buscas en el buscador de la portada.</p>;
  }
  const r = await buscarCatalogo({ q: q.trim(), categoria, marca });
  const link = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ q, ...(categoria ? { categoria } : {}), ...(marca ? { marca } : {}), ...extra });
    return `/buscar?${p.toString()}`;
  };
  if (!r) {
    // El reintento tiene que volver a la MISMA busqueda: sin los filtros, el
    // link mandaba al cliente a una consulta distinta de la que fallo.
    return <div className="aviso error">No pudimos cargar el catálogo. <a href={link({})}>Reintentar</a></div>;
  }
  const chipsMarca = r.marcas.length > 1 ? (
    <div className="chips">
      {marca ? <a href={link({ marca: '' })}>Todas las marcas</a> : null}
      {r.marcas.slice(0, 10).map((m) => (
        <a key={m} href={link({ marca: m })} className={m === marca ? 'activo' : ''}>{m}</a>
      ))}
    </div>
  ) : null;

  // La API responde 409 `demasiado_amplio` cuando hay mas de 25 coincidencias
  // y no vino ningun filtro. NO es una caida: es el camino normal de una
  // busqueda amplia, y viene con las facetas para acotarla.
  if (r.demasiadoAmplio) {
    return (
      <>
        <h1>Resultados para “{q}”</h1>
        <div className="aviso">Tu búsqueda es muy amplia ({r.total} productos). Acota por marca o categoría:</div>
        {r.marcas.length > 0 ? (
          <div className="chips">
            {r.marcas.slice(0, 12).map((m) => <a key={m} href={link({ marca: m })}>{m}</a>)}
          </div>
        ) : null}
        {r.categorias.length > 0 ? (
          <div className="chips">
            {r.categorias.slice(0, 12).map((c) => <a key={c} href={link({ categoria: c })}>{c}</a>)}
          </div>
        ) : null}
      </>
    );
  }

  return (
    <>
      <h1>Resultados para “{q}”</h1>
      {chipsMarca}
      {r.parcial ? <div className="aviso">Mostramos lo alcanzado a revisar — puede haber más resultados; intenta acotar la búsqueda.</div> : null}
      {r.productos.length === 0
        ? <p className="vacio">No encontramos productos con precio vigente para esa búsqueda.</p>
        : <div className="grilla">{r.productos.map((p) => <TarjetaProducto key={p.sku} producto={p} />)}</div>}
    </>
  );
}
