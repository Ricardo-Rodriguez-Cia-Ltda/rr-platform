'use client';
import { useRouter } from 'next/navigation';
import { useState } from 'react';

export function BotonesTransicion({ quoteId, version, estado }: { quoteId: string; version: string; estado: string }) {
  const router = useRouter();
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');

  async function marcar(hacia: string) {
    if (hacia === 'anulado' && !confirm('¿Anular este pedido?')) return;
    setOcupado(true); setError('');
    const res = await fetch('/api/pedidos/transicion', {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ quote_id: quoteId, quote_version: version, hacia }),
    }).catch(() => null);
    setOcupado(false);
    if (res?.ok) router.refresh();
    else {
      setError('No se pudo guardar el cambio. Intenta de nuevo.');
      router.refresh();
    }
  }

  return (
    <div className="botonera">
      {estado === 'nuevo' ? <button disabled={ocupado} onClick={() => marcar('pagado')}>Marcar pagado</button> : null}
      {estado === 'pagado' ? <button disabled={ocupado} onClick={() => marcar('entregado')}>Marcar entregado</button> : null}
      {estado === 'nuevo' || estado === 'pagado'
        ? <button disabled={ocupado} className="peligro" onClick={() => marcar('anulado')}>Anular</button> : null}
      {error ? <span className="aviso-error">{error}</span> : null}
    </div>
  );
}
