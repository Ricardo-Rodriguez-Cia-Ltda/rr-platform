'use client';
import { useEffect, useState } from 'react';
import { formatCLP } from '../../../src/lib/precios.js';

const RELAY = 'https://rr-mailing.vercel.app';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function Resumen({ quoteId }: { quoteId: string }) {
  const [detalle, setDetalle] = useState<{ totalClp: number; avisoOc: boolean; avisoAbastecimiento?: boolean } | null>(null);
  useEffect(() => {
    try {
      const crudo = sessionStorage.getItem(`drc-pedido-${quoteId}`);
      if (crudo) setDetalle(JSON.parse(crudo));
    } catch { /* sin detalle igual mostramos la confirmacion */ }
  }, [quoteId]);

  if (!UUID_RE.test(quoteId)) {
    return <div className="vacio">No encontramos ese pedido. <a href="/">Volver a la tienda</a></div>;
  }
  return (
    <div className="recibo">
      <span className="sello">Pedido recibido</span>
      <h1>Ya lo tenemos anotado.</h1>
      {detalle ? (
        <>
          <div className="monto">{formatCLP(detalle.totalClp)}</div>
          <div className="leyenda-iva">IVA incluido</div>
        </>
      ) : null}
      <p style={{ marginTop: 16 }}>
        Te escribimos por WhatsApp para coordinar el pago (contado) y la entrega.
        Tu cotización formal queda a tu nombre desde ya.
      </p>
      {/* Honestidad del abastecimiento: alguna linea no salio de stock
          inmediato, asi que el plazo no es el de siempre. */}
      {detalle?.avisoAbastecimiento ? (
        <div className="aviso" style={{ textAlign: 'left' }}>
          Algún producto de tu pedido viene por encargo. Te confirmamos el plazo cuando
          te escribamos.
        </div>
      ) : null}
      <div className="acciones">
        <a className="boton-secundario" href={`${RELAY}/api/cotizacion/${quoteId}`} target="_blank" rel="noreferrer">
          Descargar cotización en PDF
        </a>
        <a className="boton-secundario" href="/">Seguir buscando</a>
      </div>
      <p className="leyenda-iva" style={{ marginTop: 18 }}>Guarda el PDF: es el comprobante de tu pedido.</p>
    </div>
  );
}
