import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { CASES, rasterize } from '../bench/cases';
import { renderSvg } from '../bench/io';
import { compare } from '../bench/metrics';
import { applyPaletteEdits } from '../src/engine/palette';
import { PRESETS } from '../src/engine/presets';
import { ShapeEdits, applyShapeEdits, editShapes, listShapes, remapShapeEdits, shapeMapDoc, shapesAt, shapesInRect, similarShapes } from '../src/engine/shapes';
import { toSVG } from '../src/engine/svg';
import { Options } from '../src/engine/types';
import { vectorize } from '../src/engine/vectorize';
import { exportDoc } from '../src/export';

const opts = (p: Partial<Options> = {}): Options => ({ ...PRESETS[0].options, ...p });
const wrap = (body: string, bg = '#ffffff', w = 256, h = 256) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ''}${body}</svg>`;
const ras = (svg: string) => rasterize(svg, 256);
const TWO = wrap('<circle cx="70" cy="128" r="50" fill="#d0342c"/><rect x="140" y="78" width="100" height="100" fill="#2c5fd0"/><circle cx="190" cy="128" r="20" fill="#ffffff"/>');

describe('formas: modelo', () => {
  const doc = vectorize(ras(TWO), opts());

  it('todo caminho tem id de forma; furos compartilham o id do contorno', () => {
    for (const l of doc.layers) for (const p of l.paths) expect(p.sid).toBeTypeOf('number');
    const shapes = listShapes(doc);
    expect(doc.stats.shapes).toBe(new Set(shapes.map((s) => s.id)).size);
    const blue = shapes.find((s) => s.color.toLowerCase().startsWith('#2c5') || s.color === '#2c5fd0');
    expect(blue).toBeTruthy();
    expect(blue!.paths.length).toBe(2); // quadrado + furo do círculo branco
  });

  it('seleção por ponto (a mais à frente primeiro) e por retângulo', () => {
    const shapes = listShapes(doc);
    const red = shapes.find((s) => s.color.startsWith('#d0') || s.color === '#d0342c')!;
    const hit = shapesAt(doc, 70, 128); // centro do círculo vermelho
    expect(hit).toContain(red.id);
    expect(shapesAt(doc, 5, 5).length).toBeGreaterThan(0); // fundo
    const inside = shapesInRect(doc, [0, 0, 150, 256]);
    expect(inside).toContain(red.id);
    expect(inside).not.toContain(shapes.find((s) => s.area > 40000)!.id); // o fundo não cabe no retângulo
    expect(shapesInRect(doc, [0, 0, 1, 1], true)).toContain(shapes.find((s) => s.area > 40000)!.id);
  });

  it('semelhantes: mesma cor sólida', () => {
    const d2 = vectorize(ras(wrap('<rect x="20" y="20" width="60" height="60" fill="#d0342c"/><rect x="120" y="20" width="60" height="60" fill="#d0342c"/><rect x="20" y="150" width="60" height="60" fill="#2c5fd0"/>')), opts());
    const sh = listShapes(d2);
    const red = sh.filter((s) => s.color === '#d0342c' || s.color.startsWith('#d0'));
    expect(similarShapes(d2, red[0].id).sort()).toEqual(red.map((s) => s.id).sort());
  });
});

describe('formas: edições', () => {
  const doc = vectorize(ras(TWO), opts());
  const sh = listShapes(doc);
  const red = sh.find((s) => s.color.startsWith('#d0'))!, blue = sh.find((s) => s.color.startsWith('#2c'))!;

  it('sem edições devolve o mesmo documento', () => {
    expect(applyShapeEdits(doc, {})).toBe(doc);
  });

  it('excluir: a forma some; em Recortes o documento passa a ter borda aberta', () => {
    const e = editShapes(doc, {}, [red.id], { hidden: true });
    const d = applyShapeEdits(doc, e);
    expect(listShapes(d).some((s) => s.id === red.id)).toBe(false);
    expect(d.stats.shapes).toBe(doc.stats.shapes - 1);
    expect(d.openBoundary).toBe(true);
    expect(doc.layers.flatMap((l) => l.paths).length).toBeGreaterThan(d.layers.flatMap((l) => l.paths).length); // original intacto
    // desfazer = remover a edição
    expect(applyShapeEdits(doc, editShapes(doc, e, [red.id], null))).toBe(doc);
  });

  it('o SVG excluído deixa transparente (alfa 0) onde estava a forma', () => {
    const d = applyShapeEdits(doc, editShapes(doc, {}, [red.id], { hidden: true }));
    const r = renderSvg(toSVG(d, opts()), 256);
    const i = (128 * 256 + 70) * 4;
    expect(r.data[i + 3]).toBeLessThan(40);
  });

  it('recolorir: só aquela forma muda (nova camada), as outras ficam', () => {
    const d = applyShapeEdits(doc, editShapes(doc, {}, [red.id], { color: '#00ff00' }));
    expect(d.layers.some((l) => l.color === '#00ff00')).toBe(true);
    expect(d.layers.some((l) => l.color === red.color)).toBe(false);
    expect(d.layers.some((l) => l.color === blue.color)).toBe(true);
    const r = renderSvg(toSVG(d, opts()), 256);
    const i = (128 * 256 + 70) * 4;
    expect([r.data[i], r.data[i + 1], r.data[i + 2]]).toEqual([0, 255, 0]);
  });

  it('fundir: a forma adota a tinta da outra', () => {
    const d = applyShapeEdits(doc, editShapes(doc, {}, [red.id], { mergeInto: blue.id }));
    expect(d.layers.some((l) => l.color === red.color)).toBe(false);
    expect(d.layers.filter((l) => l.color === blue.color).flatMap((l) => l.paths).length).toBeGreaterThanOrEqual(3);
    // fundir = UMA forma (um id, um clique seleciona tudo), não só a mesma cor
    const ds = listShapes(d);
    expect(ds.length).toBe(sh.length - 1);
    const m = ds.find((s) => s.id === blue.id)!;
    expect(m.paths.length).toBe(blue.paths.length + red.paths.length);
    expect(shapesAt(d, 70, 128)).toContain(blue.id);
    expect(shapesAt(d, 70, 128)).not.toContain(red.id);
    expect(d.stats.shapes).toBe(doc.stats.shapes - 1);
  });

  it('empilhado: excluir revela o que está atrás (sem borda aberta)', () => {
    const o = opts({ stacking: 'stacked', gapFiller: false });
    const ds = vectorize(ras(TWO), o);
    const r = listShapes(ds).find((s) => s.color.startsWith('#d0'))!;
    const d = applyShapeEdits(ds, editShapes(ds, {}, [r.id], { hidden: true }));
    expect(d.openBoundary).toBe(ds.openBoundary);
    const img = renderSvg(toSVG(d, o), 256);
    const i = (128 * 256 + 70) * 4;
    // em empilhado cada camada se estende por baixo das da frente: aparece a camada de baixo, não o vermelho
    expect(img.data[i] < 120 && img.data[i + 3] === 255).toBe(true);
  });

  it('edições + paleta + exportadores funcionam juntos (SVG válido, PDF/EPS/DXF)', () => {
    const mid = applyShapeEdits(doc, editShapes(doc, {}, [red.id], { color: '#00aa00' }));
    const final = applyPaletteEdits(mid, { [blue.color]: { hidden: true } });
    const errors: string[] = [];
    new DOMParser({ onError: (lv, m) => { if (lv !== 'warning') errors.push(m); } }).parseFromString(toSVG(final, opts()), 'text/xml');
    expect(errors).toEqual([]);
    for (const f of ['pdf', 'eps', 'dxf'] as const) expect(() => exportDoc(f, final, opts(), { unit: 'px', dpi: 96 }, 256, 256)).not.toThrow();
  });

  it('mapa de formas: uma cor distinta por forma', () => {
    const m = shapeMapDoc(doc);
    expect(new Set(m.layers.map((l) => l.color)).size).toBe(m.layers.length);
    expect(m.layers.length).toBe(sh.length);
  });

  it('reprocessar com outras opções: as edições voltam às mesmas formas pelas âncoras', () => {
    const e = editShapes(doc, {}, [red.id, blue.id], { hidden: true });
    const doc2 = vectorize(ras(TWO), opts({ lineFitTolerance: 0.6, smooth: 3 }));
    const r = remapShapeEdits(doc2, e);
    expect(r.dropped).toBe(0);
    const d = applyShapeEdits(doc2, r.edits);
    expect(listShapes(d).length).toBe(listShapes(doc2).length - 2);
  });

  it('edição sem correspondência (área muito diferente) é descartada', () => {
    const e: ShapeEdits = { 1: { hidden: true, at: [5, 5], area: 12 } };
    const r = remapShapeEdits(doc, e);
    expect(r.dropped).toBe(1);
  });
});

describe('cor e gradiente por forma', () => {
  it('formas de mesma camada mas cores originais levemente diferentes ganham cor própria', () => {
    const img = ras(wrap('<rect x="20" y="20" width="90" height="90" fill="#c8643c"/><rect x="140" y="20" width="90" height="90" fill="#d26e46"/>'));
    const o = opts({ maxColors: 3, mergeDeltaE: 14 });
    const on = vectorize(img, o), off = vectorize(img, { ...o, shapeColors: false });
    const cols = new Set(on.layers.map((l) => l.color));
    expect(cols.has('#c8643c') && cols.has('#d26e46')).toBe(true);
    expect(off.layers.length).toBeLessThan(on.layers.length);
  });

  it('um degradê sutil dentro de uma só forma vira gradiente (e fica mais fiel)', () => {
    const svg = wrap('<defs><linearGradient id="g" x1="30" y1="0" x2="226" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#b98a52"/><stop offset="1" stop-color="#e9cf9c"/></linearGradient></defs><rect x="30" y="60" width="196" height="136" fill="url(#g)"/>');
    const img = ras(svg);
    const o = opts({ mergeDeltaE: 30 });
    const on = vectorize(img, o), off = vectorize(img, { ...o, shapeColors: false });
    expect(on.stats.gradients).toBeGreaterThanOrEqual(1);
    const ssim = (d: ReturnType<typeof vectorize>) => compare(img, renderSvg(toSVG(d, o), 256)).ssim;
    expect(ssim(on)).toBeGreaterThan(ssim(off));
  });

  it('imagens chapadas: shapeColors não altera o resultado', () => {
    for (const id of ['logo', 'icon', 'lineart', 'stripes']) {
      const c = CASES.find((x) => x.id === id)!;
      const img = rasterize(c.svg);
      const o = opts();
      const a = vectorize(img, o), b = vectorize(img, { ...o, shapeColors: false });
      expect(toSVG(a, o), id).toBe(toSVG(b, o));
    }
  });
});

describe('fragmentos de baixo contraste (contas, pontas) não viram formas', () => {
  it('pontinhos de tom parecido dentro de uma faixa são absorvidos; detalhe contrastante fica', () => {
    const dots = Array.from({ length: 24 }, (_, i) => `<rect x="${30 + i * 8}" y="${112 + (i % 3) * 8}" width="3" height="4" fill="#d9bf8f"/>`).join('');
    const band = `<rect x="20" y="100" width="216" height="56" fill="#c9a876"/>${dots}`;
    const hard = `<rect x="40" y="110" width="3" height="4" fill="#101010"/>`;
    const o = opts({ maxColors: 8, mergeDeltaE: 3, speckle: 10 });
    const soft = vectorize(ras(wrap(band)), o);
    expect(soft.stats.shapes).toBeLessThanOrEqual(2); // fundo + faixa
    const withHard = vectorize(ras(wrap(band + hard)), o);
    expect(withHard.stats.shapes).toBeGreaterThan(soft.stats.shapes); // o ponto escuro é detalhe real
  });
});
