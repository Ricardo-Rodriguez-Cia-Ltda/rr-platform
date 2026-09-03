export interface ItemCarro { sku: string; mpn: string | null; marca: string | null; nombre: string; cantidad: number; precioTiendaClp: number; }
export function leerCarro(): ItemCarro[] { return []; }
export function contarUnidades(items: ItemCarro[]): number { return items.reduce((n, i) => n + i.cantidad, 0); }
