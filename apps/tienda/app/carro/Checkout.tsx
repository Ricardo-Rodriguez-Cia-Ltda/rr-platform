'use client';
import { useEffect, useState } from 'react';
import { cambiarCantidad, claveProducto, guardarCarro, leerCarro, totalIndicativo, type ItemCarro } from '../../src/lib/carro.js';
import { leerFicha } from '../../src/lib/ficha.js';
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

export function Checkout({ iva }: { iva: number }) {
  const [items, setItems] = useState<ItemCarro[]>([]);
  const [datos, setDatos] = useState<DatosGuardados>({ comprador: { nombre: '', telefono: '', email: '' }, facturacion: { ...FACT_VACIA } });
  const [estado, setEstado] = useState<'listo' | 'enviando'>('listo');
  const [error, setError] = useState('');
  const [recotizado, setRecotizado] = useState<{ totalClp: number; totalAnteriorClp: number } | null>(null);

  useEffect(() => { setItems(leerCarro()); setDatos(leerDatos()); }, []);

  function actualizar(clave: string, cantidad: number) {
    const nuevos = cambiarCantidad(items, clave, cantidad);
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
    if (!res) { setEstado('listo'); setError('Sin conexión. Intenta de nuevo.'); return; }
    const data = await res.json().catch(() => ({}));
    if (res.status === 409 && data.recotizado) {
      setEstado('listo');
      setRecotizado({ totalClp: data.totalClp, totalAnteriorClp: data.totalAnteriorClp });
      return;
    }
    if (!res.ok) {
      setEstado('listo');
      setError(String(data.error ?? 'No pudimos procesar tu pedido.'));
      return;
    }
    if (typeof data.initPoint !== 'string' || !data.initPoint) {
      setEstado('listo');
      setError('No pudimos generar el link de pago. Intenta de nuevo.');
      return;
    }
    guardarCarro([]);
    try {
      sessionStorage.setItem(`drc-pedido-${data.quoteId}`, JSON.stringify({
        totalClp: data.totalClp,
        avisoAbastecimiento: data.avisoAbastecimiento === true,
      }));
    } catch { /* opcional */ }
    // Directo a Mercado Pago. Al terminar (o al cerrar), vuelve a
    // /pedido/{quoteId}, que le cuenta el estado real del pago.
    window.location.href = data.initPoint;
  }

  if (items.length === 0) {
    return (
      <div className="vacio">
        Tu carro está vacío. <a href="/">Busca lo que necesitas</a> y agrégalo desde su ficha.
      </div>
    );
  }
  const total = totalIndicativo(items, iva);
  const c = datos.comprador;
  const f = datos.facturacion;
  const setC = (campo: string, valor: string) => setDatos({ ...datos, comprador: { ...c, [campo]: valor } });
  const setF = (campo: string, valor: string) => setDatos({ ...datos, facturacion: { ...f, [campo]: valor } });
  const trabajando = estado === 'enviando';

  return (
    <>
      <span className="rotulo">Pedido en preparación</span>
      <h1 style={{ fontSize: 26, margin: '6px 0 20px' }}>Tu carro</h1>

      <div className="columnas">
        <div>
          <div className="panel">
            {items.map((i) => (
              <div className="linea-carro" key={claveProducto(i)}>
                <div className="cuerpo">
                  <div className="titulo">{leerFicha(i.nombre, i.marca).titulo || i.nombre}</div>
                  <div className="mpn">
                    {i.marca ?? ''}
                    {i.mpn ? ` · ${i.mpn}` : ''}
                  </div>
                </div>
                <div className="cantidad">
                  {/* Precio UNITARIO con IVA. El total no es la suma de estos:
                      se arma con los netos y una sola aplicacion de IVA, igual
                      que la cotizacion del bot. */}
                  <span className="unitario">{formatCLP(i.precioTiendaClp)} c/u</span>
                  <input
                    type="number"
                    min={0}
                    max={20}
                    value={i.cantidad}
                    disabled={trabajando}
                    onChange={(e) => actualizar(claveProducto(i), Number(e.target.value))}
                    aria-label={`Cantidad de ${i.nombre}`}
                  />
                </div>
              </div>
            ))}
            <div className="total">
              <div>
                <div className="rotulo">Total</div>
                <div className="leyenda-iva">IVA incluido · se confirma al pedir</div>
              </div>
              <div className="monto">{formatCLP(total)}</div>
            </div>
          </div>
          <p className="nota" style={{ marginTop: 10 }}>
            Para cambiar la cantidad a cero, escribe 0 y la línea sale del carro.
          </p>
        </div>

        <form
          className="panel formulario"
          onSubmit={(e) => {
            e.preventDefault();
            confirmar(recotizado ? recotizado.totalClp : total);
          }}
        >
          <span className="rotulo">Con quién coordinamos</span>
          <label>Nombre<input value={c.nombre} onChange={(e) => setC('nombre', e.target.value)} required minLength={2} /></label>
          <label>WhatsApp<input value={c.telefono} onChange={(e) => setC('telefono', e.target.value)} placeholder="+56 9 ..." required /></label>
          <label>Email<input type="email" value={c.email} onChange={(e) => setC('email', e.target.value)} required /></label>

          <details open={Object.values(f).some((v) => v !== '')}>
            <summary>Datos de facturación — opcional</summary>
            <p className="nota" style={{ marginBottom: 12 }}>
              Si los dejas ahora, tu factura sale sin que tengamos que pedírtelos después.
              Van los siete o ninguno.
            </p>
            <label>RUT<input value={f.rut} onChange={(e) => setF('rut', e.target.value)} /></label>
            <label>Razón social<input value={f.razonSocial} onChange={(e) => setF('razonSocial', e.target.value)} /></label>
            <label>Giro<input value={f.giro} onChange={(e) => setF('giro', e.target.value)} /></label>
            <label>Dirección<input value={f.direccion} onChange={(e) => setF('direccion', e.target.value)} /></label>
            <label>Comuna<input value={f.comuna} onChange={(e) => setF('comuna', e.target.value)} /></label>
            <label>Ciudad<input value={f.ciudad} onChange={(e) => setF('ciudad', e.target.value)} /></label>
            <label>Email para la factura<input value={f.emailFactura} onChange={(e) => setF('emailFactura', e.target.value)} /></label>
          </details>

          <div className="honeypot" aria-hidden="true">
            <label>Sitio web<input id="sitio_web" tabIndex={-1} autoComplete="off" name="sitio_web" /></label>
          </div>

          {recotizado ? (
            <div className="aviso">
              El precio cambió mientras armabas el pedido: ahora son <b>{formatCLP(recotizado.totalClp)}</b>{' '}
              (eran {formatCLP(recotizado.totalAnteriorClp)}). Confirma de nuevo para tomar el precio vigente.
            </div>
          ) : null}
          {error ? <div className="aviso error">{error}</div> : null}

          <button className="boton-compra grande" type="submit" disabled={trabajando}>
            {estado === 'enviando'
              ? 'Preparando el pago…'
              : recotizado
                ? `Confirmar por ${formatCLP(recotizado.totalClp)}`
                : 'Confirmar pedido'}
          </button>
          <p className="nota">
            Al confirmar te llevamos a Mercado Pago para pagar con tarjeta. Las órdenes a los
            proveedores se cursan solo cuando el pago se acredita, y la entrega la coordinamos
            por WhatsApp.
          </p>
        </form>
      </div>
    </>
  );
}
