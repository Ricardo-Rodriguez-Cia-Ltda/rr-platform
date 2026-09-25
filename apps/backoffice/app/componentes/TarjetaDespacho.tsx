import { COURIERS, mensajeCliente } from '../../src/lib/couriers.js';
import { formatCLP } from '../../src/lib/formato.js';
import type { Despacho } from '../../src/lib/lineas.js';
import type { PedidoLogistica } from '../../src/lib/vista-despachos.js';
import { AccionesDespacho } from './AccionesDespacho.js';

const MODALIDAD: Record<string, string> = { retiro_oficina: 'Retiro en oficina', propio: 'Despacho propio', courier: 'Courier' };

export function TarjetaDespacho({ despacho: d, pedido }: { despacho: Despacho; pedido: PedidoLogistica }) {
  const courier = d.courier ? COURIERS[d.courier] : null;
  const seguimiento = courier && d.numero_seguimiento ? courier.urlSeguimiento(d.numero_seguimiento) : null;
  const nombre = (poId: string, mpn: string) => pedido.resumen.find((r) => r.poId === poId && r.clave === mpn)?.nombre ?? mpn;
  return (
    <div className="tarjeta despacho" id={`despacho-${d.id}`}>
      <header>
        <span><b>Despacho N° {d.id}</b> · {pedido.cliente}{pedido.numeroCotizacion ? ` · Pedido N° ${pedido.numeroCotizacion}` : ''}</span>
        <span className={`badge ${d.estado}`}>{d.estado.replace('_', ' ')}</span>
      </header>
      <div className="meta">
        {MODALIDAD[d.modalidad]}{courier ? ` · ${courier.nombre}` : ''}
        {d.numero_seguimiento ? <> · N° {seguimiento ? <a href={seguimiento.url} target="_blank" rel="noreferrer">{d.numero_seguimiento}</a> : d.numero_seguimiento}</> : null}
        {d.comuna ? ` · ${d.comuna}` : ''}{d.fecha_programada ? ` · para el ${d.fecha_programada}` : ''}{d.responsable ? ` · ${d.responsable}` : ''}
        {d.cobrado_clp ? ` · envío ${formatCLP(d.cobrado_clp)}${d.cobro_pagado ? ' pagado' : ' por cobrar'}` : ''}
      </div>
      <ul className="items">
        {d.lineas.map((l) => <li key={`${l.po_id}-${l.mpn}`}>{l.cantidad} × {nombre(l.po_id, l.mpn)}</li>)}
      </ul>
      <AccionesDespacho
        id={d.id} estado={d.estado} modalidad={d.modalidad} numeroSeguimiento={d.numero_seguimiento}
        costo={d.costo_clp} cobrado={d.cobrado_clp} cobroPagado={d.cobro_pagado}
        mensaje={mensajeCliente(d, { numeroCotizacion: pedido.numeroCotizacion, contacto: d.contacto_nombre })}
      />
    </div>
  );
}
