import type { Metadata } from 'next';

export const metadata: Metadata = {
  title: 'Garantías y devoluciones',
  description:
    'Cómo funcionan la garantía del fabricante, las devoluciones y la facturación en Dr. Computación (Ricardo Rodríguez y Cía. Ltda.).',
};

// Contenido real de la empresa (el mismo respaldo que va impreso al pie de las
// cotizaciones formales). No es relleno legal generico.
export default function Garantias() {
  return (
    <article style={{ maxWidth: '62ch' }}>
      <span className="rotulo">Antes de comprar</span>
      <h1 style={{ fontSize: 34, margin: '12px 0 26px' }}>Garantías, entrega y facturación</h1>

      <h2 style={{ fontSize: 21, marginTop: 30 }}>Garantía</h2>
      <p style={{ marginTop: 10, color: 'var(--gris)' }}>
        Todos los productos cuentan con la garantía del fabricante. El plazo y las condiciones
        dependen de cada marca, y te los confirmamos por escrito junto con la cotización antes
        de que pagues.
      </p>

      <h2 style={{ fontSize: 21, marginTop: 30 }}>Cómo se cierra la compra</h2>
      <p style={{ marginTop: 10, color: 'var(--gris)' }}>
        Todavía no cobramos en línea. Cuando confirmas un pedido acá, queda registrado a tu
        nombre con una cotización formal, y te escribimos por WhatsApp para coordinar el pago
        (contado) y la entrega. Nada se cobra automáticamente.
      </p>

      <h2 style={{ fontSize: 21, marginTop: 30 }}>Precios y stock</h2>
      <p style={{ marginTop: 10, color: 'var(--gris)' }}>
        Los precios se consultan en el momento a los mayoristas y cambian con el tipo de cambio
        y la disponibilidad. Por eso, si el precio se movió entre que armaste el carro y
        confirmaste, te mostramos el nuevo antes de tomar el pedido. Los productos marcados
        &laquo;por encargo&raquo; no tienen stock inmediato: te confirmamos el plazo al contactarte.
      </p>

      <h2 style={{ fontSize: 21, marginTop: 30 }}>Facturación</h2>
      <p style={{ marginTop: 10, color: 'var(--gris)' }}>
        Emitimos factura. Puedes dejar tus datos al confirmar el pedido o dárnoslos después por
        WhatsApp; los guardamos para que no tengas que repetirlos en la próxima compra.
      </p>

      <h2 style={{ fontSize: 21, marginTop: 30 }}>Quiénes somos</h2>
      <p style={{ marginTop: 10, color: 'var(--gris)' }}>
        Dr. Computación es la tienda en línea de Ricardo Rodríguez y Cía. Ltda., División
        Informática — más de treinta años vendiendo tecnología en Chile, en José M. Infante 2629,
        Ñuñoa, Santiago.
      </p>

      <p style={{ marginTop: 34 }}>
        <a className="boton-secundario" href="/">Volver a la tienda</a>
      </p>
    </article>
  );
}
