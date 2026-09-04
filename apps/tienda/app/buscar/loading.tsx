// Esqueletos con la forma de las fichas, no un spinner: la busqueda cotiza en
// vivo contra tres mayoristas y puede tardar varios segundos, asi que la
// pagina muestra desde el primer instante lo que va a llegar.
export default function Cargando() {
  return (
    <>
      <header className="seccion" style={{ marginTop: 0 }}>
        <span className="rotulo">Consultando precios en los tres mayoristas…</span>
      </header>
      <div className="grilla" aria-hidden="true">
        {[0, 1, 2, 3, 4, 5].map((i) => (
          <div className="esqueleto" key={i}>
            <div className="barra" style={{ width: '38%' }} />
            <div className="barra" style={{ width: '88%', height: 15 }} />
            <div className="barra" style={{ width: '62%' }} />
            <div className="barra" style={{ width: '45%', marginTop: 22 }} />
          </div>
        ))}
      </div>
    </>
  );
}
