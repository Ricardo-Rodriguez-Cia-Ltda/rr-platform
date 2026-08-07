// Kapso Function — herramienta `detalle_producto` del agente.
//
// Igual que buscar-productos.js: recibe COSTO de la API y devuelve al LLM solo
// el precio de venta. Se usa cuando el cliente pregunta por las
// caracteristicas de un producto que ya salio en una busqueda.
//
// Secretos requeridos: API_PRECIOS_KEY, MARGEN. Opcional: API_PRECIOS_URL.

const API_BASE_DEFECTO = 'https://api.pyxis-latam.cl/rr/captador-precios';
const TIMEOUT_MS = 25000;

function precioVenta(costo, margen) {
  return Math.round(costo * (1 + margen) * 100) / 100;
}

function json(payload) {
  return new Response(JSON.stringify(payload), {
    headers: { 'Content-Type': 'application/json' },
  });
}

async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const input = body.input ?? {};

  const margen = Number(env.MARGEN ?? '0.30');
  if (!Number.isFinite(margen) || margen < 0) {
    return json({ estado: 'error', mensaje: 'Margen mal configurado en el servidor.' });
  }
  const base = env.API_PRECIOS_URL ?? API_BASE_DEFECTO;

  const sku = String(input.sku ?? '').trim();
  if (!sku) {
    return json({ estado: 'error', mensaje: 'Falta el sku del producto.' });
  }

  let respuesta;
  try {
    respuesta = await fetch(`${base}/product/${encodeURIComponent(sku)}`, {
      headers: { 'x-api-key': env.API_PRECIOS_KEY },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.error('[detalle_producto] no se pudo contactar la API', error);
    return json({
      estado: 'no_disponible',
      mensaje: 'El catalogo no responde en este momento. Reintenta en unos minutos.',
    });
  }

  const datos = await respuesta.json().catch(() => ({}));

  if (respuesta.status === 404) {
    return json({
      estado: 'no_encontrado',
      mensaje: 'Ese producto ya no esta disponible. Ofrece buscar una alternativa.',
    });
  }

  if (respuesta.status === 503) {
    return json({
      estado: 'no_disponible',
      mensaje: 'El catalogo se esta actualizando. Reintenta en unos minutos.',
    });
  }

  if (!respuesta.ok) {
    console.error('[detalle_producto] error de la API', respuesta.status, datos);
    return json({ estado: 'error', mensaje: 'No se pudo consultar el producto.' });
  }

  return json({
    estado: 'ok',
    producto: {
      sku: datos.sku,
      nombre: datos.nombre,
      marca: datos.marca,
      categoria: datos.categoria,
      subcategorias: datos.subcategorias,
      precio: precioVenta(datos.precio, margen),
      moneda: 'USD',
      disponible: (datos.stock ?? 0) > 0,
    },
  });
}
