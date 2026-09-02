import { chequearSalud } from '../../src/lib/salud.js';

export const dynamic = 'force-dynamic';

const Punto = ({ ok }: { ok: boolean }) => <span className={`punto ${ok ? 'ok' : 'fallo'}`} />;

export default async function Salud() {
  const salud = await chequearSalud(Date.now());
  return (
    <>
      <h1>Salud</h1>
      <div className="tarjeta semaforo"><Punto ok={salud.supabase} /> Base de datos (Supabase)</div>
      <div className="tarjeta semaforo"><Punto ok={salud.oficina} /> API de precios de la oficina (túnel)</div>
      <div className="tarjeta semaforo"><Punto ok={salud.rele} /> Relé de correo y PDF</div>
      <div className="contadores">
        <div className="contador"><b>{salud.cotizaciones24h ?? '—'}</b><span>cotizaciones últimas 24 h</span></div>
        <div className="contador"><b>{salud.ocFallidas ?? '—'}</b><span>OC con correo fallido</span></div>
      </div>
      <p className="meta"><a href="/salud">Volver a chequear</a></p>
    </>
  );
}
