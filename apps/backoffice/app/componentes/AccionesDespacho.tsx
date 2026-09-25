'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { mensajeError } from '../../src/lib/errores-api.js';

type Transicion = { hacia: string; label: string; peligro?: boolean };
function transiciones(estado: string, modalidad: string): Transicion[] {
  const retiro = modalidad === 'retiro_oficina';
  switch (estado) {
    case 'por_preparar': return [{ hacia: 'listo', label: retiro ? 'Listo para retiro' : 'Listo para despachar' }, { hacia: 'anulado', label: 'Anular', peligro: true }];
    case 'listo': return [retiro ? { hacia: 'entregado', label: 'Retirado por el cliente' } : { hacia: 'en_ruta', label: 'En ruta' }, { hacia: 'anulado', label: 'Anular', peligro: true }];
    case 'en_ruta': return [{ hacia: 'entregado', label: 'Entregado' }, { hacia: 'fallido', label: 'No se pudo entregar', peligro: true }];
    case 'fallido': return [{ hacia: 'listo', label: 'Reprogramar' }, { hacia: 'anulado', label: 'Anular', peligro: true }];
    default: return [];
  }
}

export function AccionesDespacho({ id, estado, modalidad, numeroSeguimiento, costo, cobrado, cobroPagado, mensaje }: {
  id: number; estado: string; modalidad: string; numeroSeguimiento: string | null;
  costo: number | null; cobrado: number | null; cobroPagado: boolean; mensaje: string | null;
}) {
  const router = useRouter();
  const [ocupado, setOcupado] = useState(false);
  const [aviso, setAviso] = useState('');
  // Cuando el portapapeles falla no es un error: el mensaje se muestra en un
  // textarea de solo lectura para que se pueda seleccionar y copiar a mano.
  const [textoManual, setTextoManual] = useState('');

  async function post(ruta: string, body: unknown) {
    setOcupado(true); setAviso(''); setTextoManual('');
    const res = await fetch(ruta, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }).catch(() => null);
    setOcupado(false);
    if (!res?.ok) {
      const data = await res?.json().catch(() => ({})) ?? {};
      setAviso(mensajeError(data));
    }
    router.refresh();
  }

  async function copiar() {
    if (!mensaje) return;
    setTextoManual('');
    try { await navigator.clipboard.writeText(mensaje); setAviso('Mensaje copiado'); }
    catch { setAviso(''); setTextoManual(mensaje); }
  }

  function guardar(form: FormData) {
    const cambio: Record<string, unknown> = { id };
    for (const k of ['numero_seguimiento', 'costo_clp', 'cobrado_clp', 'responsable', 'fecha_programada', 'nota']) {
      if (!form.has(k)) continue;
      const v = String(form.get(k) ?? '').trim();
      cambio[k] = k.endsWith('_clp') ? (v ? Number(v) : null) : v;
    }
    cambio.cobro_pagado = form.get('cobro_pagado') === 'on';
    void post('/api/despachos/editar', cambio);
  }

  const cerrado = estado === 'entregado' || estado === 'anulado';
  return (
    <div className="acciones">
      <div className="botonera">
        {transiciones(estado, modalidad).map((t) => (
          <button key={t.hacia} disabled={ocupado} className={t.peligro ? 'peligro' : ''}
            onClick={() => { if (t.hacia === 'anulado' && !confirm('¿Anular este despacho?')) return; void post('/api/despachos/transicion', { id, hacia: t.hacia }); }}>
            {t.label}
          </button>
        ))}
        {mensaje ? <button disabled={ocupado} className="secundario" onClick={copiar}>Copiar mensaje</button> : null}
      </div>
      <form className="formulario compacto" action={guardar}>
        {!cerrado && modalidad === 'courier' ? <label>N° seguimiento<input name="numero_seguimiento" defaultValue={numeroSeguimiento ?? ''} /></label> : null}
        <label>Costo (CLP)<input name="costo_clp" type="number" min={0} defaultValue={costo ?? ''} /></label>
        <label>Cobrado (CLP)<input name="cobrado_clp" type="number" min={0} defaultValue={cobrado ?? ''} /></label>
        <label className="check"><input name="cobro_pagado" type="checkbox" defaultChecked={cobroPagado} /> Envío pagado</label>
        <button disabled={ocupado} className="secundario">Guardar</button>
      </form>
      {aviso ? <span className={aviso === 'Mensaje copiado' ? 'aviso-ok' : 'aviso-error'}>{aviso}</span> : null}
      {textoManual ? (
        <div className="copiar-manual">
          <p className="meta">No se pudo copiar automáticamente. Selecciona el texto y cópialo a mano:</p>
          <textarea
            readOnly
            value={textoManual}
            onFocus={(e) => e.currentTarget.select()}
            aria-label="Mensaje para copiar a mano"
          />
        </div>
      ) : null}
    </div>
  );
}
