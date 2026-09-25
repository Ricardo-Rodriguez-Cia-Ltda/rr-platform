import { cargarVistaCompras, type CompraVista } from '../../src/lib/vista-compras.js';
import { AccionesCompra } from '../componentes/AccionesCompra.js';

export const dynamic = 'force-dynamic';

const MODALIDAD: Record<string, string> = { retiro: 'Retiro', despacho_mayorista: 'Nos despacha el mayorista', directo_cliente: 'Directo al cliente' };

function Tarjeta({ c }: { c: CompraVista }) {
  const f = c.fila;
  const estado = f.estado_compra ?? 'por_comprar';
  return (
    <div className="tarjeta compra">
      <header>
        <span><b>{f.proveedor}</b> · {c.cliente}{c.numeroCotizacion ? ` · Pedido N° ${c.numeroCotizacion}` : ''}</span>
        <span>
          <span className={`badge ${estado}`}>{estado.replaceAll('_', ' ')}</span>{' '}
          {c.atrasada ? <span className="badge fallo">atrasada</span> : null}
        </span>
      </header>
      <div className="meta">
        {f.modalidad_compra ? MODALIDAD[f.modalidad_compra] : 'Sin comprar'}
        {f.numero_pedido_mayorista ? ` · N° ${f.numero_pedido_mayorista}` : ''}
        {f.llegada_estimada ? ` · llega ${f.llegada_estimada}` : ''}
        {f.guia_mayorista ? ` · guía ${f.guia_mayorista}` : ''}
        {f.nota_compra ? ` · ${f.nota_compra}` : ''}
      </div>
      <ul className="items">
        {c.lineas.map((l) => <li key={l.clave}>{l.nombre} · {l.recibida}/{l.cantidad} recibidos</li>)}
      </ul>
      <AccionesCompra poId={f.po_id} estado={estado} modalidad={f.modalidad_compra ?? null} lineas={c.lineas} />
    </div>
  );
}

export default async function Compras() {
  const v = await cargarVistaCompras();
  if (!v) return <div className="aviso-error">No se pudo cargar desde la base. <a href="/compras">Reintentar</a></div>;
  return (
    <>
      <h1>Compras</h1>
      <div className="contadores">
        <div className="contador destacado"><b>{v.porComprar.length}</b><span>por comprar</span></div>
        <div className="contador"><b>{v.enCurso.length}</b><span>en curso</span></div>
        <div className={v.atrasadas > 0 ? 'contador problema' : 'contador'}><b>{v.atrasadas}</b><span>atrasadas</span></div>
      </div>
      <h2>Por comprar</h2>
      {v.porComprar.length === 0 ? <p className="vacio">Nada por comprar.</p> : v.porComprar.map((c) => <Tarjeta key={c.fila.po_id} c={c} />)}
      <h2>En curso</h2>
      {v.enCurso.length === 0 ? <p className="vacio">Nada en camino.</p> : v.enCurso.map((c) => <Tarjeta key={c.fila.po_id} c={c} />)}
      <h2>Recibidas, por despachar</h2>
      {v.recibidas.length === 0 ? <p className="vacio">Nada recibido pendiente.</p> : v.recibidas.map((c) => <Tarjeta key={c.fila.po_id} c={c} />)}
    </>
  );
}
