import { cargarFichaCliente } from '../../../src/lib/vista-clientes.js';
import { fechaCorta } from '../../../src/lib/formato.js';

export const dynamic = 'force-dynamic';

export default async function Ficha({ params }: { params: Promise<{ telefono: string }> }) {
  const { telefono } = await params;
  const ficha = await cargarFichaCliente(telefono);
  if (ficha === null) return <div className="aviso-error">No se pudo cargar desde la base. Reintenta.</div>;
  if (ficha === 'no_existe') return <div className="aviso-error">No hay cliente guardado con ese teléfono.</div>;
  const d = ficha.datos;
  return (
    <>
      <h1>{d.razonSocial}</h1>
      <div className="tarjeta">
        <p>R.U.T. {d.rut} · {d.giro}</p>
        <p className="meta">{d.direccion}, {d.comuna}, {d.ciudad} · {d.email} · +{d.telefono}</p>
      </div>
      <h1>Cotizaciones</h1>
      {ficha.cotizaciones.length === 0 ? <p className="meta">Ninguna.</p> : ficha.cotizaciones.map((q, i) => (
        <div className="tarjeta" key={i}><header><span>N° {q.numero ?? 'S/N'} · {q.totalFmt}</span><span className="meta">{fechaCorta(q.fecha)}</span></header></div>
      ))}
      <h1>Pedidos</h1>
      {ficha.pedidos.length === 0 ? <p className="meta">Ninguno.</p> : ficha.pedidos.map((p, i) => (
        <div className="tarjeta" key={i}><header><span className={`badge ${p.estadoNegocio}`}>{p.estadoNegocio}</span><span className="meta">{fechaCorta(p.fecha)}</span></header></div>
      ))}
    </>
  );
}
