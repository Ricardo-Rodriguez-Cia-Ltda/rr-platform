import { formatCLP } from '../../src/lib/formato.js';
import { cargarVistaDespachos } from '../../src/lib/vista-despachos.js';
import { FormularioDespacho } from '../componentes/FormularioDespacho.js';
import { TarjetaDespacho } from '../componentes/TarjetaDespacho.js';

export const dynamic = 'force-dynamic';

const esListoParaRetiro = (d: { modalidad: string; estado: string }) => d.modalidad === 'retiro_oficina' && d.estado === 'listo';

export default async function Despachos() {
  const v = await cargarVistaDespachos();
  if (!v) return <div className="aviso-error">No se pudo cargar desde la base. <a href="/despachos">Reintentar</a></div>;

  // "Listos para retiro en oficina" sale de "En curso" para que ningun
  // despacho aparezca dos veces como tarjeta completa.
  const listosRetiro = v.activos.filter((a) => esListoParaRetiro(a.despacho));
  const enCurso = v.activos.filter((a) => !esListoParaRetiro(a.despacho));

  return (
    <>
      <h1>Despachos</h1>
      <div className="contadores">
        <div className="contador destacado"><b>{v.porAsignar.length}</b><span>pedidos por despachar</span></div>
        <div className="contador"><b>{enCurso.length}</b><span>despachos en curso</span></div>
        <div className="contador"><b>{listosRetiro.length}</b><span>listos para retiro en oficina</span></div>
        <div className={v.cobrosPendientes.length > 0 ? 'contador problema' : 'contador'}><b>{v.cobrosPendientes.length}</b><span>envíos por cobrar</span></div>
      </div>

      <h2>Pedidos por despachar</h2>
      {v.porAsignar.length === 0 ? <p className="vacio">Todo lo pagado ya tiene despacho.</p> : v.porAsignar.map((p) => {
        const despachosPedido = p.despachos.filter((d) => d.estado !== 'anulado');
        return (
          <div key={`${p.quoteId}:${p.version}`} className="tarjeta">
            <header><span><b>{p.cliente}</b>{p.numeroCotizacion ? ` · Pedido N° ${p.numeroCotizacion}` : ''}</span></header>
            <table className="lineas">
              <thead><tr><th>Producto</th><th>Comprado</th><th>Recibido</th><th>Asignado</th><th>Entregado</th></tr></thead>
              <tbody>
                {p.resumen.map((r) => (
                  <tr key={`${r.poId}-${r.clave}`}>
                    <td>{r.nombre}{r.directo ? ' (directo del mayorista)' : ''}</td>
                    <td className="num">{r.cantidad}</td><td className="num">{r.recibida}</td>
                    <td className="num">{r.asignada}</td><td className="num">{r.directo ? (r.entregadaDirecto ? r.cantidad : 0) : r.entregada}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            {despachosPedido.length > 0 ? (
              <ul className="items">
                {despachosPedido.map((d) => (
                  <li key={d.id}>
                    <a href={`#despacho-${d.id}`}>
                      Despacho N° {d.id} · {d.estado.replace('_', ' ')} · {d.lineas.reduce((n, l) => n + l.cantidad, 0)} unidades
                    </a>
                  </li>
                ))}
              </ul>
            ) : null}
            <FormularioDespacho
              quoteId={p.quoteId} version={p.version}
              pendientes={p.resumen.filter((r) => r.pendiente > 0).map((r) => ({ poId: r.poId, clave: r.clave, nombre: r.nombre, pendiente: r.pendiente, recibida: r.recibida }))}
              facturacion={p.facturacion} contacto={{ nombre: p.cliente, telefono: p.telefono }}
            />
          </div>
        );
      })}

      <h2>En curso</h2>
      {enCurso.length === 0 ? <p className="vacio">No hay despachos en curso.</p> : enCurso.map((a) => <TarjetaDespacho key={a.despacho.id} despacho={a.despacho} pedido={a.pedido} />)}

      <h2>Listos para retiro en oficina</h2>
      {listosRetiro.length === 0 ? <p className="vacio">Nada listo para retiro.</p> : listosRetiro.map((a) => <TarjetaDespacho key={a.despacho.id} despacho={a.despacho} pedido={a.pedido} />)}

      <h2>Envíos por cobrar</h2>
      {v.cobrosPendientes.length === 0 ? <p className="vacio">Nada por cobrar.</p> : (
        <ul className="items">
          {v.cobrosPendientes.map((a) => (
            <li key={`c-${a.despacho.id}`}>
              <a href={`#despacho-${a.despacho.id}`}>
                Despacho N° {a.despacho.id} · {a.pedido.cliente} · {formatCLP(a.despacho.cobrado_clp ?? 0)} por cobrar
              </a>
            </li>
          ))}
        </ul>
      )}

      <h2>Entregados recientes</h2>
      {v.entregadosRecientes.length === 0 ? <p className="vacio">Todavía no hay entregas.</p> : v.entregadosRecientes.map((a) => <TarjetaDespacho key={`e-${a.despacho.id}`} despacho={a.despacho} pedido={a.pedido} />)}
    </>
  );
}
