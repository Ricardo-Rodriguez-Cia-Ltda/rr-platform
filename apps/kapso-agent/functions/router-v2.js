// Un solo router para los tres nodos `decide` de v2. Esta fusionado y no
// dividido en tres functions por una razon dura, no por gusto: el plan de Kapso
// permite 5 Cloudflare Workers desplegados, y el workflow ya necesita cuatro
// functions de trabajo (validar-rut, buscar-productos, generar-cotizacion,
// emitir-ordenes-compra). Tres routers separados no caben; uno si.
//
// Como sabe que decision le estan pidiendo: cada nodo `decide` manda sus
// propias `available_edges`, y las tres tienen una arista distintiva —
// `accepted` solo la de la cotizacion, `expired` solo la de vigencia,
// `invalid` solo la del RUT. No hace falta que el nodo mande nada extra.
//
// Una function en `draft` no se ejecuta: Kapso responde 422 "Function is not
// deployed". Por eso los tres nodos que dependian de routers sin desplegar
// dejaban la conversacion colgada.
async function handler(request, env) {
  const body = await request.json().catch(() => ({}));
  const vars = body.execution_context?.vars || {};
  const disponibles = body.available_edges || [];
  const elegir = (deseado) => (disponibles.includes(deseado) ? deseado : disponibles[0] || deseado);

  // Decision del cliente sobre la cotizacion. Ante un valor desconocido cae en
  // `rejected`, que es el camino reversible: seguir conversando en vez de
  // emitir ordenes de compra que cuestan dinero.
  if (disponibles.includes("accepted")) {
    const decision = String(vars.quote_decision) === "accepted" ? "accepted" : "rejected";
    return responder(elegir(decision));
  }

  // Vigencia de la cotizacion. Sin fecha legible se considera expirada: se
  // recalcula, en vez de emitir a ciegas contra un precio que ya no existe.
  if (disponibles.includes("expired")) {
    const crudo =
      vars.quote_result?.quote?.valid_until ||
      vars.quote_result?.valid_until ||
      vars.quote_valid_until ||
      "";
    const instante = Date.parse(String(crudo));
    const expirada = !Number.isFinite(instante) || Date.now() >= instante;
    return responder(elegir(expirada ? "expired" : "valid"), { quote_expired: expirada });
  }

  // Resultado de la validacion de RUT. Solo `true` explicito vale como valido.
  if (disponibles.includes("invalid")) {
    return responder(elegir(vars.rut_valid === true ? "valid" : "invalid"));
  }

  // Aristas que este router no conoce: se toma la primera, que es la salida por
  // defecto del nodo. Reventar aqui dejaria la conversacion colgada sin decir
  // por que, que es exactamente lo que estamos arreglando.
  return responder(disponibles[0] || "");
}

function responder(next, vars) {
  const cuerpo = vars ? { next_edge: next, vars } : { next_edge: next };
  return new Response(JSON.stringify(cuerpo), { headers: { "Content-Type": "application/json" } });
}
