import { describe, expect, it } from 'vitest';
import { FILTERS, applyFilter, hueShift, replaceColors, rgbToHsl, tint } from '../src/enhance/colors';
import { NEUTRAL, NO_EDIT, enhance, finalize } from '../src/enhance/ops';
import { Overlay, SHAPE_KINDS, drawOverlays, hitOverlay, makeOverlay, outline } from '../src/enhance/overlay';
import { applyRemoval, applyRemovals, backgroundRemoval, selectionMask, wandMask } from '../src/enhance/wand';
import type { RawImage } from '../src/engine/types';

const make = (w: number, h: number, f: (x: number, y: number) => number[]): RawImage => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = f(x, y); data.set([c[0], c[1], c[2], c[3] ?? 255], (y * w + x) * 4); }
  return { data, width: w, height: h };
};
const px = (im: RawImage, x: number, y: number) => [...im.data.slice((y * im.width + x) * 4, (y * im.width + x) * 4 + 4)];
const sum = (m: ArrayLike<number>) => { let s = 0; for (let i = 0; i < m.length; i++) s += m[i]; return s; };
const alphaSum = (im: RawImage) => { let s = 0; for (let i = 3; i < im.data.length; i += 4) s += im.data[i] / 255; return s; };
const click = (x: number, y: number, tol = 20, contiguous = true, mode: 'add' | 'sub' = 'add') => ({ x, y, tol, contiguous, mode });

describe('varinha mágica', () => {
  const RED = [200, 30, 30], BLUE = [30, 30, 200];
  const two = make(100, 50, (x) => (x < 50 ? RED : BLUE));

  it('seleciona a região parecida com o clique e nada do outro lado', () => {
    const m = wandMask(two, click(0.1, 0.5));
    expect(m[25 * 100 + 10]).toBe(1); expect(m[25 * 100 + 90]).toBe(0);
    expect(sum(m)).toBe(50 * 50);
  });
  it('tolerância: maior tolerância seleciona mais (monotônico)', () => {
    const grad = make(256, 4, (x) => [x, x, x]);
    const a = sum(wandMask(grad, click(0.5, 0.5, 5))), b = sum(wandMask(grad, click(0.5, 0.5, 20))), c = sum(wandMask(grad, click(0.5, 0.5, 60)));
    expect(a).toBeLessThan(b); expect(b).toBeLessThan(c);
    expect(sum(wandMask(grad, click(0.5, 0.5, 0)))).toBeLessThan(10 * 4); // quase só a cor exata
  });
  it('contígua × global: duas áreas iguais separadas por outra cor', () => {
    const img = make(90, 30, (x) => (x < 30 || x >= 60 ? RED : BLUE));
    expect(sum(wandMask(img, click(0.1, 0.5, 20, true)))).toBe(30 * 30);
    expect(sum(wandMask(img, click(0.1, 0.5, 20, false)))).toBe(60 * 30);
  });
  it('borda suave: cor intermediária tem cobertura fracionária', () => {
    const img = make(100, 10, (x) => { const v = 100 + x; return [v, v, v]; });
    const m = wandMask(img, click(0, 0.5, 20, false));
    const frac = [...m].filter((v) => v > 0 && v < 1).length;
    expect(frac).toBeGreaterThan(0);
  });
  it('subtrair, inverter e clique em área transparente', () => {
    const sel = selectionMask(two, [click(0.1, 0.5, 20, false), click(0.1, 0.1, 5, true, 'sub')]);
    expect(sum(sel)).toBeLessThan(50 * 50); // a subtração fez um buraco (a região contígua inteira some: sem sobrar nada)
    const inv = selectionMask(two, [click(0.1, 0.5)], true);
    expect(inv[25 * 100 + 10]).toBe(0); expect(inv[25 * 100 + 90]).toBe(1);
    const hole = make(20, 20, () => [10, 10, 10, 0]);
    expect(sum(wandMask(hole, click(0.5, 0.5)))).toBe(0);
  });
  it('remover: alfa 0 na seleção, 255 fora; suavização cria transição', () => {
    const r = applyRemoval(two, { clicks: [click(0.1, 0.5)], invert: false, feather: 0 });
    expect(px(r, 10, 25)[3]).toBe(0); expect(px(r, 90, 25)[3]).toBe(255);
    const f = applyRemoval(two, { clicks: [click(0.1, 0.5)], invert: false, feather: 20 });
    const mid = px(f, 49, 25)[3];
    expect(mid).toBeGreaterThan(0); expect(mid).toBeLessThan(255);
    expect(applyRemovals(two, [])).toBe(two);
  });
  it('remover fundo: o contíguo aos cantos some e uma "ilha" de mesma cor cercada fica', () => {
    // fundo branco, anel preto, miolo branco dentro do anel
    const img = make(80, 80, (x, y) => { const d = Math.hypot(x - 40, y - 40); return d > 30 ? [255, 255, 255] : d > 18 ? [0, 0, 0] : [255, 255, 255]; });
    const r = applyRemoval(img, backgroundRemoval(15, 0));
    expect(px(r, 2, 2)[3]).toBe(0);
    expect(px(r, 40, 40)[3]).toBe(255); // miolo branco preservado
    expect(px(r, 40, 15)[3]).toBe(255); // anel preto preservado
  });
  it('as frações valem em qualquer resolução (mesma proporção removida a 2×)', () => {
    const big = make(200, 100, (x) => (x < 100 ? RED : BLUE));
    const a = alphaSum(applyRemoval(two, { clicks: [click(0.1, 0.5)], invert: false, feather: 0 })) / (100 * 50);
    const b = alphaSum(applyRemoval(big, { clicks: [click(0.1, 0.5)], invert: false, feather: 0 })) / (200 * 100);
    expect(Math.abs(a - b)).toBeLessThan(0.01);
  });
});

describe('cores', () => {
  it('matiz: vermelho a +120° vira verde; cinza não muda; 0 devolve o mesmo objeto', () => {
    const img = make(4, 4, (x) => (x < 2 ? [255, 0, 0] : [128, 128, 128]));
    const r = hueShift(img, 120);
    expect(px(r, 0, 0).slice(0, 3)).toEqual([0, 255, 0]);
    expect(px(r, 3, 0).slice(0, 3)).toEqual([128, 128, 128]);
    expect(hueShift(img, 0)).toBe(img);
  });
  it('filtros: P&B, negativo, sépia; "nenhum" não altera; lista coerente', () => {
    const img = make(2, 2, () => [200, 100, 50]);
    const bw = px(applyFilter(img, 'bw'), 0, 0); expect(bw[0]).toBe(bw[1]); expect(bw[1]).toBe(bw[2]);
    expect(px(applyFilter(img, 'invert'), 0, 0).slice(0, 3)).toEqual([55, 155, 205]);
    const sp = px(applyFilter(img, 'sepia'), 0, 0); expect(sp[0]).toBeGreaterThan(sp[2]);
    expect(applyFilter(img, 'none')).toBe(img);
    const half = px(applyFilter(img, 'invert', 50), 0, 0); expect(half[0]).toBeGreaterThan(100); expect(half[0]).toBeLessThan(160);
    expect(new Set(FILTERS.map((f) => f.id)).size).toBe(FILTERS.length);
  });
  it('colorir mantém a luminosidade e muda o matiz', () => {
    const img = make(2, 1, (x) => (x ? [200, 200, 200] : [60, 60, 60]));
    const t = tint(img, '#0000ff', 100);
    expect(px(t, 0, 0)[2]).toBeGreaterThan(px(t, 0, 0)[0]);
    expect(px(t, 1, 0)[0] + px(t, 1, 0)[1] + px(t, 1, 0)[2]).toBeGreaterThan(px(t, 0, 0)[0] + px(t, 0, 0)[1] + px(t, 0, 0)[2]); // o mais claro continua mais claro
    expect(tint(img, null, 50)).toBe(img); expect(tint(img, '#ff0000', 0)).toBe(img);
  });
  it('substituir cor: só os pixels parecidos mudam, com o relevo de luminosidade', () => {
    const img = make(40, 10, (x) => (x < 20 ? [200 + (x % 3) * 10, 30, 30] : [30, 160, 30]));
    const r = replaceColors(img, [{ from: '#c81e1e', to: '#1e1ec8', tol: 25 }]);
    const [h0] = rgbToHsl(...(px(r, 3, 5).slice(0, 3) as [number, number, number]));
    expect(h0).toBeGreaterThan(200); expect(h0).toBeLessThan(260); // azul
    expect(px(r, 30, 5).slice(0, 3)).toEqual([30, 160, 30]); // verde intacto
    expect(replaceColors(img, [])).toBe(img);
  });
});

describe('formas inseridas', () => {
  const W = 200, H = 100, blank = () => make(W, H, () => [0, 0, 0, 0]);
  const shape = (kind: Overlay['kind'], patch: Partial<Overlay> = {}): Overlay => ({ ...makeOverlay(kind, '#ff0000'), ...patch });

  it('retângulo: cobertura exata (área), borda com antialiasing e exterior vazio', () => {
    const r = drawOverlays(blank(), [shape('rect', { x: 0.25, y: 0.2, w: 0.5, h: 0.5 })]);
    expect(Math.abs(alphaSum(r) - 100 * 50)).toBeLessThan(2);
    expect(px(r, 100, 45)).toEqual([255, 0, 0, 255]);
    expect(px(r, 10, 10)[3]).toBe(0);
    const off = drawOverlays(blank(), [shape('rect', { x: 0.2501, y: 0.2, w: 0.5, h: 0.5 })]); // borda no meio do pixel
    expect(px(off, 50, 45)[3]).toBeGreaterThan(0); expect(px(off, 50, 45)[3]).toBeLessThan(255);
  });
  it('elipse: área ≈ π·rx·ry; arredondado tem cantos vazios; polígono, estrela, coração e cruz desenham', () => {
    const e = drawOverlays(blank(), [shape('ellipse', { x: 0.25, y: 0.1, w: 0.5, h: 0.8 })]);
    expect(Math.abs(alphaSum(e) - Math.PI * 50 * 40) / (Math.PI * 50 * 40)).toBeLessThan(0.02);
    const rr = drawOverlays(blank(), [shape('rounded', { x: 0.1, y: 0.1, w: 0.8, h: 0.8, radius: 0.5 })]);
    expect(px(rr, 20, 10)[3]).toBe(0); expect(px(rr, 100, 50)[3]).toBe(255);
    for (const k of ['triangle', 'polygon', 'star', 'heart', 'cross'] as const) {
      const r = drawOverlays(blank(), [shape(k, { x: 0.2, y: 0.1, w: 0.6, h: 0.8 })]);
      expect(alphaSum(r), k).toBeGreaterThan(300);
      expect(px(r, 2, 2)[3], k).toBe(0);
    }
    const star = outline(shape('star', { sides: 6 }), W, H)!; expect(star.length).toBe(12);
    expect(outline(shape('polygon', { sides: 8 }), W, H)!.length).toBe(8);
  });
  it('contorno sem preenchimento: anel com o miolo vazio; largura do traço respeitada', () => {
    const r = drawOverlays(blank(), [shape('rect', { x: 0.2, y: 0.2, w: 0.6, h: 0.6, fill: null, stroke: '#00ff00', strokeW: 10 })]);
    expect(px(r, 100, 50)[3]).toBe(0);
    expect(px(r, 40, 50)[3]).toBe(255); // sobre a borda esquerda (x = 40)
    expect(px(r, 40 - 4, 50)[3]).toBeGreaterThan(200); expect(px(r, 40 - 7, 50)[3]).toBe(0); // meia largura = 5 px
  });
  it('linha e seta: espessura e ponta mais larga que a haste', () => {
    const l = drawOverlays(blank(), [shape('line', { x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5, stroke: '#0000ff', strokeW: 6 })]);
    expect(px(l, 100, 50)[3]).toBe(255); expect(px(l, 100, 50 - 5)[3]).toBe(0);
    const a = drawOverlays(blank(), [shape('arrow', { x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5, stroke: '#0000ff', strokeW: 4 })]);
    const col = (x: number) => { let n = 0; for (let y = 0; y < H; y++) n += a.data[(y * W + x) * 4 + 3] > 128 ? 1 : 0; return n; };
    expect(col(170)).toBeGreaterThan(col(60) + 4); // perto da ponta é mais largo que a haste
  });
  it('opacidade, visibilidade, rotação e ordem (a de cima vence)', () => {
    const half = drawOverlays(blank(), [shape('rect', { opacity: 0.5, x: 0, y: 0, w: 1, h: 1 })]);
    expect(Math.abs(px(half, 5, 5)[3] - 128)).toBeLessThanOrEqual(1);
    expect(drawOverlays(blank(), [shape('rect', { visible: false })])).toEqual(blank());
    const flat = blank(); expect(drawOverlays(flat, [])).toBe(flat);
    const rot = drawOverlays(blank(), [shape('rect', { x: 0.3, y: 0.4, w: 0.4, h: 0.1, rot: 90 })]); // horizontal 80×10 → vertical 10×80 (em px: caixa 80×10)
    expect(px(rot, 100, 20)[3]).toBe(255); expect(px(rot, 70, 45)[3]).toBe(0);
    const two = drawOverlays(blank(), [shape('rect', { fill: '#ff0000' }), shape('rect', { fill: '#0000ff' })]);
    expect(px(two, 100, 50).slice(0, 3)).toEqual([0, 0, 255]);
  });
  it('seleção por ponto (a mais à frente) e padrões das formas', () => {
    const list = [shape('rect', { id: 1, x: 0, y: 0, w: 1, h: 1 }), shape('ellipse', { id: 2, x: 0.3, y: 0.2, w: 0.4, h: 0.6 })];
    expect(hitOverlay(list, 0.5, 0.5, W, H)!.id).toBe(2);
    expect(hitOverlay(list, 0.05, 0.05, W, H)!.id).toBe(1);
    expect(hitOverlay([{ ...list[1], visible: false }], 0.5, 0.5, W, H)).toBeNull();
    expect(new Set(SHAPE_KINDS.map((s) => s.id)).size).toBe(SHAPE_KINDS.length);
    const ln = makeOverlay('line', '#123456'); expect(ln.fill).toBeNull(); expect(ln.stroke).toBe('#123456');
    expect(hitOverlay([shape('line', { id: 3, x1: 0.1, y1: 0.5, x2: 0.9, y2: 0.5, strokeW: 3 })], 0.5, 0.5, W, H)!.id).toBe(3);
  });
});

describe('pipeline com varinha, formas e camadas', () => {
  const img = make(60, 40, (x) => (x < 30 ? [200, 30, 30] : [30, 30, 200]));
  it('remoções + formas + opacidade da imagem; sem edições o objeto é o mesmo', () => {
    expect(enhance(img, NEUTRAL, undefined, undefined, NO_EDIT)).toBe(img);
    const edit = { ...NO_EDIT, removals: [{ clicks: [{ x: 0.1, y: 0.5, tol: 20, contiguous: true, mode: 'add' as const }], invert: false, feather: 0 }], overlays: [makeOverlay('ellipse', '#00ff00')] };
    const out = enhance(img, NEUTRAL, { width: 60, height: 40, fit: 'cover', fx: 0.5, fy: 0.5, background: null, circle: false }, undefined, edit);
    expect(px(out, 3, 3)[3]).toBe(0); // removido
    expect(px(out, 55, 35)[3]).toBe(255); // mantido
    expect(px(out, 30, 20).slice(0, 3)).toEqual([0, 255, 0]); // forma por cima
    const faded = finalize(img, { ...NO_EDIT, baseOpacity: 0.5 });
    expect(Math.abs(px(faded, 3, 3)[3] - 128)).toBeLessThanOrEqual(1);
    expect(px(finalize(img, { ...NO_EDIT, baseVisible: false }), 3, 3)[3]).toBe(0);
  });
  it('a forma do recorte vale para tudo (inclusive as formas inseridas)', () => {
    const edit = { ...NO_EDIT, overlays: [{ ...makeOverlay('rect', '#ff00ff'), x: 0, y: 0, w: 1, h: 1 }] };
    const out = enhance(img, NEUTRAL, { width: 60, height: 40, fit: 'cover', fx: 0.5, fy: 0.5, background: null, circle: true }, undefined, edit);
    expect(px(out, 0, 0)[3]).toBe(0); expect(px(out, 30, 20).slice(0, 3)).toEqual([255, 0, 255]);
  });
});
