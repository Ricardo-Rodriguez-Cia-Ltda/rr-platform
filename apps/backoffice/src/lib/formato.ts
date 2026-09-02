const ZONA = 'America/Santiago';
export function formatCLP(n: number): string {
  return '$' + Math.round(n).toLocaleString('es-CL');
}
export function fechaCorta(iso: string): string {
  const partes = new Intl.DateTimeFormat('en-GB', {
    timeZone: ZONA, day: '2-digit', month: '2-digit', year: 'numeric',
    hour: '2-digit', minute: '2-digit', hour12: false,
  }).formatToParts(new Date(iso));
  const v = (t: string) => partes.find((p) => p.type === t)?.value ?? '';
  const hora = v('hour') === '24' ? '00' : v('hour');
  return `${v('day')}-${v('month')}-${v('year')} ${hora}:${v('minute')}`;
}
