import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { CASES, rasterize } from '../bench/cases';
import { renderSvg } from '../bench/io';
import { compare } from '../bench/metrics';
import { applyPaletteEdits } from '../src/engine/palette';
import { PRESETS } from '../src/engine/presets';
import { ShapeEdits, applyShapeEdits, copyPaint, mergeShapes, editShapes, listShapes, remapShapeEdits, shapeMapDoc, shapesAt, shapesInRect, similarShapes } from '../src/engine/shapes';
import { toSVG } from '../src/engine/svg';
import { Options, VPath } from '../src/engine/types';
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

import { addStop, colorAt, convertKind, defaultGradient, handles, moveHandle, removeStop, retarget, reverse, setStop } from '../src/engine/gradedit';
import { fromNodes, insertNode, moveHandle as moveH, moveNode, nearestOnPath, removeNode, toNodes, toggleEdge } from '../src/engine/nodeedit';
import { flattenPath } from '../src/engine/geom';

describe('edição manual de pontos', () => {
  const sq: VPath = { start: { x: 0, y: 0 }, segs: [{ t: 'L' as const, p: { x: 10, y: 0 } }, { t: 'L' as const, p: { x: 10, y: 10 } }, { t: 'L' as const, p: { x: 0, y: 10 } }, { t: 'L' as const, p: { x: 0, y: 0 } }] };
  const area = (p: VPath) => { const f = flattenPath(p, 0.01); let s = 0; for (let i = 0; i < f.length; i++) { const q = f[(i + 1) % f.length]; s += f[i].x * q.y - q.x * f[i].y; } return Math.abs(s) / 2; };

  it('ida e volta: nós ↔ caminho preserva a geometria (sem duplicar o nó de fechamento)', () => {
    const n = toNodes(sq);
    expect(n.length).toBe(4);
    expect(area(fromNodes(n))).toBeCloseTo(100, 6);
  });
  it('mover nó muda a forma; mover nó leva as alças junto', () => {
    const n = moveNode(toNodes(sq), 2, { x: 20, y: 10 });
    expect(area(fromNodes(n))).toBeCloseTo(150, 6);
    const c = toggleEdge(toNodes(sq), 0); // aresta 0→1 vira curva
    const m = moveNode(c, 0, { x: 5, y: 5 });
    expect(m[0].hOut!.x - m[0].p.x).toBeCloseTo(c[0].hOut!.x - c[0].p.x, 9);
  });
  it('inserir nó não altera o contorno; reta e curva (de Casteljau)', () => {
    const n = toNodes(sq), ins = insertNode(n, 0, 0.5);
    expect(ins.length).toBe(5);
    expect(area(fromNodes(ins))).toBeCloseTo(100, 6);
    const curved = toggleEdge(n, 0), insC = insertNode(curved, 0, 0.4);
    const f1 = flattenPath(fromNodes(curved), 0.01), f2 = flattenPath(fromNodes(insC), 0.01);
    const a = (f: typeof f1) => { let s = 0; for (let i = 0; i < f.length; i++) { const q = f[(i + 1) % f.length]; s += f[i].x * q.y - q.x * f[i].y; } return Math.abs(s) / 2; };
    expect(a(f2)).toBeCloseTo(a(f1), 2);
  });
  it('remover nó (mínimo 3) e achar a aresta mais próxima', () => {
    expect(removeNode(toNodes(sq), 1).length).toBe(3);
    expect(removeNode(removeNode(toNodes(sq), 1), 1).length).toBe(3);
    expect(nearestOnPath(toNodes(sq), { x: 5, y: -1 }).edge).toBe(0);
    expect(nearestOnPath(toNodes(sq), { x: 11, y: 5 }).edge).toBe(1);
  });
  it('alça: mover a alça de saída curva a aresta', () => {
    const n = moveH(toggleEdge(toNodes(sq), 0), 0, 'out', { x: 3, y: -8 });
    expect(area(fromNodes(n))).toBeGreaterThan(100);
  });

  const circ = wrap('<circle cx="128" cy="128" r="60" fill="#d0342c"/>');
  const doc = vectorize(ras(circ), opts());
  const sh = listShapes(doc).find((s) => s.color.startsWith('#d0'))!;

  it('geometria editada substitui os contornos da forma (e some ao reprocessar, com aviso)', () => {
    const nodes = toNodes(sh.paths[0]);
    const moved = fromNodes(moveNode(nodes, 0, { x: nodes[0].p.x - 30, y: nodes[0].p.y }), sh.paths[0]);
    const e = editShapes(doc, {}, [sh.id], { geom: [moved] });
    const d = applyShapeEdits(doc, e);
    const s2 = listShapes(d).find((s) => s.id === sh.id)!;
    expect(s2.paths.length).toBe(1);
    expect(s2.area).not.toBeCloseTo(sh.area, 0);
    expect(s2.paths[0].sid).toBe(sh.id);
    const r = remapShapeEdits(vectorize(ras(circ), opts({ smooth: 3 })), e);
    expect(r.dropped).toBe(1);
    expect(Object.keys(r.edits).length).toBe(0);
  });

  it('excluir um contorno (furo) preenche o buraco', () => {
    const holed = vectorize(ras(wrap('<path fill-rule="evenodd" fill="#2c5fd0" d="M40 40H216V216H40Z M100 100H156V156H100Z"/>')), opts());
    const sb = listShapes(holed).find((s) => s.color.startsWith('#2c'))!;
    expect(sb.paths.length).toBe(2);
    const outer = sb.paths.reduce((a, b) => (Math.abs(flattenPath(b, 1).length) > 0 && b.segs.length >= 0 ? a : b));
    const d = applyShapeEdits(holed, editShapes(holed, {}, [sb.id], { geom: [sb.paths[0]] }));
    expect(listShapes(d).find((s) => s.id === sb.id)!.paths.length).toBe(1);
    void outer;
  });
});

describe('edição manual de gradientes', () => {
  const g = defaultGradient([0, 0, 100, 50], '#c8a064');
  it('gradiente inicial, paradas, inverter e conversão linear↔radial', () => {
    expect(g.stops.length).toBe(2);
    const g3 = addStop(g);
    expect(g3.stops.length).toBe(3);
    expect(g3.stops[1].offset).toBeCloseTo(0.5, 3);
    expect(removeStop(g3, 1).stops.length).toBe(2);
    expect(removeStop(g, 0).stops.length).toBe(2); // mínimo 2
    expect(setStop(g, 1, { color: '#000000', offset: 2 }).stops[1].offset).toBe(1); // limitado a 0–1
    expect(reverse(g).stops[0].color).toBe(g.stops[1].color);
    const r = convertKind(g, 'radial', [0, 0, 100, 50]);
    expect(r.kind).toBe('radial');
    expect(convertKind(r, 'linear', [0, 0, 100, 50]).kind).toBe('linear');
    expect(colorAt(g.stops, 0)).toBe('#c8a064');
  });
  it('alças arrastáveis', () => {
    expect(handles(g)).toEqual([[0, 25], [100, 25]]);
    const m = moveHandle(g, 1, 80, 40);
    expect(m.kind === 'linear' && [m.x2, m.y2]).toEqual([80, 40]);
    const r = convertKind(g, 'radial', [0, 0, 100, 50]);
    const m2 = moveHandle(r, 1, r.kind === 'radial' ? r.cx + 10 : 0, r.kind === 'radial' ? r.cy : 0);
    expect(m2.kind === 'radial' && m2.r).toBeCloseTo(10, 6);
  });
  it('gradiente à mão substitui a cor/gradiente da forma no SVG e nos exportadores usa a cor média', () => {
    const doc = vectorize(ras(wrap('<rect x="40" y="40" width="176" height="176" fill="#c8a064"/>')), opts());
    const s = listShapes(doc).find((x) => x.color.startsWith('#c8'))!;
    const d = applyShapeEdits(doc, editShapes(doc, {}, [s.id], { gradient: defaultGradient(s.bbox, s.color) }));
    const svg = toSVG(d, opts());
    expect(svg).toMatch(/<linearGradient/);
    expect(svg).toMatch(/fill="url\(#g0\)"/);
    expect(exportDoc('pdf', d, opts(), { unit: 'px', dpi: 96 }, 256, 256).data).toBeTruthy();
    // voltar a cor sólida remove o gradiente
    const solid = applyShapeEdits(doc, editShapes(doc, editShapes(doc, {}, [s.id], { gradient: defaultGradient(s.bbox, s.color) }), [s.id], { color: '#112233' }));
    expect(toSVG(solid, opts())).not.toMatch(/Gradient/);
  });
});

describe('fundir = união geométrica', () => {
  const o = opts({ maxColors: 6, mergeDeltaE: 3 });
  const area = (paths: VPath[]) => { let t = 0; for (const p of paths) { const f = flattenPath(p, 0.05); let s = 0; for (let i = 0; i < f.length; i++) { const q = f[(i + 1) % f.length]; s += f[i].x * q.y - q.x * f[i].y; } t += s / 2; } return Math.abs(t); };
  const merged = (svg: string) => {
    const doc = vectorize(ras(svg), o);
    const sel = listShapes(doc).filter((s) => !s.color.startsWith('#ffffff'));
    const e = mergeShapes(doc, doc, {}, sel.map((s) => s.id));
    return { doc, sel, e, d: applyShapeEdits(doc, e) };
  };

  it('formas sobrepostas viram UM contorno com a área da união', () => {
    const { sel, d } = merged(wrap('<rect x="20" y="60" width="100" height="80" fill="#d0342c"/><rect x="90" y="60" width="100" height="80" fill="#c02a22"/>'));
    expect(sel.length).toBe(2);
    const m = listShapes(d).filter((s) => !s.color.startsWith('#ffffff'));
    expect(m.length).toBe(1);
    expect(m[0].paths.length).toBe(1); // um único contorno, não dois sobrepostos
    expect(area(m[0].paths)).toBeGreaterThan(170 * 80 * 0.97);
    expect(area(m[0].paths)).toBeLessThan(170 * 80 * 1.03);
  });

  it('formas coladas com uma fresta de 1 px também viram um contorno só (sem costura)', () => {
    const { d } = merged(wrap('<rect x="20" y="60" width="90" height="80" fill="#d0342c"/><rect x="111" y="60" width="90" height="80" fill="#c02a22"/>'));
    const m = listShapes(d).filter((s) => !s.color.startsWith('#ffffff'));
    expect(m.length).toBe(1);
    expect(m[0].paths.length).toBe(1);
  });

  it('um furo coberto pela outra forma desaparece; um furo que sobra é preservado', () => {
    const ring = '<path fill-rule="evenodd" fill="#2c5fd0" d="M40 40H216V216H40Z M90 90H166V166H90Z"/>';
    const { d } = merged(wrap(ring + '<rect x="80" y="80" width="96" height="96" fill="#d0342c"/>'));
    const m = listShapes(d).filter((s) => s.id >= 0 && !s.color.startsWith('#ffffff'));
    expect(m.length).toBe(1);
    expect(m[0].paths.length).toBe(1); // o furo foi preenchido
    const { d: d2 } = merged(wrap(ring + '<rect x="84" y="84" width="30" height="30" fill="#d0342c"/>'));
    const m2 = listShapes(d2).filter((s) => !s.color.startsWith('#ffffff'));
    expect(m2.length).toBe(1);
    expect(m2[0].paths.length).toBe(2); // sobra um furo
  });

  it('a fusão é uma edição: some as formas de origem, mantém a tinta da maior e desfaz', () => {
    const svg = wrap('<rect x="20" y="60" width="100" height="80" fill="#d0342c"/><rect x="90" y="60" width="100" height="80" fill="#2c5fd0"/>');
    const { doc, sel, e, d } = merged(svg);
    const big = sel.reduce((a, c) => (c.area > a.area ? c : a));
    expect(d.stats.shapes).toBe(doc.stats.shapes - 1);
    expect(listShapes(d).find((s) => s.id === big.id)!.color).toBe(big.color);
    expect(applyShapeEdits(doc, {})).toBe(doc);
    expect(Object.keys(e).length).toBe(2);
  });

  it('sobrevive a reprocessar: a união é recalculada nas formas novas', () => {
    const svg = wrap('<rect x="20" y="60" width="100" height="80" fill="#d0342c"/><rect x="90" y="60" width="100" height="80" fill="#c02a22"/>');
    const { e } = merged(svg);
    const doc2 = vectorize(ras(svg), { ...o, smooth: 3 });
    const r = remapShapeEdits(doc2, e);
    expect(r.dropped).toBe(0);
    const d2 = applyShapeEdits(doc2, r.edits);
    const m = listShapes(d2).filter((s) => !s.color.startsWith('#ffffff'));
    expect(m.length).toBe(1);
    expect(m[0].paths.length).toBe(1);
  });

  it('fundir de novo (A+B, depois +C) repassa as anteriores ao novo destino', () => {
    const doc = vectorize(ras(wrap('<rect x="10" y="60" width="60" height="80" fill="#d0342c"/><rect x="60" y="60" width="60" height="80" fill="#c02a22"/><rect x="110" y="60" width="60" height="80" fill="#b0221a"/>')), o);
    const sh = listShapes(doc).filter((s) => !s.color.startsWith('#ffffff'));
    expect(sh.length).toBeGreaterThanOrEqual(2);
    const e1 = mergeShapes(doc, doc, {}, [sh[0].id, sh[1].id]);
    const mid = applyShapeEdits(doc, e1);
    const ids = listShapes(mid).filter((s) => !s.color.startsWith('#ffffff')).map((s) => s.id);
    const e2 = mergeShapes(doc, mid, e1, ids);
    const fin = listShapes(applyShapeEdits(doc, e2)).filter((s) => !s.color.startsWith('#ffffff'));
    expect(fin.length).toBe(1);
    expect(fin[0].paths.length).toBe(1);
  });
});

describe('objetos no SVG e cópia de cor', () => {
  const o = opts({ maxColors: 6, mergeDeltaE: 3 });
  const svg = wrap('<rect x="10" y="60" width="50" height="80" fill="#d0342c"/><rect x="100" y="60" width="50" height="80" fill="#d0342c"/><rect x="190" y="60" width="50" height="80" fill="#2c5fd0"/>');
  const doc = vectorize(ras(svg), o);

  it('cada forma é um <path id="forma-N"> próprio; "camadas por cor" mantém um por camada', () => {
    const shapes = listShapes(doc);
    const objs = toSVG(doc, o);
    for (const s of shapes) expect(objs).toContain(`id="forma-${s.id}"`);
    expect((objs.match(/<path id="forma-/g) ?? []).length).toBe(shapes.length);
    const compact = toSVG(doc, o, {}, { mode: 'hex', objects: false });
    expect(compact).not.toContain('id="forma-');
    expect((compact.match(/<path/g) ?? []).length).toBeLessThan((objs.match(/<path/g) ?? []).length);
    // mesma imagem
    const a = renderSvg(objs, 256), b = renderSvg(compact, 256);
    expect(compare(a, b).ssim).toBeGreaterThan(0.9999);
  });

  it('forma fundida = um objeto (um <path> com todos os contornos)', () => {
    const reds = listShapes(doc).filter((s) => s.color.startsWith('#d0'));
    expect(reds.length).toBe(2);
    const e = mergeShapes(doc, doc, {}, reds.map((s) => s.id));
    const d = applyShapeEdits(doc, e);
    const out = toSVG(d, o);
    const main = reds.reduce((a, c) => (c.area > a.area ? c : a));
    expect(out.match(new RegExp(`id="forma-${main.id}"`, 'g'))!.length).toBe(1);
    expect(out.match(/<path id="forma-/g)!.length).toBe(listShapes(doc).length - 1);
  });

  it('copiar cor: as selecionadas adotam a cor da forma de origem (só elas)', () => {
    const sh = listShapes(doc);
    const blue = sh.find((s) => s.color.startsWith('#2c'))!, reds = sh.filter((s) => s.color.startsWith('#d0'));
    const e = copyPaint(doc, doc, {}, blue.id, reds.map((s) => s.id));
    const d = applyShapeEdits(doc, e);
    const cols = listShapes(d).filter((s) => !s.color.startsWith('#ffffff')).map((s) => s.color);
    expect(cols.length).toBe(3);
    expect(new Set(cols).size).toBe(1);
    expect(cols[0]).toBe(blue.color);
    // a origem não vira destino de si mesma
    expect(copyPaint(doc, doc, {}, blue.id, [blue.id])).toEqual({});
  });

  it('copiar um gradiente reescala a geometria para a caixa de cada destino', () => {
    const g = defaultGradient([0, 0, 100, 50], '#c8a064');
    const r = retarget(g, [0, 0, 100, 50], [200, 100, 400, 300]);
    expect(r.kind === 'linear' && [r.x1, r.y1, r.x2, r.y2]).toEqual([200, 200, 400, 200]);
    const rad = retarget(convertKind(g, 'radial', [0, 0, 100, 50]), [0, 0, 100, 50], [0, 0, 200, 100]);
    expect(rad.kind === 'radial' && rad.cx).toBeCloseTo(100, 6);
    const grad = applyShapeEdits(doc, editShapes(doc, {}, [listShapes(doc)[1].id], { gradient: g }));
    const src = listShapes(grad).find((s) => s.gradient)!;
    const tgt = listShapes(grad).find((s) => s.id !== src.id && s.color.startsWith('#2c'))!;
    const e2 = copyPaint(doc, grad, {}, src.id, [tgt.id]);
    const final = applyShapeEdits(doc, e2);
    expect(listShapes(final).find((s) => s.id === tgt.id)!.gradient?.kind).toBe('linear');
  });
});
