import { RELAY_BASE, KAPSO_URL } from '../../src/lib/constantes.js';
import { fechaCorta, formatCLP } from '../../src/lib/formato.js';
import type { GrupoPedido } from '../../src/lib/pedidos.js';
import { BotonesTransicion } from './BotonesTransicion.js';

type Pedido = GrupoPedido & { totalFmt: string; numeroCotizacion: number | null };

export function TarjetaPedido({ pedido }: { pedido: Pedido }) {
  return (
    <details className="tarjeta">
      <summary>
        <header>
          <span><b>{pedido.razonSocial ?? pedido.telefono ?? 'Sin cliente'}</b> · {pedido.totalFmt}</span>
          <span>
            <span className={`badge ${pedido.estadoNegocio}`}>{pedido.estadoNegocio}</span>{' '}
            {pedido.ocs.some((o) => o.correo === 'failed') ? <span className="badge fallo">OC fallida</span> : null}
          </span>
        </header>
        <div className="meta">
          {fechaCorta(pedido.fecha)}
          {pedido.numeroCotizacion !== null ? ` · Cotización N° ${pedido.numeroCotizacion}` : ''}
        </div>
      </summary>
      <table className="lineas">
        <thead><tr><th>Producto</th><th>Cant.</th><th>Unitario</th><th>Subtotal</th></tr></thead>
        <tbody>
          {pedido.lineas.map((l, i) => (
            <tr key={i}>
              <td>{l.nombre ?? '—'}</td>
              <td className="num">{l.cantidad ?? 0}</td>
              <td className="num">{formatCLP(l.precio_unitario_clp ?? 0)}</td>
              <td className="num">{formatCLP(l.subtotal_neto_clp ?? 0)}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="docs">
        <a href={`${RELAY_BASE}/api/cotizacion/${pedido.quoteId}`} target="_blank" rel="noreferrer">PDF cotización</a>
        {pedido.ocs.map((o) => (
          <a key={o.poId} href={`${RELAY_BASE}/api/orden/${o.poId}`} target="_blank" rel="noreferrer">
            OC {o.proveedor}{o.correo === 'failed' ? ' (correo falló)' : ''}
          </a>
        ))}
        <a href={KAPSO_URL} target="_blank" rel="noreferrer">Conversación ↗</a>
      </div>
      <BotonesTransicion quoteId={pedido.quoteId} version={pedido.version} estado={pedido.estadoNegocio} />
    </details>
  );
}
