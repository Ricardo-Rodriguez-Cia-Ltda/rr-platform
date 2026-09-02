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
        <div className="contador"><b>{vista.contadores.porEntregar}</b><span>pagados por entregar</span></div>
        <div className="contador"><b>{vista.contadores.nuevos}</b><span>nuevos</span></div>
        <div className="contador"><b>{vista.contadores.ocFallidas}</b><span>OC con correo fallido</span></div>
      </div>
      <div className="meta" style={{ marginBottom: 10 }}>
        Filtrar: <a href="/">todos</a> · <a href="/?estado=nuevo">nuevos</a> · <a href="/?estado=pagado">pagados</a> · <a href="/?estado=entregado">entregados</a> · <a href="/?estado=anulado">anulados</a>
      </div>
      {pedidos.length === 0 ? <p className="meta">Sin pedidos.</p> : pedidos.map((p) => (
        <TarjetaPedido key={`${p.quoteId}:${p.version}`} pedido={p} />
      ))}
    </>
  );
}
