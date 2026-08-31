const API_BASE_DEFAULT = "https://api.pyxis-latam.cl/rr/captador-precios";
// La API tiene su propio presupuesto de 8s y responde parcial antes de agotarlo,
// asi que 15s es red de seguridad, no el caso normal. Mas alto que esto no sirve:
// la conversacion de WhatsApp se cae antes.
const TIMEOUT_MS = 15000;

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

// El costo del mayorista viene en dolares; el cliente compra en pesos. La
// conversion pasa aca y no en el prompt: el agente no debe hacer aritmetica de
// tipo de cambio, y el cliente no tiene por que convertir su propio
// presupuesto. Se usa el mismo TIPO_CAMBIO_CLP_USD que generar-cotizacion, para
// que el precio que se muestra en la busqueda y el de la cotizacion coincidan.
function precioVenta(costo, margen, tipoCambio) {
  const valor = Number(costo);
  if (!Number.isFinite(valor) || valor < 0) return null;
  return Math.round(valor * (1 + margen) * tipoCambio);
}

async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const input = body.input ?? {};
  const apiKey = String(env.API_PRECIOS_KEY ?? "").trim();
  const margen = Number(env.MARGEN ?? "0.13");
  const tipoCambio = Number(env.TIPO_CAMBIO_CLP_USD ?? "950");

  if (!apiKey) return json({ estado: "error", mensaje: "La integración del catálogo no está configurada." }, 500);
  if (!Number.isFinite(margen) || margen < 0) return json({ estado: "error", mensaje: "La integración del catálogo no está disponible." }, 500);
  // Mayor que cero: un tipo de cambio vacio coacciona a 0 y dejaria todos los
  // precios en $0, que es peor que no mostrar nada.
  if (!Number.isFinite(tipoCambio) || tipoCambio <= 0) return json({ estado: "error", mensaje: "La integración del catálogo no está disponible." }, 500);

  const q = String(input.q ?? "").trim();
  if (!q) return json({ estado: "error", mensaje: "Falta el término de búsqueda." }, 400);

  const limiteNumero = Number(input.limite ?? 5);
  const limite = Number.isInteger(limiteNumero) ? Math.min(Math.max(limiteNumero, 1), 8) : 5;
  const base = String(env.API_PRECIOS_URL ?? API_BASE_DEFAULT).replace(/\/+$/, "");
  const params = new URLSearchParams({ q, limite: String(limite) });

  if (input.marca) params.set("marca", String(input.marca).trim());
  if (input.categoria) params.set("categoria", String(input.categoria).trim());
  params.set("solo_con_stock", input.incluir_sin_stock === true ? "false" : "true");

  // `precio_max` llega en pesos, que es como habla el cliente. La API filtra por
  // costo del mayorista en dolares, asi que se le saca el margen y se pasa a
  // dolares antes de mandarlo.
  if (input.precio_max !== undefined && input.precio_max !== null && input.precio_max !== "") {
    const topeVentaCLP = Number(input.precio_max);
    if (Number.isFinite(topeVentaCLP) && topeVentaCLP > 0) {
      params.set("precio_max", (topeVentaCLP / tipoCambio / (1 + margen)).toFixed(4));
    }
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
        precio: precioVenta(p.precio, margen, tipoCambio),
        moneda: "CLP",
        disponible: Number(p.stock ?? 0) > 0
      })).filter((p) => p.sku && p.nombre && p.mpn && p.precio !== null)
    : [];

  const facetaPrecio = datos.facetas?.precio;
  const min = precioVenta(facetaPrecio?.min, margen, tipoCambio);
  const max = precioVenta(facetaPrecio?.max, margen, tipoCambio);
  const rango = min !== null && max !== null ? { min, max, moneda: "CLP" } : undefined;

  // La API distingue "no hubo coincidencias" de "las hubo pero ninguna con
  // stock", y lo dice en `sin_resultados.motivo`. Devolver un `ok` con la lista
  // vacia obliga al agente a inventar una explicacion: en la conversacion del
  // 2026-08-28 invento "tengo un problema temporal con la busqueda", que era
  // falso y dejaba al cliente esperando por algo que no iba a llegar.
  if (productos.length === 0) {
    const motivo = datos.sin_resultados?.motivo;
    const alternativa = datos.sin_resultados?.alternativa;
    // `busqueda_incompleta` no es lo mismo que `sin_stock`: la API se quedo sin
    // presupuesto de tiempo y no alcanzo a cotizar todos los candidatos. Decir
    // "no hay con stock" seria afirmar algo que nadie comprobo.
    const estado = motivo === "sin_stock"
      ? "sin_stock"
      : motivo === "busqueda_incompleta"
        ? "busqueda_incompleta"
        : "sin_coincidencias";
    const mensajes = {
      sin_stock: "Hay productos que calzan, pero ninguno con stock disponible. Dilo tal cual y ofrece buscar sin filtrar por stock, subir el presupuesto o cambiar de marca.",
      busqueda_incompleta: "El catálogo no se alcanzó a revisar completo. NO le pidas más requisitos al cliente por esto: reintenta una sola vez la misma búsqueda (con categoria puesta si no la tenía), y si sigue incompleta ofrece la alternativa o lo más cercano que tengas.",
      sin_coincidencias: "Ningún producto calzó con esos filtros. Dilo tal cual y ofrece cambiar marca, presupuesto o tipo de producto."
    };
    return json({
      estado,
      total: Number.isFinite(Number(datos.total)) ? Number(datos.total) : 0,
      mostrados: 0,
      productos: [],
      mensaje: mensajes[estado],
      ...(alternativa && alternativa.nombre
        ? { alternativa: { nombre: String(alternativa.nombre), marca: alternativa.marca == null ? null : String(alternativa.marca), precio: precioVenta(alternativa.precio, margen, tipoCambio), moneda: "CLP" } }
        : {}),
      ...(rango ? { rango_precio: rango } : {})
    });
  }

  return json({
    estado: "ok",
    total: Number.isFinite(Number(datos.total)) ? Number(datos.total) : productos.length,
    mostrados: productos.length,
    productos,
    ...(rango ? { rango_precio: rango } : {})
  });
}
