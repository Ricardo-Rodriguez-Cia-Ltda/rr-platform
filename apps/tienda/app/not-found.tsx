export const metadata = { title: 'Página no encontrada' };

export default function NoEncontrada() {
  return (
    <div className="vacio">
      <h2>Esta página no existe.</h2>
      <p style={{ maxWidth: '38ch', margin: '0 auto 22px' }}>
        Puede que el enlace esté viejo o que el producto ya no esté en catálogo. Prueba
        buscando lo que necesitas.
      </p>
      <form className="buscador" action="/buscar" method="get" role="search" style={{ margin: '0 auto' }}>
        <input type="search" name="q" placeholder="¿Qué buscabas?" aria-label="Qué buscabas" required minLength={2} />
        <button type="submit">Buscar</button>
      </form>
      <p style={{ marginTop: 20 }}>
        <a className="enlace-texto" href="/">Volver a la portada</a>
      </p>
    </div>
  );
}
