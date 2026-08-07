// Kapso Function — herramienta `buscar_productos` del agente.
//
// Este es el NODO DETERMINISTA: consulta la API de precios (que devuelve COSTO),
// aplica el margen y entrega al LLM unicamente el precio de venta. El costo
// nunca sale de esta funcion, asi que no puede filtrarse por manipulacion de la
// conversacion.
//
// Secretos requeridos (Kapso > Functions > Secrets):
//   API_PRECIOS_KEY  clave del header x-api-key de la API de precios
//   MARGEN           margen como decimal, ej. "0.30" para 30%
// Opcional:
//   API_PRECIOS_URL  base de la API (default: la de produccion)

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

  const q = String(input.q ?? '').trim();
  if (!q) {
    return json({ estado: 'error', mensaje: 'Falta el termino de busqueda.' });
  }

  const params = new URLSearchParams({ q });
  if (input.marca) params.set('marca', String(input.marca));
  if (input.categoria) params.set('categoria', String(input.categoria));
  params.set('limite', String(input.limite ?? 5));

  // Por defecto solo ofrecemos lo que hay en stock: no sirve cotizarle al
  // cliente algo que no podemos entregar.
  params.set('solo_con_stock', input.incluir_sin_stock === true ? 'false' : 'true');

  // El cliente da un tope en precio de VENTA; la API filtra por COSTO.
  if (input.precio_max !== undefined && input.precio_max !== null && input.precio_max !== '') {
    const topeVenta = Number(input.precio_max);
    if (Number.isFinite(topeVenta) && topeVenta > 0) {
      params.set('precio_max', (topeVenta / (1 + margen)).toFixed(4));
    }
  }

  let respuesta;
  try {
    respuesta = await fetch(`${base}/search?${params.toString()}`, {
      headers: { 'x-api-key': env.API_PRECIOS_KEY },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
  } catch (error) {
    console.error('[buscar_productos] no se pudo contactar la API', error);
    return json({
      estado: 'no_disponible',
      mensaje: 'El catalogo no responde en este momento. Reintenta en unos minutos.',
    });
  }

  const datos = await respuesta.json().catch(() => ({}));

  // Demasiado amplio: devolvemos las opciones para que el agente repregunte.
  if (respuesta.status === 409) {
    return json({
      estado: 'demasiado_amplio',
      total: datos.total,
      mensaje: 'Hay demasiados productos. Pregunta al cliente por marca o tipo de producto antes de volver a buscar.',
      opciones: {
        marcas: (datos.facetas?.marca ?? []).slice(0, 6).map((m) => m.valor),
        categorias: (datos.facetas?.categoria ?? []).slice(0, 6).map((c) => c.valor),
      },
    });
  }

  if (respuesta.status === 503) {
    return json({
      estado: 'no_disponible',
      mensaje: 'El catalogo se esta actualizando. Reintenta en unos minutos.',
    });
  }

  if (!respuesta.ok) {
    console.error('[buscar_productos] error de la API', respuesta.status, datos);
    return json({
      estado: 'error',
      mensaje: 'No se pudo consultar el catalogo en este momento.',
    });
  }

  const aVenta = (p) => ({
    sku: p.sku,
    nombre: p.nombre,
    marca: p.marca,
    categoria: p.categoria,
    precio: precioVenta(p.precio, margen),
    moneda: 'USD',
    disponible: (p.stock ?? 0) > 0,
  });

  const productos = (datos.productos ?? []).map(aVenta);

  // Nada paso los filtros, pero si habia productos: hay que decir por que y
  // ofrecer lo mas cercano. Si no, el agente cree que fue un error tecnico y
  // reintenta la misma busqueda con otras palabras.
  if (productos.length === 0 && datos.sin_resultados) {
    const motivo = datos.sin_resultados.motivo;
    return json({
      estado: 'sin_resultados_con_filtros',
      motivo,
      mensaje:
        motivo === 'sin_stock'
          ? 'No hay stock inmediato de nada que calce con esa busqueda. NO reintentes la misma busqueda: cuentale al cliente y ofrecele la alternativa.'
          : 'Ningun producto cabe en ese presupuesto. NO reintentes la misma busqueda: cuentale al cliente y ofrecele la alternativa.',
      alternativa: aVenta(datos.sin_resultados.alternativa),
    });
  }

  // La faceta de precio viene en COSTO: se convierte o no se entrega.
  const rango = datos.facetas?.precio
    ? {
        min: precioVenta(datos.facetas.precio.min, margen),
        max: precioVenta(datos.facetas.precio.max, margen),
      }
    : undefined;

  return json({
    estado: 'ok',
    total: datos.total,
    mostrados: productos.length,
    productos,
    ...(rango ? { rango_precio: rango } : {}),
  });
}
