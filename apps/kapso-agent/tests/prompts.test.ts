import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// Los prompts de apps/kapso-agent/prompts/ se despliegan copiando y pegando en Kapso.
// El riesgo no es que el texto sea malo, es no saber cual esta arriba: en
// prompts-rayo/ quedaron un v-02 marcado "vigente" y un v-03 sin estado, y no
// hay forma de saber cual corria. Esto verifica el formato, no la prosa.

const ROOTS = ['apps/kapso-agent/prompts-v1', 'apps/kapso-agent/prompts'];
const STATES = ['vigente', 'reemplazado', 'borrador'];

const AGENTS = ROOTS.flatMap((root) =>
  readdirSync(root, { withFileTypes: true })
    .filter((e) => e.isDirectory())
    .map((e) => `${root}/${e.name}`)
);

interface Version {
  file: string;
  content: string;
}

function versionsOf(agent: string): Version[] {
  return readdirSync(agent)
    .filter((n) => /^v-\d+\.md$/.test(n))
    .map((file) => ({
      file: `${agent}/${file}`,
      content: readFileSync(`${agent}/${file}`, 'utf8'),
    }));
}

function field(content: string, name: string): string | undefined {
  return new RegExp(`\\| \\*\\*${name}\\*\\* \\| (.+?) \\|`).exec(content)?.[1]?.trim();
}

const ALL = AGENTS.flatMap((a) => versionsOf(a).map((v) => ({ ...v, agent: a })));

describe('estructura de apps/kapso-agent/prompts', () => {
  it('hay al menos un agente con versiones', () => {
    expect(ALL.length).toBeGreaterThan(0);
  });

  it('cada directorio de agente tiene al menos una version', () => {
    for (const agent of AGENTS) {
      expect(versionsOf(agent).length, `${agent} no tiene ningun v-NN.md`).toBeGreaterThan(0);
    }
  });

  it('el README indexa cada directorio de agente', () => {
    for (const agent of AGENTS) {
      const root = agent.slice(0, agent.lastIndexOf('/'));
      const name = agent.slice(agent.lastIndexOf('/') + 1);
      const readme = readFileSync(`${root}/README.md`, 'utf8');
      expect(readme, `falta ${name} en el indice de ${root}`).toContain(`${name}/`);
    }
  });
});

describe('cabecera de cada version', () => {
  it.each(ALL)('$file declara nodo, estado y fecha', ({ content }) => {
    expect(field(content, 'Nodo Kapso')).toBeTruthy();
    expect(field(content, 'Estado')).toBeTruthy();
    expect(field(content, 'Fecha')).toBeTruthy();
  });

  it.each(ALL)('$file usa un estado conocido', ({ content }) => {
    expect(STATES).toContain(field(content, 'Estado'));
  });

  it.each(ALL)('$file tiene fecha AAAA-MM-DD', ({ content }) => {
    expect(field(content, 'Fecha')).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it.each(ALL)('$file explica que cambio', ({ content }) => {
    expect(content).toContain('## Qué cambió');
  });
});

describe('el prompt es extraible', () => {
  it.each(ALL)('$file delimita el prompt y no viene vacio', ({ content }) => {
    const start = content.indexOf('<!-- PROMPT:INICIO -->');
    const end = content.indexOf('<!-- PROMPT:FIN -->');

    expect(start, 'falta <!-- PROMPT:INICIO -->').toBeGreaterThan(-1);
    expect(end, 'falta <!-- PROMPT:FIN -->').toBeGreaterThan(start);
    expect(content.slice(start, end).trim().length).toBeGreaterThan(200);
  });

  it.each(ALL)('$file no usa ** ni # dentro del prompt de WhatsApp', ({ content }) => {
    // Los prompts prohiben ** y # al agente porque WhatsApp los muestra
    // literales; los ejemplos dentro de bloques de codigo tienen que respetarlo
    // o le estamos ensenando lo contrario de lo que le pedimos.
    const body = content.slice(
      content.indexOf('<!-- PROMPT:INICIO -->'),
      content.indexOf('<!-- PROMPT:FIN -->'),
    );
    const examples = [...body.matchAll(/```\n([\s\S]*?)```/g)].map((m) => m[1]);
    for (const example of examples) {
      expect(example, 'un ejemplo usa ** o #').not.toMatch(/\*\*|^#/m);
    }
  });
});

describe('un solo vigente por agente', () => {
  it.each(AGENTS)('%s tiene como maximo una version vigente', (agent) => {
    const current = versionsOf(agent).filter((v) => field(v.content, 'Estado') === 'vigente');
    expect(current.map((v) => v.file).length).toBeLessThanOrEqual(1);
  });

  // En v2 no alcanza con "como maximo una": `scripts/deploy-workflow.ts`
  // elige el archivo a desplegar por esa marca, asi que cero vigentes rompe el
  // despliegue igual que dos.
  it.each(AGENTS.filter((a) => a.startsWith('apps/kapso-agent/prompts/')))(
    '%s tiene exactamente una version vigente, que es la que se despliega',
    (agent) => {
      const current = versionsOf(agent).filter((v) => field(v.content, 'Estado') === 'vigente');
      expect(current.map((v) => v.file)).toHaveLength(1);
    },
  );

  it.each(AGENTS)('%s marca su version mas alta como vigente o borrador', (agent) => {
    // Si la ultima version quedo como "reemplazado", alguien archivo la nueva y
    // no la escribio: el nodo estaria corriendo un prompt que ya declaramos viejo.
    const versions = versionsOf(agent).sort((a, b) => a.file.localeCompare(b.file));
    const last = versions[versions.length - 1];
    expect(field(last.content, 'Estado'), `${last.file}`).not.toBe('reemplazado');
  });
});

// Segunda vez que se cuela este bug: la tabla del README quedo apuntando a
// una version vieja mientras el directorio del agente ya tenia otra marcada
// `vigente` (paso con agente-facturacion, README en v-02 mientras v-03 ya
// era la vigente). `scripts/deploy-workflow.ts` despliega por la marca
// `vigente` de los archivos, no por lo que dice el README, asi que un README
// desactualizado no rompe el despliegue — pero si engaña a quien lo lee.
describe('el README coincide con la version marcada vigente', () => {
  it.each(AGENTS)('%s: la version del indice es la que esta marcada vigente', (agent) => {
    const root = agent.slice(0, agent.lastIndexOf('/'));
    const name = agent.slice(agent.lastIndexOf('/') + 1);
    const readme = readFileSync(`${root}/README.md`, 'utf8');

    const fila = readme.split('\n').find((line) => line.includes(`(${name}/)`));
    expect(fila, `${name} no aparece en la tabla de ${root}/README.md`).toBeDefined();

    const celdas = fila!.split('|').map((c) => c.trim()).filter((c) => c !== '');
    const versionEnReadme = celdas[celdas.length - 1];

    const vigente = versionsOf(agent).find((v) => field(v.content, 'Estado') === 'vigente');

    if (!/^v-\d+$/.test(versionEnReadme)) {
      // El README no declara una version numerada como vigente (p. ej.
      // "— (borrador)"): entonces ningun archivo del agente debe estar
      // marcado `vigente`.
      expect(vigente, `${name}: el README no marca vigente pero hay un v-NN.md que si`).toBeUndefined();
      return;
    }

    expect(vigente, `${name}: el README dice "${versionEnReadme}" vigente pero ningun archivo esta marcado vigente`).toBeDefined();
    const versionReal = vigente!.file.match(/\/(v-\d+)\.md$/)?.[1];
    expect(versionReal, `${name}: el README dice "${versionEnReadme}" pero la version vigente es "${versionReal}"`).toBe(versionEnReadme);
  });
});

// La arista `fn_cotizar → agente_presentacion` es incondicional: el nodo
// tambien corre cuando `generar-cotizacion-v2` respondio un error. La function
// limpia `quote_result`, y la otra mitad del arreglo es la regla del prompt que
// impide presentar la cotizacion anterior. Vive en prosa, asi que lo unico que
// evita perderla en la proxima version es una prueba que la busque.
describe('reglas de v2 que no se pueden perder al subir una version', () => {
  it('el prompt vigente de agente_presentacion cubre la cotizacion ausente', () => {
    const dir = 'apps/kapso-agent/prompts/agente-presentacion';
    const current = versionsOf(dir).find((v) => field(v.content, 'Estado') === 'vigente');
    if (!current) throw new Error(`${dir} no tiene version vigente`);

    const body = current.content.slice(
      current.content.indexOf('<!-- PROMPT:INICIO -->'),
      current.content.indexOf('<!-- PROMPT:FIN -->'),
    );
    expect(body, 'el prompt no menciona quote_result').toContain('quote_result');
    expect(body, 'la cotizacion ausente no deriva a una persona').toContain('handoff_to_human');
    expect(body, 'falta la regla de que quote_result puede venir vacia').toMatch(/vac[ií]a|null/i);
  });
});
