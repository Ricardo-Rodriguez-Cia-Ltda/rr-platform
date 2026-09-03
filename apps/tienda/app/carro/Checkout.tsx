'use client';
import { useEffect, useState } from 'react';
import { cambiarCantidad, guardarCarro, leerCarro, totalIndicativo, type ItemCarro } from '../../src/lib/carro.js';
import { formatCLP } from '../../src/lib/precios.js';

interface DatosGuardados {
  comprador: { nombre: string; telefono: string; email: string };
  facturacion: Record<string, string>;
}
const CLAVE_DATOS = 'drc-comprador';
const FACT_VACIA = { rut: '', razonSocial: '', giro: '', direccion: '', comuna: '', ciudad: '', emailFactura: '' };

function leerDatos(): DatosGuardados {
  try {
    const crudo = localStorage.getItem(CLAVE_DATOS);
    const parsed = crudo ? JSON.parse(crudo) : null;
    return {
      comprador: { nombre: '', telefono: '', email: '', ...(parsed?.comprador ?? {}) },
      facturacion: { ...FACT_VACIA, ...(parsed?.facturacion ?? {}) },
    };
  } catch {
    return { comprador: { nombre: '', telefono: '', email: '' }, facturacion: { ...FACT_VACIA } };
  }
}

export function Checkout() {
  const [items, setItems] = useState<ItemCarro[]>([]);
  const [datos, setDatos] = useState<DatosGuardados>({ comprador: { nombre: '', telefono: '', email: '' }, facturacion: { ...FACT_VACIA } });
  const [estado, setEstado] = useState<'listo' | 'enviando'>('listo');
  const [error, setError] = useState('');
  const [recotizado, setRecotizado] = useState<{ totalClp: number } | null>(null);

  useEffect(() => { setItems(leerCarro()); setDatos(leerDatos()); }, []);

  function actualizar(sku: string, cantidad: number) {
    const nuevos = cambiarCantidad(items, sku, cantidad);
    setItems(nuevos);
    guardarCarro(nuevos);
    setRecotizado(null);
  }

  async function confirmar(totalConfirmadoClp: number) {
    setEstado('enviando'); setError(''); setRecotizado(null);
    try { localStorage.setItem(CLAVE_DATOS, JSON.stringify(datos)); } catch { /* sin memoria, no bloquea */ }
    // Honeypot: los humanos no ven ni tocan este input (position absolute
    // fuera de pantalla + tabIndex -1); un bot que llena todos los campos lo
    // llena. Se lee del DOM (no es un input controlado) para mandar lo que
    // realmente contenga.
    const hp = (document.getElementById('sitio_web') as HTMLInputElement | null)?.value ?? '';
    const res = await fetch('/api/confirmar', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        items,
        comprador: datos.comprador,
        facturacion: datos.facturacion,
        sitio_web: hp,
        totalConfirmadoClp,
      }),
    }).catch(() => null);
    setEstado('listo');
    if (!res) { setError('Sin conexión. Intenta de nuevo.'); return; }
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.recotizado) { setRecotizado({ totalClp: data.totalClp }); return; }
    if (!res.ok) { setError(String(data.error ?? 'No pudimos procesar tu pedido.')); return; }
    guardarCarro([]);
    try { sessionStorage.setItem(`drc-pedido-${data.quoteId}`, JSON.stringify({ totalClp: data.totalClp, avisoOc: data.avisoOc === true })); } catch { /* opcional */ }
    window.location.href = `/pedido/${data.quoteId}`;
  }

  if (items.length === 0) {
    return <p className="vacio">Tu carro está vacío. <a href="/">Busca algo rico en tecnología</a>.</p>;
  }
  const total = totalIndicativo(items);
  const c = datos.comprador;
  const f = datos.facturacion;
  const setC = (campo: string, valor: string) => setDatos({ ...datos, comprador: { ...c, [campo]: valor } });
  const setF = (campo: string, valor: string) => setDatos({ ...datos, facturacion: { ...f, [campo]: valor } });

  return (
    <>
      <h1>Tu carro</h1>
      <table className="tabla-carro">
        <tbody>
          {items.map((i) => (
            <tr key={i.sku}>
              <td><b>{i.nombre}</b><div className="mpn">{i.marca ?? ''}{i.mpn ? ` · ${i.mpn}` : ''}</div></td>
              <td><input type="number" min={0} max={20} value={i.cantidad} onChange={(e) => actualizar(i.sku, Number(e.target.value))} aria-label={`Cantidad de ${i.nombre}`} /></td>
              <td className="num">{formatCLP(i.cantidad * i.precioTiendaClp)}</td>
            </tr>
          ))}
          <tr><td /><td className="num"><b>Total</b></td><td className="num"><b>{formatCLP(total)}</b><div className="leyenda-iva">IVA incluido · se confirma al pedir</div></td></tr>
        </tbody>
      </table>

      <h2>Tus datos</h2>
      <form className="formulario" onSubmit={(e) => { e.preventDefault(); confirmar(recotizado ? recotizado.totalClp : total); }}>
        <label>Nombre<input value={c.nombre} onChange={(e) => setC('nombre', e.target.value)} required minLength={2} /></label>
        <label>WhatsApp<input value={c.telefono} onChange={(e) => setC('telefono', e.target.value)} placeholder="+56 9 ..." required /></label>
        <label>Email<input type="email" value={c.email} onChange={(e) => setC('email', e.target.value)} required /></label>
        <details open={Object.values(f).some((v) => v !== '')}>
          <summary>Datos de facturación (opcional — los 7, o déjalo vacío)</summary>
          <label>RUT<input value={f.rut} onChange={(e) => setF('rut', e.target.value)} /></label>
          <label>Razón social<input value={f.razonSocial} onChange={(e) => setF('razonSocial', e.target.value)} /></label>
          <label>Giro<input value={f.giro} onChange={(e) => setF('giro', e.target.value)} /></label>
          <label>Dirección<input value={f.direccion} onChange={(e) => setF('direccion', e.target.value)} /></label>
          <label>Comuna<input value={f.comuna} onChange={(e) => setF('comuna', e.target.value)} /></label>
          <label>Ciudad<input value={f.ciudad} onChange={(e) => setF('ciudad', e.target.value)} /></label>
          <label>Email factura<input value={f.emailFactura} onChange={(e) => setF('emailFactura', e.target.value)} /></label>
        </details>
        <div className="honeypot" aria-hidden="true">
          <label>Sitio web<input id="sitio_web" tabIndex={-1} autoComplete="off" name="sitio_web" /></label>
        </div>
        {recotizado ? (
          <div className="aviso">
            Los precios se actualizaron: el total ahora es <b>{formatCLP(recotizado.totalClp)}</b> (antes {formatCLP(total)}).
            Aprieta de nuevo para confirmar con el precio vigente.
          </div>
        ) : null}
        {error ? <div className="aviso error">{error}</div> : null}
        <button className="boton-compra" type="submit" disabled={estado === 'enviando'}>
          {estado === 'enviando' ? 'Procesando…' : recotizado ? `Confirmar por ${formatCLP(recotizado.totalClp)}` : 'Confirmar pedido'}
        </button>
        <p className="leyenda-iva">Sin pago online todavía: te contactamos por WhatsApp para coordinar pago (contado) y entrega.</p>
      </form>
    </>
  );
}
