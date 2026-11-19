import { describe, expect, it } from 'vitest';
import { CASES, rasterize } from '../bench/cases';
import { renderSvg } from '../bench/io';
import { compare } from '../bench/metrics';
import { PRESETS } from '../src/engine/presets';
import { toSVG } from '../src/engine/svg';
import { Options, RawImage } from '../src/engine/types';
import { vectorize } from '../src/engine/vectorize';
import { applyPaletteEdits, backgroundOriginal, canHideWithoutReprocess, deltaE, hasEdits, layerArea, mergeColors, mergeSimilar, normalizeHex, paletteEntries, resetColor, setColor, setHidden, suggestCurrentColor } from '../src/engine/palette';
import { exportDoc } from '../src/export';

const logoCase = CASES.find((c) => c.id === 'logo')!;
const logoOpts: Options = PRESETS[0].options;
const logo = vectorize(rasterize(logoCase.svg), logoOpts); // cutouts: branco, azul, escuro, laranja
const BLUE = '#2547d0', WHITE = '#ffffff', ORANGE = '#ff7a1a';
const str = (d: string | Uint8Array) => (typeof d === 'string' ? d : Buffer.from(d).toString('latin1'));
const px = { unit: 'px' as const, dpi: 96 };

function twoTone(a: number[], b: number[]): RawImage {
  const w = 80, h = 40, data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...(x < 40 ? a : b), 255], (y * w + x) * 4);
  return { data, width: w, height: h };
}

describe('normalizeHex', () => {
  it('aceita #abc, abc e #AABBCC; rejeita lixo', () => {
    expect(normalizeHex('#abc')).toBe('#aabbcc');
    expect(normalizeHex('ABC')).toBe('#aabbcc');
    expect(normalizeHex(' #2547D0 ')).toBe('#2547d0');
    for (const bad of ['', '#12', '#gggggg', '12345', '#1234567', 'red']) expect(normalizeHex(bad)).toBeNull();
  });
});

describe('edição de paleta (sobre o vetor, sem reprocessar)', () => {
  it('lista as camadas com cor atual, área e contagens', () => {
    const e = paletteEntries(logo);
    expect(e.map((x) => x.original).sort()).toEqual([BLUE, ORANGE, '#171a2b', WHITE].sort());
    expect(e.every((x) => !x.hidden && !x.edited && x.color === x.original)).toBe(true);
    expect(e.find((x) => x.original === WHITE)!.area).toBeGreaterThan(e.find((x) => x.original === BLUE)!.area);
  });

  it('trocar uma cor: só ela muda, o vetor original NÃO é alterado e as formas são as mesmas', () => {
    const before = JSON.stringify(logo.layers);
    const doc = applyPaletteEdits(logo, setColor({}, BLUE, '#FF0000'));
    expect(doc.layers.map((l) => l.color)).toContain('#ff0000');
    expect(doc.layers.map((l) => l.color)).not.toContain(BLUE);
    expect(JSON.stringify(logo.layers)).toBe(before);
    expect(doc.stats.nodes).toBe(logo.stats.nodes);
    expect(doc.layers.find((l) => l.color === '#ff0000')!.paths).toEqual(logo.layers.find((l) => l.color === BLUE)!.paths);
  });

  it('hex inválido é ignorado', () => {
    expect(setColor({}, BLUE, 'azul')).toEqual({});
  });

  it('transparente: a camada some, o documento fica com borda aberta e o SVG tem recorte', () => {
    const doc = applyPaletteEdits(logo, setHidden({}, WHITE, true));
    expect(doc.layers.some((l) => l.color === WHITE)).toBe(false);
    expect(logo.openBoundary).toBe(false);
    expect(doc.openBoundary).toBe(true);
    expect(toSVG(doc, logoOpts)).toContain('<clipPath id="uniao">'); // fendas não crescem a silhueta
    const r = renderSvg(toSVG(doc, logoOpts), logo.width);
    expect(r.data[3]).toBe(0); // canto superior esquerdo: transparente
    const blue = (120 * r.width + 256) * 4; // dentro do círculo azul, acima do “V”
    expect(r.data[blue + 3]).toBe(255);
    const vee = (256 * r.width + 256) * 4; // o “V” era a cor do fundo: agora é um furo transparente
    expect(r.data[vee + 3]).toBe(0);
  });

  it('remover fundo: a camada de maior área é o fundo', () => {
    expect(backgroundOriginal(logo)).toBe(WHITE);
    const doc = applyPaletteEdits(logo, setHidden({}, backgroundOriginal(logo)!, true));
    expect(doc.stats.colors).toBe(logo.stats.colors - 1);
  });

  it('mesclar cores iguais: camadas de mesma cor viram uma só (caminhos somados)', () => {
    const dark = '#171a2b';
    const edits = mergeColors(logo, {}, [BLUE, dark]); // alvo = cor atual do primeiro da lista de camadas
    const doc = applyPaletteEdits(logo, edits);
    const target = paletteEntries(logo).find((e) => [BLUE, dark].includes(e.original))!.color;
    expect(doc.layers.filter((l) => l.color === target).length).toBe(1);
    const sum = logo.layers.filter((l) => [BLUE, dark].includes(l.color)).reduce((n, l) => n + l.paths.length, 0);
    expect(doc.layers.find((l) => l.color === target)!.paths.length).toBe(sum);
    expect(doc.stats.colors).toBe(logo.stats.colors - 1);
    expect(doc.stats.paths).toBe(logo.stats.paths);
  });

  it('mesclar com alvo explícito e restaurar uma cor', () => {
    let edits = mergeColors(logo, {}, [BLUE, ORANGE], '#00ff00');
    expect(applyPaletteEdits(logo, edits).layers.filter((l) => l.color === '#00ff00').length).toBe(1);
    edits = resetColor(edits, ORANGE);
    expect(applyPaletteEdits(logo, edits).layers.map((l) => l.color)).toContain(ORANGE);
  });

  it('mesclar semelhantes: tons quase iguais viram um só (cor da camada maior); cores distintas ficam', () => {
    const img = twoTone([37, 71, 208], [42, 76, 212]); // ΔE ≈ 3
    const doc = vectorize(img, { ...logoOpts, maxColors: 4, mergeDeltaE: 0, gapFiller: false });
    expect(doc.layers.length).toBe(2);
    expect(deltaE(doc.layers[0].color, doc.layers[1].color)).toBeLessThan(5);
    const r = mergeSimilar(doc, {}, 8);
    expect(r.merged).toBe(1);
    expect(applyPaletteEdits(doc, r.edits).layers.length).toBe(1);
    // as cores bem diferentes do logo NÃO são mescladas com limiar baixo
    expect(mergeSimilar(logo, {}, 8).merged).toBe(0);
  });

  it('restaurar a paleta: sem edições o resultado equivale ao original', () => {
    const edited = applyPaletteEdits(logo, { ...setColor({}, BLUE, '#123456'), ...setHidden({}, WHITE, true) });
    expect(hasEdits({})).toBe(false);
    const back = applyPaletteEdits(logo, {});
    expect(back.layers.map((l) => l.color).sort()).toEqual(logo.layers.map((l) => l.color).sort());
    expect(back.openBoundary).toBe(logo.openBoundary);
    expect(edited.layers.length).not.toBe(back.layers.length);
  });

  it('as edições são por cor ORIGINAL e valem também depois de reprocessar com outros parâmetros', () => {
    const edits = setColor({}, BLUE, '#ff00ff');
    const again = vectorize(rasterize(logoCase.svg), { ...logoOpts, lineFitTolerance: 0.5 });
    expect(applyPaletteEdits(again, edits).layers.map((l) => l.color)).toContain('#ff00ff');
  });

  it('empilhado: só a camada de baixo oculta sem revelar outra; mesclar preserva a ordem das camadas', () => {
    const ic = CASES.find((c) => c.id === 'illustration')!;
    const st = vectorize(rasterize(ic.svg), PRESETS.find((p) => p.id === 'illustration')!.options);
    expect(st.stacking).toBe('stacked');
    expect(canHideWithoutReprocess(st, st.layers[0].color)).toBe(true);
    expect(canHideWithoutReprocess(st, st.layers[3].color)).toBe(false);
    expect(canHideWithoutReprocess(logo, BLUE)).toBe(true);
    expect(backgroundOriginal(st)).toBe(st.layers[0].color);
    const merged = applyPaletteEdits(st, mergeColors(st, {}, [st.layers[1].color, st.layers[2].color]));
    expect(merged.layers.length).toBe(st.layers.length); // não concatena: cada camada contém as seguintes
  });

  it('currentColor sugerido: a maior área entre as escuras', () => {
    const doc = applyPaletteEdits(logo, setHidden({}, WHITE, true));
    expect(suggestCurrentColor(doc)).toBe(BLUE);
    expect(layerArea(doc.layers[0])).toBeGreaterThan(0);
  });
});

describe('cores do SVG: hex, currentColor e classes CSS editáveis', () => {
  // ícone monocromático: fundo transparente + tudo numa cor
  const mono = applyPaletteEdits(logo, { ...setHidden({}, WHITE, true), ...mergeColors(logo, {}, [BLUE, ORANGE, '#171a2b'], '#000000') });

  it('hex (padrão) não muda', () => {
    expect(toSVG(mono, logoOpts)).toContain('fill="#000000"');
  });
  it('currentColor: a cor escolhida herda do CSS; as demais ficam em hex', () => {
    const svg = toSVG(mono, logoOpts, {}, { mode: 'currentColor' });
    expect(svg).toContain('fill="currentColor"');
    expect(svg).not.toContain('fill="#000000"');
    const duo = applyPaletteEdits(logo, setHidden({}, WHITE, true));
    const s2 = toSVG(duo, logoOpts, {}, { mode: 'currentColor', currentColor: BLUE });
    expect(s2).toContain('fill="currentColor"');
    expect(s2).toContain(`fill="${ORANGE}"`); // as outras continuam fixas
    expect(s2).toContain('stroke="currentColor"'); // inclusive o traço de fenda da mesma cor
  });
  it('currentColor renderiza igual ao hex quando a cor herdada é a mesma (preto padrão)', () => {
    const a = renderSvg(toSVG(mono, logoOpts), 256), b = renderSvg(toSVG(mono, logoOpts, {}, { mode: 'currentColor' }), 256);
    expect(compare(a, b).ssim).toBeGreaterThan(0.9999);
  });
  it('classes: <style> com uma regra por cor e as formas usam class; renderização idêntica', () => {
    const svg = toSVG(logo, logoOpts, {}, { mode: 'classes' });
    const rules = [...svg.matchAll(/\.c(\d+)\{fill:(#[0-9a-f]{6})\}\.s\1\{stroke:\2\}/g)];
    expect(rules.length).toBe(logo.layers.length);
    expect(svg).toMatch(/<path class="c\d+" fill-rule="nonzero"/);
    expect(svg).not.toMatch(/fill="#[0-9a-f]{6}"/);
    const a = renderSvg(toSVG(logo, logoOpts), 256), b = renderSvg(svg, 256);
    expect(compare(a, b).ssim).toBeGreaterThan(0.9999);
  });
});

describe('as edições chegam aos exportadores', () => {
  const edited = applyPaletteEdits(logo, { ...setColor({}, BLUE, '#ff0000'), ...setHidden({}, WHITE, true) });
  it('SVG: cor nova presente, original e fundo ausentes', () => {
    const svg = str(exportDoc('svg', edited, logoOpts, px, 512, 512).data);
    expect(svg).toContain('#ff0000');
    expect(svg).not.toContain(BLUE);
    expect(svg).not.toContain('"#ffffff"');
  });
  it('PDF e EPS usam a cor nova (1 0 0)', () => {
    expect(str(exportDoc('pdf', edited, logoOpts, px, 512, 512).data)).toContain('1 0 0 rg');
    expect(str(exportDoc('eps', edited, logoOpts, px, 512, 512).data)).toContain('1 0 0 setrgbcolor');
  });
  it('PDF com camada oculta usa recorte pela união (W n)', () => {
    expect(str(exportDoc('pdf', edited, logoOpts, px, 512, 512).data)).toContain('W n\n');
  });
  it('DXF: uma layer a menos por camada oculta; cor nova vira layer', () => {
    const o = { ...logoOpts, groupBy: 'color' as const };
    const layers = (d: typeof logo) => str(exportDoc('dxf', d, o, px, 512, 512).data).split('\n').filter((l, i, a) => l === 'LAYER' && a[i - 1] === '0' && a[i + 1] === '2').length;
    expect(layers(edited)).toBe(layers(logo) - 1);
    expect(str(exportDoc('dxf', edited, o, px, 512, 512).data)).toContain('COR_FF0000');
  });
  it('exportDoc passa o modo de cor ao SVG', () => {
    const svg = str(exportDoc('svg', edited, logoOpts, px, 512, 512, { mode: 'classes' }).data);
    expect(svg).toContain('<style>');
  });
});
