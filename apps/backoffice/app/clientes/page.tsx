import { cargarClientes } from '../../src/lib/vista-clientes.js';

export const dynamic = 'force-dynamic';

export default async function Clientes() {
  const clientes = await cargarClientes();
  if (clientes === null) return <div className="aviso-error">No se pudo cargar desde la base. <a href="/clientes">Reintentar</a></div>;
  return (
    <>
      <h1>Clientes</h1>
      {clientes.length === 0 ? <p className="vacio">Aún no hay clientes guardados.</p> : clientes.map((c) => (
        <div className="tarjeta" key={c.telefono}>
          <header>
            <span><b><a href={`/clientes/${c.telefono}`}>{c.razonSocial}</a></b></span>
            <span className="meta">{c.rut} · +{c.telefono}</span>
          </header>
        </div>
      ))}
    </>
  );
}
