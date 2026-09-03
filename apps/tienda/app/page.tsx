import { cargarDestacados, cargarPortada, type GrupoDestacado } from '../src/lib/catalogo.js';
import { TarjetaProducto } from './componentes/TarjetaProducto.js';

export const dynamic = 'force-dynamic';
export const maxDuration = 30; // las facetas salen del catalogo de la oficina

// Los destacados son vitrina, no el corazon de la pagina: si la oficina se
// demora mas que esto, la portada sale sin ellos en vez de hacer esperar al
// visitante frente a una pantalla en blanco. El buscador es lo esencial.
const PRESUPUESTO_DESTACADOS_MS = 8000;
const CATEGORIAS_DESTACADAS = 3;

async function destacadosConPresupuesto(categorias: string[]): Promise<GrupoDestacado[]> {
  const aTiempo = cargarDestacados(categorias.slice(0, CATEGORIAS_DESTACADAS)).catch(() => []);
  const seAcaboElTiempo = new Promise<GrupoDestacado[]>((resolve) => {
    setTimeout(() => resolve([]), PRESUPUESTO_DESTACADOS_MS);
  });
  return Promise.race([aTiempo, seAcaboElTiempo]);
}

export default async function Home() {
  const portada = await cargarPortada();
  const destacados = portada ? await destacadosConPresupuesto(portada.categorias) : [];

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
      {destacados.map((grupo) => (
        <section className="destacados" key={grupo.categoria}>
          <header>
            <h2>{grupo.categoria}</h2>
            <a href={`/buscar?q=${encodeURIComponent(grupo.categoria)}&categoria=${encodeURIComponent(grupo.categoria)}`}>
              Ver todo →
            </a>
          </header>
          <div className="grilla">
            {grupo.productos.map((p) => (
              <TarjetaProducto key={p.sku} producto={p} />
            ))}
          </div>
        </section>
      ))}
    </>
  );
}
