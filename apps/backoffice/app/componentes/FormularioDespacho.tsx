'use client';
import { useRouter } from 'next/navigation';
import { useState, type FormEvent } from 'react';
import { mensajeError } from '../../src/lib/errores-api.js';

type Pendiente = { poId: string; clave: string; nombre: string; pendiente: number; recibida: number };

export function FormularioDespacho({ quoteId, version, pendientes, facturacion, contacto }: {
  quoteId: string; version: string; pendientes: Pendiente[];
  facturacion: { direccion: string | null; comuna: string | null; ciudad: string | null };
  contacto: { nombre: string | null; telefono: string | null };
}) {
  const router = useRouter();
  const [modalidad, setModalidad] = useState('courier');
  const [ocupado, setOcupado] = useState(false);
  const [error, setError] = useState('');

  async function crear(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const form = new FormData(e.currentTarget);
    const lineas = pendientes
      .map((p) => ({ po_id: p.poId, mpn: p.clave, cantidad: Number(form.get(`cant-${p.poId}-${p.clave}`) ?? 0) }))
      .filter((l) => l.cantidad > 0);
    const campos: Record<string, unknown> = { quote_id: quoteId, quote_version: version, modalidad, lineas };
    for (const k of ['courier', 'direccion', 'comuna', 'ciudad', 'contacto_nombre', 'contacto_telefono', 'fecha_programada', 'responsable', 'costo_clp', 'cobrado_clp', 'nota']) {
      const v = String(form.get(k) ?? '').trim();
      if (v) campos[k] = k.endsWith('_clp') ? Number(v) : v;
    }
    setOcupado(true); setError('');
    const res = await fetch('/api/despachos', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(campos) }).catch(() => null);
    setOcupado(false);
    if (!res?.ok) {
      const data = await res?.json().catch(() => ({})) ?? {};
      setError(mensajeError(data));
    }
    router.refresh();
  }

  return (
    <details className="crear-despacho">
      <summary>Crear despacho</summary>
      {/* onSubmit en vez de action={fn}: un form action de React 19 resetea
          los campos no controlados apenas termina, aunque la peticion haya
          fallado, y el usuario pierde lo que escribio. */}
      <form className="formulario" onSubmit={crear}>
        <table className="lineas">
          <thead><tr><th>Producto</th><th>Recibido</th><th>Por asignar</th><th>En este despacho</th></tr></thead>
          <tbody>
            {pendientes.map((p) => (
              <tr key={`${p.poId}-${p.clave}`}>
                <td>{p.nombre}</td>
                <td className="num">{p.recibida}</td>
                <td className="num">{p.pendiente}</td>
                <td className="num"><input name={`cant-${p.poId}-${p.clave}`} type="number" min={0} max={p.pendiente} defaultValue={p.pendiente} aria-label={`Cantidad de ${p.nombre}`} /></td>
              </tr>
            ))}
          </tbody>
        </table>
        <label>Modalidad
          <select value={modalidad} onChange={(e) => setModalidad(e.target.value)}>
            <option value="courier">Courier</option>
            <option value="propio">Despacho propio</option>
            <option value="retiro_oficina">Retiro en oficina</option>
          </select>
        </label>
        {modalidad === 'courier' ? (
          <label>Courier
            <select name="courier" defaultValue="starken">
              <option value="starken">Starken</option>
              <option value="bluexpress">Blue Express</option>
              <option value="chilexpress">Chilexpress</option>
              <option value="otro">Otro</option>
            </select>
          </label>
        ) : null}
        {modalidad !== 'retiro_oficina' ? (
          <>
            <label className="ancho">Dirección<input name="direccion" defaultValue={facturacion.direccion ?? ''} /></label>
            <label>Comuna<input name="comuna" defaultValue={facturacion.comuna ?? ''} /></label>
            <label>Ciudad<input name="ciudad" defaultValue={facturacion.ciudad ?? ''} /></label>
          </>
        ) : null}
        <label>Contacto<input name="contacto_nombre" defaultValue={contacto.nombre ?? ''} /></label>
        <label>Teléfono<input name="contacto_telefono" defaultValue={contacto.telefono ?? ''} /></label>
        <label>Fecha programada<input name="fecha_programada" type="date" /></label>
        <label>Responsable<input name="responsable" /></label>
        <label>Costo del envío (CLP)<input name="costo_clp" type="number" min={0} /></label>
        <label>Cobrado al cliente (CLP)<input name="cobrado_clp" type="number" min={0} /></label>
        <label className="ancho">Nota<input name="nota" /></label>
        <button disabled={ocupado}>Crear despacho</button>
        {error ? <span className="aviso-error">{error}</span> : null}
      </form>
    </details>
  );
}
