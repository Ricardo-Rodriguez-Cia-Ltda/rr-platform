'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { mensajeError } from '../../src/lib/errores-api.js';

type Linea = { clave: string; nombre: string; cantidad: number; recibida: number };
const SIGUIENTE: Record<string, { hacia: string; label: string }> = {
  retiro: { hacia: 'por_retirar', label: 'Listo para retiro' },
  despacho_mayorista: { hacia: 'en_camino', label: 'Despachado por el mayorista' },
  directo_cliente: { hacia: 'directo_al_cliente', label: 'Despachado directo al cliente' },
};
const RECIBE = ['comprada', 'por_retirar', 'en_camino', 'recibida_parcial'];
const AVISO_ESTADO_NO_ACTUALIZADO = 'La recepción quedó registrada, pero el estado de la compra no se actualizó. Recarga en un momento.';

async function enviar(ruta: string, body: unknown): Promise<{ error: string | null; aviso: string | null }> {
  const res = await fetch(ruta, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
  const data = await res?.json().catch(() => ({})) ?? {};
  if (res?.ok) {
    return { error: null, aviso: data.aviso === 'estado_no_actualizado' ? AVISO_ESTADO_NO_ACTUALIZADO : null };
  }
  return { error: mensajeError(data), aviso: null };
}

export function AccionesCompra({ poId, estado, modalidad, lineas }: { poId: string; estado: string; modalidad: string | null; lineas: Linea[] }) {
  const router = useRouter();
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');
  const [aviso, setAviso] = useState('');

  async function correr(ruta: string, body: unknown) {
    setOcupado(true); setError(''); setAviso('');
    const r = await enviar(ruta, body);
    setOcupado(false);
    if (r.error) setError(r.error);
    else if (r.aviso) setAviso(r.aviso);
    router.refresh();
  }

  function registrar(form: FormData) {
    const datos: Record<string, string> = { po_id: poId };
    for (const [k, v] of form.entries()) if (String(v).trim()) datos[k] = String(v);
    void correr('/api/compras/registrar', datos);
  }

  return (
    <div className="acciones">
      {estado === 'por_comprar' ? (
        <form className="formulario" action={registrar}>
          <label>Modalidad
            <select name="modalidad" required defaultValue="">
              <option value="" disabled>Elegir…</option>
              <option value="retiro">Hay que retirarlo</option>
              <option value="despacho_mayorista">El mayorista nos lo despacha</option>
              <option value="directo_cliente">El mayorista despacha directo al cliente</option>
            </select>
          </label>
          <label>N° pedido del mayorista<input name="numero_pedido_mayorista" required /></label>
          <label>Llegada estimada<input name="llegada_estimada" type="date" /></label>
          <label>Guía del mayorista<input name="guia_mayorista" /></label>
          <label className="ancho">Nota<input name="nota_compra" /></label>
          <button disabled={ocupado}>Registrar compra</button>
        </form>
      ) : null}

      <div className="botonera">
        {estado === 'comprada' && modalidad && SIGUIENTE[modalidad] ? (
          <button disabled={ocupado} onClick={() => correr('/api/compras/transicion', { po_id: poId, hacia: SIGUIENTE[modalidad].hacia })}>
            {SIGUIENTE[modalidad].label}
          </button>
        ) : null}
        {estado === 'directo_al_cliente' ? (
          <button disabled={ocupado} onClick={() => correr('/api/compras/transicion', { po_id: poId, hacia: 'entregada_al_cliente' })}>Entregado al cliente</button>
        ) : null}
        {['por_comprar', 'comprada', 'por_retirar', 'en_camino', 'directo_al_cliente'].includes(estado) ? (
          <button disabled={ocupado} className="peligro" onClick={() => { if (confirm('¿Anular esta compra?')) void correr('/api/compras/transicion', { po_id: poId, hacia: 'anulada' }); }}>Anular</button>
        ) : null}
      </div>

      {RECIBE.includes(estado) && modalidad !== 'directo_cliente' ? (
        <div className="recepcion">
          {lineas.filter((l) => l.recibida < l.cantidad).map((l) => (
            <form key={l.clave} className="fila-recepcion" action={(form) => correr('/api/compras/recepcion', { po_id: poId, mpn: l.clave, cantidad: Number(form.get('cantidad')) })}>
              <span>{l.nombre} <small>({l.recibida}/{l.cantidad})</small></span>
              <input name="cantidad" type="number" min={1} max={l.cantidad - l.recibida} defaultValue={l.cantidad - l.recibida} aria-label={`Cantidad recibida de ${l.nombre}`} />
              <button disabled={ocupado}>Recibir</button>
            </form>
          ))}
        </div>
      ) : null}

      {error ? <span className="aviso-error">{error}</span> : null}
      {aviso ? <span className="aviso-ok">{aviso}</span> : null}
    </div>
  );
}
