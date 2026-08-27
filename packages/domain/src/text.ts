export function normalize(text: string): string {
  // U+0300-U+036F = marcas diacríticas combinantes que NFD separa de la letra.
  return text.normalize('NFD').replace(/[\u0300-\u036F]/g, '').toLowerCase();
}

export function tokenize(text: string): string[] {
  return normalize(text)
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}
