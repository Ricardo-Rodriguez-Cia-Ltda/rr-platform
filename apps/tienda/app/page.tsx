import { cargarPortada } from '../src/lib/catalogo.js';

export const dynamic = 'force-dynamic';

export default async function Home() {
  const portada = await cargarPortada();
  return (
    <>
      <section className="hero">
        <h1>El doctor de los computadores</h1>
        <p>Busca entre miles de productos de tecnología: comparamos el precio de tres mayoristas y te damos el mejor, con respaldo formal.</p>
        <form className="buscador" action="/buscar" method="get">
          <input type="search" name="q" placeholder="¿Qué necesitas? Ej: notebook 16GB" required minLength={2} />
          <button type="submit">Buscar</button>
        </form>
      </section>
      {portada && portada.categorias.length > 0 ? (
        <div className="chips">
          {portada.categorias.slice(0, 12).map((c) => (
            <a key={c} href={`/buscar?q=${encodeURIComponent(c)}&categoria=${encodeURIComponent(c)}`}>{c}</a>
          ))}
        </div>
      ) : null}
      {!portada ? (
        <div className="aviso">Estamos teniendo problemas para cargar el catálogo. Puedes intentar tu búsqueda igual o reintentar en unos minutos.</div>
      ) : null}
    </>
  );
}
