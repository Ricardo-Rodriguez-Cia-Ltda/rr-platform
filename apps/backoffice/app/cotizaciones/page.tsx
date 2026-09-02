import { cargarVistaCotizaciones } from '../../src/lib/vista-cotizaciones.js';
import { fechaCorta } from '../../src/lib/formato.js';

export const dynamic = 'force-dynamic';

export default async function Cotizaciones() {
  const vista = await cargarVistaCotizaciones(Date.now());
  if (!vista) return <div className="aviso-error">No se pudo cargar desde la base. <a href="/cotizaciones">Reintentar</a></div>;
  return (
    <>
      <h1>Cotizaciones</h1>
      {vista.filas.length === 0 ? <p className="vacio">Aún no hay cotizaciones.</p> : vista.filas.map((f) => (
        <div className="tarjeta" key={`${f.quoteId}:${f.version}`}>
          <header>
            <span><b>N° {f.numero ?? 'S/N'}</b> · {f.clienteLabel} · {f.totalFmt}</span>
            <span>
              <span className={`badge ${f.vigente ? 'entregado' : 'anulado'}`}>{f.vigente ? 'vigente' : 'expirada'}</span>{' '}
              {f.tienePedido ? <span className="badge pagado">→ pedido</span> : null}
            </span>
          </header>
          <div className="meta">{fechaCorta(f.fecha)} · <a href={f.pdfUrl} target="_blank" rel="noreferrer">PDF</a></div>
        </div>
      ))}
    </>
  );
}
