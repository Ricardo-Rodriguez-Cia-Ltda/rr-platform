import type { VercelRequest, VercelResponse } from '@vercel/node';
import { crearAlertar } from '../../src/pago/alerta.js';
import { createWebhookHandler } from '../../src/pago/webhook.js';

// El techo de ejecucion. Declarado aca y no en `vercel.json` a proposito: el
// runtime de Node lee este export del propio archivo de la funcion y gana
// sobre la configuracion por globs, sin depender de en que orden Vercel
// resuelva dos patrones que se solapan. Con la entrada especifica de
// `vercel.json` bastaba con que el glob general ganara para que el techo se
// quedara en 30s y el handler muriera a mitad del desenlace -- sin ningun
// error visible y sin mas defensa que un paso manual del runbook.
//
// 300 cubre el peor caso del camino aprobado sumando los AbortSignal.timeout
// reales (consultarPago 10s + leerPago 8s + reclamarAprobado 8s +
// leerCotizacion 8s + invocarFunction 30+30+60s + marcarEstado 8s +
// marcarPedidosPagados 8s + enviarTexto 5s = 175s) con margen, y es el maximo
// documentado de Vercel fuera de fluid compute. Exige un plan que lo admita:
// en Hobby el tope es 60.
export const maxDuration = 300;

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  return createWebhookHandler(crearAlertar(process.env))(req, res);
}
