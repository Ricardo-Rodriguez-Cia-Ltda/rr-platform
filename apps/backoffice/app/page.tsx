import { cargarVistaPedidos } from '../src/lib/vista-pedidos.js';
import { TarjetaPedido } from './componentes/TarjetaPedido.js';

export const dynamic = 'force-dynamic';

export default async function Pedidos({ searchParams }: { searchParams: Promise<{ estado?: string }> }) {
  const { estado } = await searchParams;
  const vista = await cargarVistaPedidos();
  if (!vista) {
    return <div className="aviso-error">No se pudo cargar desde la base. <a href="/">Reintentar</a></div>;
  }
  const pedidos = estado ? vista.pedidos.filter((p) => p.estadoNegocio === estado) : vista.pedidos;
  return (
    <>
      <h1>Pedidos</h1>
      <div className="contadores">
        <div className="contador destacado"><b>{vista.contadores.porEntregar}</b><span>pagados por entregar</span></div>
        <div className="contador"><b>{vista.contadores.nuevos}</b><span>nuevos</span></div>
        <div className={vista.contadores.ocFallidas > 0 ? 'contador problema' : 'contador'}>
          <b>{vista.contadores.ocFallidas}</b><span>OC con correo fallido</span>
        </div>
      </div>
      <div className="chips">
        <a href="/" className={!estado ? 'activo' : ''}>Todos</a>
        <a href="/?estado=nuevo" className={estado === 'nuevo' ? 'activo' : ''}>Nuevos</a>
        <a href="/?estado=pagado" className={estado === 'pagado' ? 'activo' : ''}>Pagados</a>
        <a href="/?estado=entregado" className={estado === 'entregado' ? 'activo' : ''}>Entregados</a>
        <a href="/?estado=anulado" className={estado === 'anulado' ? 'activo' : ''}>Anulados</a>
      </div>
      {pedidos.length === 0 ? <p className="vacio">Nada por aquí — cuando el bot cierre una venta, aparece sola.</p> : pedidos.map((p) => (
        <TarjetaPedido key={`${p.quoteId}:${p.version}`} pedido={p} />
      ))}
    </>
  );
}
