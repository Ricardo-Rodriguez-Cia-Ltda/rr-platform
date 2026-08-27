const API_BASE_DEFAULT = "https://api.pyxis-latam.cl/rr/captador-precios";
const TIMEOUT_MS = 25000;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "Content-Type": "application/json" }
  });
}

function precioVenta(costo, margen) {
  const value = Number(costo);
  if (!Number.isFinite(value) || value < 0) return null;
  return Math.round(value * (1 + margen) * 100) / 100;
}

async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const input = body.input ?? {};
  const apiKey = String(env.API_PRECIOS_KEY ?? "").trim();
  const margen = Number(env.MARGEN ?? "0.30");

  if (!apiKey) {
    return json({ estado: "error", mensaje: "La integración del catálogo no está configurada." }, 500);
  }
  if (!Number.isFinite(margen) || margen < 0) {
    return json({ estado: "error", mensaje: "La integración del catálogo no está disponible." }, 500);
  }

  const sku = String(input.sku ?? "").trim();
  if (!sku) {
    return json({ estado: "error", mensaje: "Falta el SKU del producto." }, 400);
  }

  const base = String(env.API_PRECIOS_URL ?? API_BASE_DEFAULT).replace(/\/+$/, "");
  let respuesta;
  try {
    respuesta = await fetch(`${base}/product/${encodeURIComponent(sku)}`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (error) {
    console.error("[detalle_producto] catálogo no disponible");
    return json({
      estado: "no_disponible",
      mensaje: "El catálogo no responde en este momento. Reintenta en unos minutos."
    });
  }

  const datos = await respuesta.json().catch(() => ({}));

  if (respuesta.status === 404) {
    return json({ estado: "no_encontrado", mensaje: "Ese producto ya no está disponible. Ofrece buscar una alternativa." });
  }
  if (respuesta.status === 503) {
    return json({ estado: "no_disponible", mensaje: "El catálogo se está actualizando. Reintenta en unos minutos." });
  }
  if (!respuesta.ok) {
    console.error(`[detalle_producto] respuesta HTTP ${respuesta.status}`);
    return json({ estado: "error", mensaje: "No se pudo consultar el producto." });
  }

  const precio = precioVenta(datos.precio, margen);
  if (precio === null) {
    return json({ estado: "error", mensaje: "La ficha del producto no tiene un precio válido." });
  }

  return json({
    estado: "ok",
    producto: {
      sku: String(datos.sku ?? sku),
      nombre: String(datos.nombre ?? ""),
      marca: datos.marca == null ? null : String(datos.marca),
      categoria: datos.categoria == null ? null : String(datos.categoria),
      subcategorias: Array.isArray(datos.subcategorias) ? datos.subcategorias.map(String) : [],
      precio,
      moneda: "USD",
      disponible: Number(datos.stock ?? 0) > 0
    }
  });
}