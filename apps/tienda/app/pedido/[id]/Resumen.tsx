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
// Un fallo transitorio (red caida, 5xx) no debe tirar toda la pantalla si ya
// habia una consulta buena antes: recien al tercer fallo seguido se rinde.
const MAX_FALLOS_SEGUIDOS = 3;

type Consulta =
  | { fase: 'cargando' }
  | { fase: 'ok'; estado: EstadoPago | null }   // null = 404 del rele
  | { fase: 'error' };                           // red o 5xx sin consulta buena previa que mostrar

export function Resumen({ quoteId }: { quoteId: string }) {
  const [detalle, setDetalle] = useState<{ totalClp: number; avisoAbastecimiento?: boolean } | null>(null);
  const [consulta, setConsulta] = useState<Consulta>({ fase: 'cargando' });
  const [agotado, setAgotado] = useState(false);
  const consultas = useRef(0);
  const fallosSeguidos = useRef(0);
  // Ultima consulta que SI respondio (o el 404 del rele), para no perderla
  // ante un fallo transitorio y para saber si conviene seguir reintentando.
  const ultimaBuena = useRef<{ hubo: boolean; estado: EstadoPago | null }>({ hubo: false, estado: null });
  const consultarRef = useRef<() => Promise<void>>(async () => {});
  // Mercado Pago agrega status/collection_status a la URL al volver del pago.
  // Se lee UNA sola vez al montar (el query param lo controla el cliente, asi
  // que solo puede DEGRADAR lo que dice la fila, nunca subirlo por encima).
  const retornoAprobado = useRef(false);

  useEffect(() => {
    try {
      const params = new URLSearchParams(window.location.search);
      retornoAprobado.current =
        params.get('status') === 'approved' || params.get('collection_status') === 'approved';
    } catch { /* sin parametros: vista normal */ }
  }, []);

  useEffect(() => {
    try {
      const crudo = sessionStorage.getItem(`drc-pedido-${quoteId}`);
      if (crudo) setDetalle(JSON.parse(crudo));
    } catch { /* sin detalle igual mostramos el estado */ }
  }, [quoteId]);

  const programarSiguiente = useCallback((estado: EstadoPago | null) => {
    if (!describirPago(estado, { retornoAprobado: retornoAprobado.current }).seguirConsultando) return;
    if (consultas.current >= MAX_CONSULTAS) { setAgotado(true); return; }
    setTimeout(() => { void consultarRef.current(); }, INTERVALO_MS);
  }, []);

  const consultar = useCallback(async () => {
    consultas.current += 1;
    try {
      const r = await fetch(`${RELAY}/api/pago/estado/${quoteId}`, { cache: 'no-store' });
      if (r.status === 404) {
        fallosSeguidos.current = 0;
        ultimaBuena.current = { hubo: true, estado: null };
        setConsulta({ fase: 'ok', estado: null });
        programarSiguiente(null);
        return;
      }
      if (!r.ok) throw new Error(`http_${r.status}`);
      const data = (await r.json()) as EstadoPago;
      fallosSeguidos.current = 0;
      ultimaBuena.current = { hubo: true, estado: data };
      setConsulta({ fase: 'ok', estado: data });
      programarSiguiente(data);
    } catch {
      fallosSeguidos.current += 1;
      // Se conserva la ultima consulta buena y se reintenta con el mismo
      // timer (cuenta contra el mismo presupuesto de MAX_CONSULTAS) mientras
      // los fallos seguidos no lleguen a MAX_FALLOS_SEGUIDOS. Si nunca hubo
      // una consulta buena, o ya van tres fallos seguidos, se rinde.
      if (ultimaBuena.current.hubo && fallosSeguidos.current < MAX_FALLOS_SEGUIDOS) {
        programarSiguiente(ultimaBuena.current.estado);
        return;
      }
      setConsulta({ fase: 'error' });
    }
  }, [quoteId, programarSiguiente]);

  consultarRef.current = consultar;

  const actualizar = useCallback(() => {
    consultas.current = 0;
    fallosSeguidos.current = 0;
    setAgotado(false);
    void consultar();
  }, [consultar]);

  useEffect(() => {
    if (!UUID_RE.test(quoteId)) return;
    void consultar();
  }, [quoteId, consultar]);

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
          <button className="boton-compra" type="button" onClick={actualizar}>
            Actualizar
          </button>
          <a className="boton-secundario" href="/">Volver a la tienda</a>
        </div>
      </div>
    );
  }

  const d = describirPago(consulta.estado, { retornoAprobado: retornoAprobado.current });
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
          <button className="boton-compra" type="button" onClick={actualizar}>
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
