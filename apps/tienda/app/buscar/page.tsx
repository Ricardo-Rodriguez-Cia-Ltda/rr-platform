import { buscarCatalogo } from '../../src/lib/catalogo.js';
import { TarjetaProducto } from '../componentes/TarjetaProducto.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30; // la busqueda cotiza en vivo contra la oficina

export default async function Buscar({ searchParams }: {
  searchParams: Promise<{ q?: string; categoria?: string; marca?: string }>;
}) {
  const { q, categoria, marca } = await searchParams;
  if (!q || q.trim().length < 2) {
    return (
      <div className="vacio">
        Escribe qué necesitas en el buscador. <a href="/">Volver a la portada</a>
      </div>
    );
  }
  const r = await buscarCatalogo({ q: q.trim(), categoria, marca });
  const link = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ q, ...(categoria ? { categoria } : {}), ...(marca ? { marca } : {}), ...extra });
    return `/buscar?${p.toString()}`;
  };

  const encabezado = (
    <header className="seccion" style={{ marginTop: 0 }}>
      <span className="rotulo">Búsqueda · precio consultado ahora</span>
      <h1 style={{ fontSize: 30, marginTop: 8 }}>{q}</h1>
    </header>
  );

  if (!r) {
    // El reintento tiene que volver a la MISMA busqueda: sin los filtros, el
    // link mandaba al cliente a una consulta distinta de la que fallo.
    return (
      <>
        {encabezado}
        <div className="aviso error">
          No pudimos consultar los precios en este momento. <a href={link({})}>Reintentar</a>
        </div>
      </>
    );
  }

  // La API responde 409 `demasiado_amplio` cuando hay mas de 25 coincidencias
  // y no vino ningun filtro. NO es una caida: es el camino normal de una
  // busqueda amplia, y viene con las facetas para acotarla.
  if (r.demasiadoAmplio) {
    return (
      <>
        {encabezado}
        <div className="aviso">
          Hay {r.total.toLocaleString('es-CL')} productos que calzan. Elige una marca o una categoría
          para que podamos consultar precios de verdad.
        </div>
        {r.marcas.length > 0 ? (
          <section className="seccion">
            <span className="rotulo">Por marca</span>
            <div className="chips" style={{ marginTop: 10 }}>
              {r.marcas.slice(0, 12).map((m) => (
                <a key={m} href={link({ marca: m })}>{m}</a>
              ))}
            </div>
          </section>
        ) : null}
        {r.categorias.length > 0 ? (
          <section className="seccion">
            <span className="rotulo">Por categoría</span>
            <div className="chips" style={{ marginTop: 10 }}>
              {r.categorias.slice(0, 12).map((c) => (
                <a key={c} href={link({ categoria: c })}>{c}</a>
              ))}
            </div>
          </section>
        ) : null}
      </>
    );
  }

  return (
    <>
      {encabezado}
      {r.marcas.length > 1 ? (
        <div className="chips">
          {marca ? <a href={link({ marca: '' })}>Todas las marcas</a> : null}
          {r.marcas.slice(0, 10).map((m) => (
            <a key={m} href={link({ marca: m })} className={m === marca ? 'activo' : ''}>{m}</a>
          ))}
        </div>
      ) : null}
      {r.parcial ? (
        <div className="aviso">
          Alcanzamos a consultar una parte del catálogo. Puede haber más resultados: acota
          por marca o categoría para verlos.
        </div>
      ) : null}
      {r.productos.length === 0 ? (
        <div className="vacio">
          <h2>Sin precio vigente para esa búsqueda.</h2>
          <p style={{ maxWidth: '40ch', margin: '0 auto' }}>
            Encontramos productos que calzan, pero ninguno tiene precio confirmado ahora mismo.
            Prueba con otras palabras, o escríbele al Rayo por WhatsApp y lo cotizamos a mano.
          </p>
          <p style={{ marginTop: 20 }}>
            <a className="enlace-texto" href="/">Volver a la portada</a>
          </p>
        </div>
      ) : (
        <div className="grilla destacada">
          {r.productos.map((p) => (
            <TarjetaProducto key={p.sku} producto={p} />
          ))}
        </div>
      )}
    </>
  );
}
