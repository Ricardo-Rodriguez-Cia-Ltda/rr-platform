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
  if (!r) {
    return <div className="aviso error">No pudimos cargar el catálogo. <a href={`/buscar?q=${encodeURIComponent(q)}`}>Reintentar</a></div>;
  }
  const link = (extra: Record<string, string>) => {
    const p = new URLSearchParams({ q, ...(categoria ? { categoria } : {}), ...(marca ? { marca } : {}), ...extra });
    return `/buscar?${p.toString()}`;
  };
  return (
    <>
      <h1>Resultados para “{q}”</h1>
      {r.marcas.length > 1 ? (
        <div className="chips">
          {marca ? <a href={link({ marca: '' })}>Todas las marcas</a> : null}
          {r.marcas.slice(0, 10).map((m) => (
            <a key={m} href={link({ marca: m })} className={m === marca ? 'activo' : ''}>{m}</a>
          ))}
        </div>
      ) : null}
      {r.parcial ? <div className="aviso">Mostramos lo alcanzado a revisar — puede haber más resultados; intenta acotar la búsqueda.</div> : null}
      {r.productos.length === 0
        ? <p className="vacio">No encontramos productos con precio vigente para esa búsqueda.</p>
        : <div className="grilla">{r.productos.map((p) => <TarjetaProducto key={p.sku} producto={p} />)}</div>}
    </>
  );
}
