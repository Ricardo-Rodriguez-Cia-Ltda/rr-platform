import type { VercelResponse } from '@vercel/node';
import { PROVEEDORES, resolverProveedor } from '@rr/providers';
import type { Proveedor } from '@rr/domain/types';

/**
 * Resuelve el proveedor de la ruta o responde el error correspondiente.
 *
 * Devuelve null cuando ya escribio la respuesta, para que el handler corte.
 */
export function resolverOResponder(
  nombreCrudo: string | undefined,
  res: VercelResponse,
): Proveedor | null {
  const proveedor = resolverProveedor(nombreCrudo);
  if (!proveedor) {
    res.status(404).json({
      error: 'proveedor_desconocido',
      detail: `No existe el proveedor '${nombreCrudo}'. Disponibles: ${Object.keys(PROVEEDORES).join(', ')}`,
      proveedor: nombreCrudo ?? null,
    });
    return null;
  }
  if (!proveedor.estaConfigurado()) {
    // No es 502: nadie fallo aguas arriba, falta configuracion nuestra.
    res.status(503).json({
      error: 'proveedor_no_configurado',
      detail: `El proveedor '${proveedor.nombre}' no tiene credenciales configuradas`,
      proveedor: proveedor.nombre,
    });
    return null;
  }
  return proveedor;
}
