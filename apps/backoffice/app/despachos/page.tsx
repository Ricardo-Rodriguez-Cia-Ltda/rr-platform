import { cargarVistaDespachos } from '../../src/lib/vista-despachos.js';
import { FormularioDespacho } from '../componentes/FormularioDespacho.js';
import { TarjetaDespacho } from '../componentes/TarjetaDespacho.js';

export const dynamic = 'force-dynamic';

export default async function Despachos() {
  const v = await cargarVistaDespachos();
  if (!v) return <div className="aviso-error">No se pudo cargar desde la base. <a href="/despachos">Reintentar</a></div>;
  return (
    <>
      <h1>Despachos</h1>
      <div className="contadores">
        <div className="contador destacado"><b>{v.porAsignar.length}</b><span>pedidos por despachar</span></div>
        <div className="contador"><b>{v.activos.length}</b><span>despachos en curso</span></div>
        <div className={v.cobrosPendientes.length > 0 ? 'contador problema' : 'contador'}><b>{v.cobrosPendientes.length}</b><span>envíos por cobrar</span></div>
      </div>

      <h2>Pedidos por despachar</h2>
      {v.porAsignar.length === 0 ? <p className="vacio">Todo lo pagado ya tiene despacho.</p> : v.porAsignar.map((p) => (
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
          <FormularioDespacho
            quoteId={p.quoteId} version={p.version}
            pendientes={p.resumen.filter((r) => r.pendiente > 0).map((r) => ({ poId: r.poId, clave: r.clave, nombre: r.nombre, pendiente: r.pendiente, recibida: r.recibida }))}
            facturacion={p.facturacion} contacto={{ nombre: p.cliente, telefono: p.telefono }}
          />
        </div>
      ))}

      <h2>En curso</h2>
      {v.activos.length === 0 ? <p className="vacio">No hay despachos en curso.</p> : v.activos.map((a) => <TarjetaDespacho key={a.despacho.id} despacho={a.despacho} pedido={a.pedido} />)}

      <h2>Envíos por cobrar</h2>
      {v.cobrosPendientes.length === 0 ? <p className="vacio">Nada por cobrar.</p> : v.cobrosPendientes.map((a) => <TarjetaDespacho key={`c-${a.despacho.id}`} despacho={a.despacho} pedido={a.pedido} />)}

      <h2>Entregados recientes</h2>
      {v.entregadosRecientes.length === 0 ? <p className="vacio">Todavía no hay entregas.</p> : v.entregadosRecientes.map((a) => <TarjetaDespacho key={`e-${a.despacho.id}`} despacho={a.despacho} pedido={a.pedido} />)}
    </>
  );
}
