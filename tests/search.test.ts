import { describe, expect, it } from 'vitest';
import { buscar, calcularFacetas, normalizar, tokenizar } from '../lib/search.js';
import type { CatalogProduct } from '../lib/search.js';

function producto(
  Sku: string,
  Mpn: string,
  Description: string,
  marca: string,
  categoria = 'Computadores',
): CatalogProduct {
  return {
    Sku,
    Mpn,
    Description,
    Brand: { Description: marca },
    Category: { Description: categoria, Subcategories: [] },
  };
}

const CATALOGO: CatalogProduct[] = [
  producto('MT027DEL20', 'P2725HE', 'Dell P2725HE - 27" - 1920 x 1080 - IPS - USB-C', 'Dell', 'Monitores'),
  producto('NT016HPQ53', '2N6G5LT#ABM', 'HP ProBook 640 G8 - Notebook - 14" - Intel Core i7', 'HP'),
  producto('100016385', '4P5H8AA', 'HyperX CloudX Gaming - Auricular - tamaño completo - cableado', 'HyperX', 'Audio'),
  producto('ID020LOG11', '920-008813', 'Logitech K380 - Teclado - inalámbrico - Bluetooth', 'Logitech', 'Accesorios'),
  // Decoy: su MPN contiene "27" como fragmento, igual que un termino comun
  // de consulta ("monitor dell 27"). No debe hijackear el ranking del monitor.
  producto('CB027KIN01', '27-ABC12', 'Kingston USB-C Cable - 2m - Carga rapida', 'Kingston', 'Accesorios'),
];

describe('normalizar', () => {
  it('pasa a minúsculas y quita tildes', () => {
    expect(normalizar('Inalámbrico ÑOÑO')).toBe('inalambrico nono');
  });
});

describe('tokenizar', () => {
  it('parte en palabras completas descartando puntuación', () => {
    expect(tokenizar('HP ProBook 640 G8 - 14"')).toEqual(['hp', 'probook', '640', 'g8', '14']);
  });
});

describe('buscar', () => {
  it('no devuelve HyperX al buscar hp (palabras completas, no subcadenas)', () => {
    const skus = buscar(CATALOGO, { q: 'hp' }).map((r) => r.product.Sku);
    expect(skus).toContain('NT016HPQ53');
    expect(skus).not.toContain('100016385');
  });

  it('encuentra el monitor Dell aunque su descripción no diga "monitor"', () => {
    const skus = buscar(CATALOGO, { q: 'monitor dell 27' }).map((r) => r.product.Sku);
    expect(skus[0]).toBe('MT027DEL20');
  });

  it('encuentra "inalámbrico" buscando sin tilde', () => {
    const skus = buscar(CATALOGO, { q: 'teclado logitech inalambrico' }).map((r) => r.product.Sku);
    expect(skus[0]).toBe('ID020LOG11');
  });

  it('da la máxima prioridad a una coincidencia exacta de MPN', () => {
    const resultados = buscar(CATALOGO, { q: 'P2725HE' });
    expect(resultados[0].product.Sku).toBe('MT027DEL20');
    expect(resultados[0].score).toBeGreaterThanOrEqual(100);
  });

  it('ordena por cantidad de términos coincidentes', () => {
    const resultados = buscar(CATALOGO, { q: 'hp probook notebook' });
    expect(resultados[0].product.Sku).toBe('NT016HPQ53');
  });

  it('filtra por marca sin considerarla en el puntaje de texto', () => {
    const skus = buscar(CATALOGO, { q: 'notebook', marca: 'HP' }).map((r) => r.product.Sku);
    expect(skus).toEqual(['NT016HPQ53']);
  });

  it('filtra por categoría', () => {
    const skus = buscar(CATALOGO, { q: 'dell', categoria: 'Monitores' }).map((r) => r.product.Sku);
    expect(skus).toEqual(['MT027DEL20']);
  });

  it('devuelve vacío cuando ningún término calza', () => {
    expect(buscar(CATALOGO, { q: 'tractor agricola' })).toEqual([]);
  });

  it('MPN exacto con puntuación recibe el bonus exactamente una vez', () => {
    const resultados = buscar(CATALOGO, { q: '2N6G5LT#ABM' });
    // Score: MPN bonus 100 (no brand ni descripción calzan con tokens ['2n6g5lt','abm'])
    expect(resultados[0].product.Sku).toBe('NT016HPQ53');
    expect(resultados[0].score).toBe(100);
  });

  it('producto sin MPN coincidente no recibe bonus MPN', () => {
    // Buscar 'notebook' coincide con la descripción del ProBook pero no con su MPN
    const resultados = buscar(CATALOGO, { q: 'notebook' });
    const probook = resultados.find((r) => r.product.Sku === 'NT016HPQ53');
    expect(probook).toBeDefined();
    expect(probook!.score).toBe(3); // Solo descripción, sin bonus MPN
  });

  it('MPN de un token y dos tokens reciben el mismo bonus base cuando se buscan exactamente', () => {
    // P2725HE es un token, 2N6G5LT#ABM son dos tokens
    const result1 = buscar(CATALOGO, { q: 'P2725HE' });
    const result2 = buscar(CATALOGO, { q: '2N6G5LT#ABM' });
    // result1: 100 (MPN exacto) + 3 (el termino "p2725he" tambien esta en la
    // descripcion del propio producto). result2: 100 (MPN exacto), ninguno
    // de sus dos tokens ("2n6g5lt", "abm") aparece en marca ni descripcion.
    expect(result1[0].score).toBe(103);
    expect(result2[0].score).toBe(100);
  });

  it('un fragmento de MPN que calza con un termino de la consulta no otorga el bonus (evita hijack de ranking)', () => {
    const resultados = buscar(CATALOGO, { q: 'monitor dell 27' });
    expect(resultados[0].product.Sku).toBe('MT027DEL20');
    expect(resultados[0].score).toBe(16); // 10 marca + 3 "dell" + 3 "27" en descripcion, sin bonus MPN

    const decoy = resultados.find((r) => r.product.Sku === 'CB027KIN01');
    // El decoy (MPN "27-ABC12") no matchea ni marca ni descripcion con estos
    // terminos, asi que ni siquiera aparece en los resultados (score 0).
    expect(decoy).toBeUndefined();
  });

  it('MPN con guion calza completo cuando la consulta trae el mismo guion', () => {
    const resultados = buscar(CATALOGO, { q: '920-008813' });
    expect(resultados[0].product.Sku).toBe('ID020LOG11');
    expect(resultados[0].score).toBe(100);
  });

  it('el mismo MPN escrito sin el guion tambien recibe el bonus', () => {
    const resultados = buscar(CATALOGO, { q: '920008813' });
    expect(resultados[0].product.Sku).toBe('ID020LOG11');
    expect(resultados[0].score).toBe(100);
  });
});

describe('calcularFacetas', () => {
  it('cuenta marcas y categorías presentes, ordenadas por frecuencia', () => {
    const facetas = calcularFacetas([CATALOGO[1], CATALOGO[1], CATALOGO[0]]);
    expect(facetas.marca[0]).toEqual({ valor: 'HP', n: 2 });
    expect(facetas.marca).toContainEqual({ valor: 'Dell', n: 1 });
    expect(facetas.categoria[0]).toEqual({ valor: 'Computadores', n: 2 });
  });
});

// Cuando se filtra por marca o categoria, esos terminos ya no deben puntuar:
// si lo hacen, ahogan al termino que de verdad discrimina. Medido en vivo:
// q="notebook HP" + marca=HP devolvia mochilas, mouses y monitores HP, porque
// "hp" sumaba 13 puntos en los 804 productos de la marca y "notebook" solo 3.
describe('buscar — el termino del filtro no puntua', () => {
  const CATALOGO_HP: CatalogProduct[] = [
    producto('NT1', 'MPN-NT1', 'HP ProBook 640 - Notebook - 14"', 'HP'),
    producto('MO1', 'MPN-MO1', 'HP - Mouse - Wired - 265A9UT', 'HP', 'Perifericos'),
    producto('MT1', 'MPN-MT1', 'HP - LED-backlit LCD monitor - 27"', 'HP', 'Monitores'),
  ];

  it('con marca=HP, "notebook HP" solo trae el notebook', () => {
    const skus = buscar(CATALOGO_HP, { q: 'notebook HP', marca: 'HP' }).map((r) => r.product.Sku);
    expect(skus).toEqual(['NT1']);
  });

  it('con categoria, el nombre de la categoria tampoco puntua', () => {
    const skus = buscar(CATALOGO_HP, { q: 'mouse perifericos', categoria: 'Perifericos' }).map(
      (r) => r.product.Sku,
    );
    expect(skus).toEqual(['MO1']);
  });

  it('si la consulta era solo la marca, sigue devolviendo todo lo de esa marca', () => {
    const skus = buscar(CATALOGO_HP, { q: 'HP', marca: 'HP' }).map((r) => r.product.Sku);
    expect(skus).toHaveLength(3);
  });

  it('sin filtro de marca, la marca sigue puntuando como antes', () => {
    const resultados = buscar(CATALOGO_HP, { q: 'HP mouse' });
    expect(resultados[0].product.Sku).toBe('MO1');
    expect(resultados).toHaveLength(3);
  });
});
