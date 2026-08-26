const API_BASE_DEFAULT = "https://api.pyxis-latam.cl/rr/captador-precios";
const TIMEOUT_MS = 25000;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function precioVenta(costo, margen) {
  const valor = Number(costo);
  if (!Number.isFinite(valor) || valor < 0) return null;
  return Math.round(valor * (1 + margen) * 100) / 100;
}

async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const input = body.input ?? {};
  const apiKey = String(env.API_PRECIOS_KEY ?? "").trim();
  const margen = Number(env.MARGEN ?? "0.13");

  if (!apiKey) return json({ estado: "error", mensaje: "La integración del catálogo no está configurada." }, 500);
  if (!Number.isFinite(margen) || margen < 0) return json({ estado: "error", mensaje: "La integración del catálogo no está disponible." }, 500);

  const q = String(input.q ?? "").trim();
  if (!q) return json({ estado: "error", mensaje: "Falta el término de búsqueda." }, 400);

  const limiteNumero = Number(input.limite ?? 5);
  const limite = Number.isInteger(limiteNumero) ? Math.min(Math.max(limiteNumero, 1), 8) : 5;
  const base = String(env.API_PRECIOS_URL ?? API_BASE_DEFAULT).replace(/\/+$/, "");
  const params = new URLSearchParams({ q, limite: String(limite) });

  if (input.marca) params.set("marca", String(input.marca).trim());
  if (input.categoria) params.set("categoria", String(input.categoria).trim());
  params.set("solo_con_stock", input.incluir_sin_stock === true ? "false" : "true");

  if (input.precio_max !== undefined && input.precio_max !== null && input.precio_max !== "") {
    const topeVenta = Number(input.precio_max);
    if (Number.isFinite(topeVenta) && topeVenta > 0) params.set("precio_max", (topeVenta / (1 + margen)).toFixed(4));
  }

  let respuesta;
  try {
    respuesta = await fetch(`${base}/search?${params.toString()}`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (_) {
    return json({ estado: "no_disponible", mensaje: "El catálogo no responde en este momento. Reintenta en unos minutos." });
  }

  const datos = await respuesta.json().catch(() => ({}));

  if (respuesta.status === 409) {
    return json({
      estado: "demasiado_amplio",
      total: Number.isFinite(Number(datos.total)) ? Number(datos.total) : undefined,
      mensaje: "Hay demasiados productos. Pregunta al cliente por marca o tipo de producto antes de volver a buscar.",
      opciones: {
        marcas: Array.isArray(datos.facetas?.marca) ? datos.facetas.marca.slice(0, 6).map((m) => String(m.valor)).filter(Boolean) : [],
        categorias: Array.isArray(datos.facetas?.categoria) ? datos.facetas.categoria.slice(0, 6).map((c) => String(c.valor)).filter(Boolean) : []
      }
    });
  }

  if (respuesta.status === 503) return json({ estado: "no_disponible", mensaje: "El catálogo se está actualizando. Reintenta en unos minutos." });
  if (!respuesta.ok) return json({ estado: "error", mensaje: "No se pudo consultar el catálogo en este momento." });

  // Sin mpn no se puede comparar contra los otros mayoristas al cotizar, y una
  // linea que no se puede comparar no deberia llegar al carro.
  const productos = Array.isArray(datos.productos)
    ? datos.productos.map((p) => ({
        sku: String(p.sku ?? ""),
        mpn: p.mpn == null ? null : String(p.mpn),
        marca: p.marca == null ? null : String(p.marca),
        nombre: String(p.nombre ?? ""),
        categoria: p.categoria == null ? null : String(p.categoria),
        precio: precioVenta(p.precio, margen),
        moneda: "USD",
        disponible: Number(p.stock ?? 0) > 0
      })).filter((p) => p.sku && p.nombre && p.mpn && p.precio !== null)
    : [];

  const facetaPrecio = datos.facetas?.precio;
  const min = precioVenta(facetaPrecio?.min, margen);
  const max = precioVenta(facetaPrecio?.max, margen);
  const rango = min !== null && max !== null ? { min, max, moneda: "USD" } : undefined;

  return json({
    estado: "ok",
    total: Number.isFinite(Number(datos.total)) ? Number(datos.total) : productos.length,
    mostrados: productos.length,
    productos,
    ...(rango ? { rango_precio: rango } : {})
  });
}
