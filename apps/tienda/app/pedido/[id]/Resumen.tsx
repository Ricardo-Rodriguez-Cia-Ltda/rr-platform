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

  if (!UUID_RE.test(quoteId)) return <p className="vacio">Pedido no encontrado.</p>;
  return (
    <div className="hero">
      <h1>¡Pedido recibido!</h1>
      <p>
        Gracias por comprar en Dr. Computación.
        {detalle ? <> Tu total es <b>{formatCLP(detalle.totalClp)}</b> (IVA incluido).</> : null}
        {' '}Te contactaremos por WhatsApp para coordinar el pago (contado) y la entrega.
      </p>
      {/* Honestidad del abastecimiento: alguna linea no salio de stock
          inmediato, asi que el plazo no es el de siempre. */}
      {detalle?.avisoAbastecimiento ? (
        <div className="aviso">Algún producto de tu pedido viene por encargo; te confirmamos el plazo al contactarte.</div>
      ) : null}
      <p><a className="boton-secundario" href={`${RELAY}/api/cotizacion/${quoteId}`} target="_blank" rel="noreferrer">Descargar cotización formal (PDF)</a></p>
      <p className="leyenda-iva">Guarda esta página o el PDF como comprobante de tu pedido.</p>
      <p><a href="/">Volver a la tienda</a></p>
    </div>
  );
}
