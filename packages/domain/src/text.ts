export function normalizar(texto: string): string {
  // U+0300-U+036F = marcas diacríticas combinantes que NFD separa de la letra.
  return texto.normalize('NFD').replace(/[\u0300-\u036F]/g, '').toLowerCase();
}

export function tokenizar(texto: string): string[] {
  return normalizar(texto)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}
