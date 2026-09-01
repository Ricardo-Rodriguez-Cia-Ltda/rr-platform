const API_BASE_DEFAULT = "https://api.pyxis-latam.cl/rr/captador-precios";
const TIMEOUT_MS = 25000;

// La arista fn_cotizar → agente_presentacion es incondicional: si esta
// function falla y no toca las variables, el agente presenta la cotizacion
// ANTERIOR como si fuera la nueva y el cliente termina comprando otra cosa.
// Toda salida de error borra la cotizacion vigente.
const SIN_COTIZACION = {
  quote_result: null,
  quote_id: null,
  quote_version: null,
  quote_total_clp: null,
  quote_valid_until: null
};

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status, headers: { "Content-Type": "application/json" } });
}

function error(payload, status) {
  return json({ ...payload, vars: { ...SIN_COTIZACION } }, status);
}

// --- persistencia (Supabase) ---------------------------------------------
// Memoria del negocio, no un eslabon del flujo: nunca lanza, 4s de timeout,
// y sin secretos configurados no hace nada. Ver el spec 2026-08-31.
async function supabase(env, method, path, body) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) return null;
  try {
    const base = String(env.SUPABASE_URL).replace(/\/+$/, "");
    const r = await fetch(`${base}/rest/v1${path}`, {
      method,
      headers: {
        apikey: env.SUPABASE_SERVICE_KEY,
        Authorization: `Bearer ${env.SUPABASE_SERVICE_KEY}`,
        "Content-Type": "application/json",
        Prefer: method === "POST" ? "resolution=merge-duplicates,return=minimal" : "count=none"
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(4000)
    });
    if (!r.ok) return null;
    const text = await r.text();
    return text ? JSON.parse(text) : {};
  } catch (_) {
    return null;
  }
}

// El telefono de WhatsApp es la llave del cliente: llega solo, en el contexto.
function telefonoDesdeContexto(executionContext) {
  const ctx = executionContext?.context || {};
  const crudo = ctx.phone_number || ctx.contact?.wa_id || "";
  const digitos = String(crudo).replace(/\D/g, "");
  return digitos.length > 0 ? digitos : null;
}

async function consultar(base, apiKey, params) {
  let respuesta;
  try {
    respuesta = await fetch(`${base}/mejor-precio?${params.toString()}`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(TIMEOUT_MS)
    });
  } catch (_) {
    return { status: 0, datos: {} };
  }
  const datos = await respuesta.json().catch(() => ({}));
  return { status: respuesta.status, datos };
}

async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};

  const crudo = vars.cart_items;
  let items = Array.isArray(crudo) ? crudo : null;
  if (!items && typeof crudo === "string") {
    try { const parsed = JSON.parse(crudo); items = Array.isArray(parsed) ? parsed : null; } catch (_) {}
  }

  const apiKey = String(env.API_PRECIOS_KEY || "").trim();
  const margen = Number(env.MARGEN ?? "0.13");
  const tipoCambio = Number(env.TIPO_CAMBIO_CLP_USD ?? "950");
  const iva = Number(env.IVA_RATE ?? "0.19");
  const horas = Number(env.COTIZACION_VALID_HOURS ?? "3");
  const base = String(env.API_PRECIOS_URL || API_BASE_DEFAULT).replace(/\/+$/, "");

  if (!apiKey) return error({ estado: "error", mensaje: "La cotización no está configurada." }, 500);
  // El margen tiene que ser mayor que cero: un secreto vacio coacciona a 0 y
  // venderia a costo sin que nada lo note.
  if (![margen, tipoCambio, iva, horas].every(Number.isFinite) || margen <= 0 || tipoCambio <= 0 || iva < 0 || horas <= 0) {
    return error({ estado: "error", mensaje: "La configuración de cotización no es válida." }, 500);
  }
  if (!items || items.length === 0 || items.length > 50) return error({ estado: "error", mensaje: "El carro no es válido." }, 400);

  const venta = (costo) => Math.round(Number(costo) * (1 + margen) * 100) / 100;
  const aClp = (usd) => Math.round(usd * tipoCambio);

  const lineas = [];
  const incompletos = new Set();

  for (const item of items) {
    const cantidad = Number(item.cantidad ?? item.quantity);
    const sku = String(item.sku ?? "").trim();
    const mpn = String(item.mpn ?? "").trim();
    const marca = String(item.marca ?? "").trim();

    if (!sku && !mpn) return error({ estado: "error", mensaje: "Una línea no tiene identificador." }, 400);
    if (!Number.isInteger(cantidad) || cantidad < 1 || cantidad > 10000) {
      return error({ estado: "error", mensaje: "Una línea tiene cantidad inválida." }, 400);
    }

    let comparacion = "completa";
    let resultado = null;

    if (mpn) {
      const params = new URLSearchParams({ mpn });
      if (marca) params.set("marca", marca);
      let intento = await consultar(base, apiKey, params);

      // 409 ambiguo: el mismo MPN existe bajo varias marcas. La API dice cuales;
      // se reintenta una vez con la primera en vez de rendirse.
      if (intento.status === 409 && Array.isArray(intento.datos.marcas) && intento.datos.marcas.length > 0) {
        const conMarca = new URLSearchParams({ mpn, marca: String(intento.datos.marcas[0]) });
        intento = await consultar(base, apiKey, conMarca);
      }
      if (intento.status === 200 && intento.datos?.mejor) resultado = intento.datos;
    }

    // Fallback: sin mpn, o el mejor precio no se pudo resolver. Se cotiza contra
    // Intcomex, que es de donde salio el producto en la busqueda.
    if (!resultado && sku) {
      const params = new URLSearchParams({ proveedor: "intcomex", sku });
      const intento = await consultar(base, apiKey, params);
      if (intento.status === 200 && intento.datos?.mejor) {
        resultado = intento.datos;
        comparacion = "fallback_intcomex";
      }
    }

    if (!resultado) {
      return error({ estado: "producto_no_disponible", sku: sku || mpn, mensaje: "Un producto ya no tiene precio vigente." }, 409);
    }

    const mejor = resultado.mejor;
    // El precio ganador se multiplica por TIPO_CAMBIO_CLP_USD, asi que tiene
    // que venir en dolares. Si viene en otra moneda, falla cerrado: cotizar
    // igual convertiria pesos a pesos y el cliente pagaria ~950 veces de mas.
    if (mejor.moneda && String(mejor.moneda).toUpperCase() !== "USD") {
      return error({ estado: "producto_no_disponible", sku: sku || mpn, mensaje: "Un producto ya no tiene precio vigente." }, 409);
    }

    const precioUsd = venta(mejor.precio);
    if (!Number.isFinite(precioUsd)) return error({ estado: "error", mensaje: "La respuesta del proveedor no es válida." }, 502);

    const faltantes = Array.isArray(resultado.incompleta) ? resultado.incompleta : [];
    for (const f of faltantes) incompletos.add(String(f.proveedor));
    if (comparacion === "completa" && faltantes.length > 0) comparacion = "parcial";

    const ofertas = Array.isArray(resultado.ofertas) ? resultado.ofertas : [];
    const peor = ofertas.reduce((max, o) => (Number(o.precio) > max ? Number(o.precio) : max), Number(mejor.precio));
    const ahorroUnitario = aClp(venta(peor) - precioUsd);

    const precioClp = aClp(precioUsd);
    const disponible = mejor.stock == null ? false : Number(mejor.stock) > 0;

    lineas.push({
      mpn: resultado.mpn || mpn || null,
      marca: resultado.marca || marca || null,
      nombre: item.nombre || resultado.nombre || "Producto",
      cantidad,
      proveedor: String(mejor.proveedor),
      sku_proveedor: String(mejor.sku),
      precio_unitario_usd: precioUsd,
      precio_unitario_clp: precioClp,
      subtotal_neto_clp: precioClp * cantidad,
      disponible,
      abastecimiento: disponible ? "stock_inmediato" : "por_comprar_importar",
      comparacion,
      ofertas_consideradas: ofertas.length,
      ahorro_vs_peor_clp: ahorroUnitario * cantidad
    });
  }

  const neto = lineas.reduce((suma, l) => suma + l.subtotal_neto_clp, 0);
  const ivaClp = Math.round(neto * iva);
  const ahora = new Date();

  const quote = {
    quote_id: crypto.randomUUID(),
    version: 1,
    moneda: "CLP",
    tipo_cambio_clp_usd: tipoCambio,
    iva_rate: iva,
    lineas,
    neto_clp: neto,
    iva_clp: ivaClp,
    total_clp: neto + ivaClp,
    ahorro_total_clp: lineas.reduce((suma, l) => suma + l.ahorro_vs_peor_clp, 0),
    proveedores_incompletos: [...incompletos],
    created_at: ahora.toISOString(),
    valid_until: new Date(ahora.getTime() + horas * 3600000).toISOString()
  };

  // Persistencia best-effort: la cotizacion al registro, y el cliente (si
  // existe) de vuelta al flujo para que facturacion confirme en vez de pedir.
  const telefono = telefonoDesdeContexto(body.execution_context);
  let clienteGuardado = null;
  let persistencia;
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) {
    const [cotizacionGuardada, filas] = await Promise.all([
      // Prefer: merge-duplicates es inerte hoy — quote_id es un UUID fresco
      // en cada cotizacion, asi que nunca colisiona con una fila existente.
      // El dia que una re-cotizacion reutilice un quote_id (para corregirlo
      // en vez de crear uno nuevo), esa colision se resolveria en silencio
      // pisando la fila vieja: la columna `version` existe justamente para
      // ese caso, y ese dia el POST tiene que empezar a usarla en la query.
      supabase(env, "POST", "/cotizaciones", {
        quote_id: quote.quote_id,
        version: String(quote.version),
        telefono,
        neto_clp: quote.neto_clp,
        iva_clp: quote.iva_clp,
        total_clp: quote.total_clp,
        valida_hasta: quote.valid_until,
        lineas: quote.lineas
      }),
      telefono
        ? supabase(env, "GET", `/clientes?telefono=eq.${telefono}&select=rut,razon_social,giro,direccion,comuna,ciudad,email&limit=1`)
        : Promise.resolve(null)
    ]);
    if (Array.isArray(filas) && filas.length > 0) clienteGuardado = filas[0];
    persistencia = cotizacionGuardada !== null ? "ok" : "fallo";
  }

  const varsRespuesta = {
    quote_result: quote,
    quote_id: quote.quote_id,
    quote_version: quote.version,
    quote_total_clp: quote.total_clp,
    quote_valid_until: quote.valid_until
  };
  if (env.SUPABASE_URL && env.SUPABASE_SERVICE_KEY) varsRespuesta.cliente_guardado = clienteGuardado;

  return json({
    estado: "ok",
    quote,
    vars: varsRespuesta,
    ...(persistencia !== undefined ? { persistencia } : {})
  });
}
