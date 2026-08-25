import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Los prompts de docs/kapso/prompts/ se despliegan copiando y pegando en Kapso.
// El riesgo no es que el texto sea malo, es no saber cual esta arriba: en
// prompts-rayo/ quedaron un v-02 marcado "vigente" y un v-03 sin estado, y no
// hay forma de saber cual corria. Esto verifica el formato, no la prosa.

const RAIZ = 'docs/kapso/prompts';
const ESTADOS = ['vigente', 'reemplazado', 'borrador'];

const AGENTES = readdirSync(RAIZ, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name);

interface Version {
  archivo: string;
  contenido: string;
}

function versionesDe(agente: string): Version[] {
  return readdirSync(`${RAIZ}/${agente}`)
    .filter((n) => /^v-\d+\.md$/.test(n))
    .map((archivo) => ({
      archivo: `${agente}/${archivo}`,
      contenido: readFileSync(`${RAIZ}/${agente}/${archivo}`, 'utf8'),
    }));
}

function campo(contenido: string, nombre: string): string | undefined {
  return new RegExp(`\\| \\*\\*${nombre}\\*\\* \\| (.+?) \\|`).exec(contenido)?.[1]?.trim();
}

const TODAS = AGENTES.flatMap((a) => versionesDe(a).map((v) => ({ ...v, agente: a })));

describe('estructura de docs/kapso/prompts', () => {
  it('hay al menos un agente con versiones', () => {
    expect(TODAS.length).toBeGreaterThan(0);
  });

  it('cada directorio de agente tiene al menos una version', () => {
    for (const agente of AGENTES) {
      expect(versionesDe(agente).length, `${agente} no tiene ningun v-NN.md`).toBeGreaterThan(0);
    }
  });

  it('el README indexa cada directorio de agente', () => {
    const readme = readFileSync(`${RAIZ}/README.md`, 'utf8');
    for (const agente of AGENTES) {
      expect(readme, `falta ${agente} en el indice`).toContain(`${agente}/`);
    }
  });
});

describe('cabecera de cada version', () => {
  it.each(TODAS)('$archivo declara nodo, estado y fecha', ({ contenido }) => {
    expect(campo(contenido, 'Nodo Kapso')).toBeTruthy();
    expect(campo(contenido, 'Estado')).toBeTruthy();
    expect(campo(contenido, 'Fecha')).toBeTruthy();
  });

  it.each(TODAS)('$archivo usa un estado conocido', ({ contenido }) => {
    expect(ESTADOS).toContain(campo(contenido, 'Estado'));
  });

  it.each(TODAS)('$archivo tiene fecha AAAA-MM-DD', ({ contenido }) => {
    expect(campo(contenido, 'Fecha')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.each(TODAS)('$archivo explica que cambio', ({ contenido }) => {
    expect(contenido).toContain('## Qué cambió');
  });
});

describe('el prompt es extraible', () => {
  it.each(TODAS)('$archivo delimita el prompt y no viene vacio', ({ contenido }) => {
    const inicio = contenido.indexOf('<!-- PROMPT:INICIO -->');
    const fin = contenido.indexOf('<!-- PROMPT:FIN -->');

    expect(inicio, 'falta <!-- PROMPT:INICIO -->').toBeGreaterThan(-1);
    expect(fin, 'falta <!-- PROMPT:FIN -->').toBeGreaterThan(inicio);
    expect(contenido.slice(inicio, fin).trim().length).toBeGreaterThan(200);
  });

  it.each(TODAS)('$archivo no usa ** ni # dentro del prompt de WhatsApp', ({ contenido }) => {
    // Los prompts prohiben ** y # al agente porque WhatsApp los muestra
    // literales; los ejemplos dentro de bloques de codigo tienen que respetarlo
    // o le estamos ensenando lo contrario de lo que le pedimos.
    const cuerpo = contenido.slice(
      contenido.indexOf('<!-- PROMPT:INICIO -->'),
      contenido.indexOf('<!-- PROMPT:FIN -->'),
    );
    const ejemplos = [...cuerpo.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1]);
    for (const ejemplo of ejemplos) {
      expect(ejemplo, 'un ejemplo usa ** o #').not.toMatch(/\*\*|^#/m);
    }
  });
});

describe('un solo vigente por agente', () => {
  it.each(AGENTES)('%s tiene como maximo una version vigente', (agente) => {
    const vigentes = versionesDe(agente).filter((v) => campo(v.contenido, 'Estado') === 'vigente');
    expect(vigentes.map((v) => v.archivo).length).toBeLessThanOrEqual(1);
  });

  it.each(AGENTES)('%s marca su version mas alta como vigente o borrador', (agente) => {
    // Si la ultima version quedo como "reemplazado", alguien archivo la nueva y
    // no la escribio: el nodo estaria corriendo un prompt que ya declaramos viejo.
    const versiones = versionesDe(agente).sort((a, b) => a.archivo.localeCompare(b.archivo));
    const ultima = versiones[versiones.length - 1];
    expect(campo(ultima.contenido, 'Estado'), `${ultima.archivo}`).not.toBe('reemplazado');
  });
});
