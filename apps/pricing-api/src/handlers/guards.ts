import type { VercelResponse } from '@vercel/node';
import { PROVIDERS, resolveProvider } from '@rr/providers';
import type { Provider } from '@rr/domain/types';

/**
 * Resuelve el proveedor de la ruta o responde el error correspondiente.
 *
 * Devuelve null cuando ya escribio la respuesta, para que el handler corte.
 */
export function resolveOrRespond(
  rawName: string | undefined,
  res: VercelResponse,
): Provider | null {
  const provider = resolveProvider(rawName);
  if (!provider) {
    res.status(404).json({
      error: 'proveedor_desconocido',
      detail: `No existe el proveedor '${rawName}'. Disponibles: ${Object.keys(PROVIDERS).join(', ')}`,
      proveedor: rawName ?? null,
    });
    return null;
  }
  if (!provider.isConfigured()) {
    // No es 502: nadie fallo aguas arriba, falta configuracion nuestra.
    res.status(503).json({
      error: 'proveedor_no_configurado',
      detail: `El proveedor '${provider.nombre}' no tiene credenciales configuradas`,
      proveedor: provider.nombre,
    });
    return null;
  }
  return provider;
}
