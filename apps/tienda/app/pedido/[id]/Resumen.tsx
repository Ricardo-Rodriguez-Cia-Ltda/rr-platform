'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { describirPago, type EstadoPago } from '../../../src/lib/pago.js';
import { formatCLP } from '../../../src/lib/precios.js';

// La URL publica del rele ya viajaba al navegador para el PDF; la api key no
// viaja nunca (el endpoint de estado es publico por URL de capacidad).
const RELAY = process.env.NEXT_PUBLIC_MAILER_URL ?? 'https://rr-mailing.vercel.app';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// Mientras el desenlace puede cambiar solo, se pregunta cada 3 s durante 2
// minutos (el webhook tarda segundos; 2 minutos cubre un Mercado Pago lento).
// Despues queda el boton "Actualizar": una pestaña olvidada no debe pegarle
// al rele para siempre.
const INTERVALO_MS = 3000;
const MAX_CONSULTAS = 40;

type Consulta =
  | { fase: 'cargando' }
  | { fase: 'ok'; estado: EstadoPago | null }   // null = 404 del rele
  | { fase: 'error' };                           // red, 5xx: no se sabe

export function Resumen({ quoteId }: { quoteId: string }) {
  const [detalle, setDetalle] = useState<{ totalClp: number; avisoAbastecimiento?: boolean } | null>(null);
  const [consulta, setConsulta] = useState<Consulta>({ fase: 'cargando' });
  const [agotado, setAgotado] = useState(false);
  const consultas = useRef(0);

  useEffect(() => {
    try {
      const crudo = sessionStorage.getItem(`drc-pedido-${quoteId}`);
      if (crudo) setDetalle(JSON.parse(crudo));
    } catch { /* sin detalle igual mostramos el estado */ }
  }, [quoteId]);

  const consultar = useCallback(async () => {
    consultas.current += 1;
    try {
      const r = await fetch(`${RELAY}/api/pago/estado/${quoteId}`, { cache: 'no-store' });
      if (r.status === 404) { setConsulta({ fase: 'ok', estado: null }); return; }
      if (!r.ok) { setConsulta({ fase: 'error' }); return; }
      const data = (await r.json()) as EstadoPago;
      setConsulta({ fase: 'ok', estado: data });
    } catch {
      setConsulta({ fase: 'error' });
    }
  }, [quoteId]);

  useEffect(() => {
    if (!UUID_RE.test(quoteId)) return;
    void consultar();
  }, [quoteId, consultar]);

  // Repregunta mientras `describirPago` diga que el desenlace puede cambiar.
  useEffect(() => {
    if (consulta.fase !== 'ok' || consulta.estado === null) return;
    if (!describirPago(consulta.estado).seguirConsultando) return;
    if (consultas.current >= MAX_CONSULTAS) { setAgotado(true); return; }
    const t = setTimeout(() => { void consultar(); }, INTERVALO_MS);
    return () => clearTimeout(t);
  }, [consulta, consultar]);

  if (!UUID_RE.test(quoteId)) {
    return <div className="vacio">No encontramos ese pedido. <a href="/">Volver a la tienda</a></div>;
  }
  if (consulta.fase === 'cargando') {
    return <div className="recibo"><span className="sello">Pedido</span><h1>Consultando el estado del pago…</h1></div>;
  }
  if (consulta.fase === 'error') {
    return (
      <div className="recibo">
        <span className="sello">Pedido</span>
        <h1>No pudimos consultar el estado del pago.</h1>
        <p style={{ marginTop: 16 }}>Puede ser momentáneo. Si ya pagaste, tu pago está registrado en Mercado Pago igual.</p>
        <div className="acciones">
          <button className="boton-compra" type="button" onClick={() => { consultas.current = 0; setAgotado(false); void consultar(); }}>
            Actualizar
          </button>
          <a className="boton-secundario" href="/">Volver a la tienda</a>
        </div>
      </div>
    );
  }

  const d = describirPago(consulta.estado);
  const monto = consulta.estado?.monto_clp ?? detalle?.totalClp;
  return (
    <div className="recibo">
      <span className="sello">{d.sello}</span>
      <h1>{d.titulo}</h1>
      {monto ? (
        <>
          <div className="monto">{formatCLP(monto)}</div>
          <div className="leyenda-iva">IVA incluido</div>
        </>
      ) : null}
      <p style={{ marginTop: 16 }}>{d.texto}</p>
      {/* Honestidad del abastecimiento: alguna linea no salio de stock
          inmediato, asi que el plazo no es el de siempre. */}
      {detalle?.avisoAbastecimiento && consulta.estado !== null ? (
        <div className="aviso" style={{ textAlign: 'left' }}>
          Algún producto de tu pedido viene por encargo. Te confirmamos el plazo cuando
          te escribamos.
        </div>
      ) : null}
      <div className="acciones">
        {d.accion === 'pagar' && consulta.estado?.init_point ? (
          <a className="boton-compra" href={consulta.estado.init_point}>Pagar con Mercado Pago</a>
        ) : null}
        {agotado && d.seguirConsultando ? (
          <button className="boton-compra" type="button" onClick={() => { consultas.current = 0; setAgotado(false); void consultar(); }}>
            Actualizar
          </button>
        ) : null}
        {consulta.estado !== null ? (
          <a className="boton-secundario" href={`${RELAY}/api/cotizacion/${quoteId}`} target="_blank" rel="noreferrer">
            Descargar cotización en PDF
          </a>
        ) : null}
        <a className="boton-secundario" href="/">{d.accion === 'volver' ? 'Volver a la tienda' : 'Seguir buscando'}</a>
      </div>
      {d.comprobante ? (
        <p className="leyenda-iva" style={{ marginTop: 18 }}>Guarda el PDF: es el comprobante de tu pedido.</p>
      ) : null}
    </div>
  );
}
