import type { VercelRequest, VercelResponse } from '@vercel/node';
import { isAuthorized } from '../../src/auth.js';

// MOCK. No consulta nada: siempre responde la misma linea de credito, sin
// importar que RUT se pida. Existe para que el consumidor (agente de Kapso)
// pueda integrarse contra un contrato estable mientras no exista la conexion
// real con RRS.
//
// La ruta dice /mock a proposito. Un mock de credito que se pueda confundir
// con el real aprueba compras que nadie autorizo; cuando llegue la
// integracion de verdad, vivira en /credito y esta ruta se puede borrar.
const LINEA_CREDITO_CLP = 10_000_000;
const UTILIZADO_CLP = 4_000_000;

type Motivo = 'dentro_de_linea' | 'excede_linea' | 'sin_linea_habilitada';

function firstString(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

// Vercel entrega req.body ya parseado; el servidor local lo deja como texto
// crudo. Devuelve null si el cuerpo no es un objeto JSON.
function parsearCuerpo(body: unknown): Record<string, unknown> | null {
  if (body === undefined || body === null || body === '') return {};
  if (typeof body === 'string') {
    try {
      return parsearCuerpo(JSON.parse(body));
    } catch {
      return null;
    }
  }
  if (typeof body !== 'object' || Array.isArray(body)) return null;
  return body as Record<string, unknown>;
}

// Se aceptan las formas que escribe un humano (12.345.678-9) y se normaliza a
// digitos + DV. No se valida el digito verificador: el mock no tiene padron
// contra que comprobarlo, y rechazar aqui un RUT que el sistema real si conoce
// seria peor que dejarlo pasar.
function normalizarRut(rut: string): string {
  return rut.replace(/[.\s-]/g, '').toUpperCase();
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  if (req.method && req.method !== 'POST') {
    res.status(405).json({ error: 'method_not_allowed', detail: 'Use POST' });
    return;
  }

  if (!isAuthorized(firstString(req.headers['x-api-key']), process.env.API_SECRET_KEY)) {
    res.status(401).json({ error: 'unauthorized', detail: 'Missing or invalid x-api-key header' });
    return;
  }

  const cuerpo = parsearCuerpo(req.body);
  if (!cuerpo) {
    res.status(400).json({
      error: 'bad_request',
      detail: 'El cuerpo debe ser un objeto JSON con los campos rut y total_clp',
    });
    return;
  }

  const rutCrudo = cuerpo.rut;
  if (typeof rutCrudo !== 'string' || normalizarRut(rutCrudo) === '') {
    res.status(400).json({
      error: 'bad_request',
      detail: 'El campo rut es obligatorio y debe ser un string no vacio',
    });
    return;
  }
  const rut = normalizarRut(rutCrudo);

  // Estricto a proposito: el resto de la API cotiza en USD y este endpoint
  // recibe CLP. Coercionar un "1500" que en realidad eran dolares aprobaria un
  // credito por 8.000 veces menos de lo que corresponde.
  const totalClp = cuerpo.total_clp;
  if (typeof totalClp !== 'number' || !Number.isInteger(totalClp) || totalClp <= 0) {
    res.status(400).json({
      error: 'bad_request',
      detail:
        'total_clp debe ser un numero entero de pesos chilenos mayor a 0 (sin puntos, comas ni decimales)',
    });
    return;
  }

  const disponibleClp = LINEA_CREDITO_CLP - UTILIZADO_CLP;
  const aprobado = totalClp <= disponibleClp;
  const motivo: Motivo = aprobado ? 'dentro_de_linea' : 'excede_linea';

  res.status(200).json({
    mock: true,
    rut,
    moneda: 'CLP',
    habilitado: true,
    linea_credito_clp: LINEA_CREDITO_CLP,
    utilizado_clp: UTILIZADO_CLP,
    disponible_clp: disponibleClp,
    solicitado_clp: totalClp,
    aprobado,
    motivo,
    faltante_clp: aprobado ? 0 : totalClp - disponibleClp,
  });
}
