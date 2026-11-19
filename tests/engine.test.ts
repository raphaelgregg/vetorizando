import { describe, expect, it } from 'vitest';
import { vectorize } from '../src/engine/vectorize';
import { flattenPath } from '../src/engine/geom';
import { toSVG } from '../src/engine/svg';
import { DEFAULT_OPTIONS, Options, RawImage } from '../src/engine/types';

function make(w: number, h: number, f: (x: number, y: number) => [number, number, number, number]): RawImage {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(f(x, y), (y * w + x) * 4);
  return { data, width: w, height: h };
}
const WHITE: [number, number, number, number] = [255, 255, 255, 255];
const RED: [number, number, number, number] = [220, 30, 30, 255];
const BLUE: [number, number, number, number] = [30, 60, 220, 255];
const opts = (p: Partial<Options> = {}): Options => ({ ...DEFAULT_OPTIONS, maxColors: 2, ...p });

function bbox(doc: ReturnType<typeof vectorize>, color: string) {
  const l = doc.layers.find((x) => x.color === color)!;
  let minx = 1e9, miny = 1e9, maxx = -1e9, maxy = -1e9;
  for (const p of l.paths) for (const q of flattenPath(p, 0.02)) {
    minx = Math.min(minx, q.x); miny = Math.min(miny, q.y); maxx = Math.max(maxx, q.x); maxy = Math.max(maxy, q.y);
  }
  return { minx, miny, maxx, maxy };
}

describe('vectorize', () => {
  it('círculo: poucos nós e bbox correto', () => {
    const img = make(100, 100, (x, y) => ((x - 50) ** 2 + (y - 50) ** 2 < 30 * 30 ? RED : WHITE));
    const doc = vectorize(img, opts());
    expect(doc.layers.length).toBe(2);
    const red = doc.layers.find((l) => l.color.startsWith('#dc'))!;
    const nodes = red.paths.reduce((a, p) => a + p.segs.length, 0);
    expect(nodes).toBeLessThanOrEqual(6);
    const b = bbox(doc, red.color);
    expect(Math.abs(b.minx - 20)).toBeLessThan(1.5);
    expect(Math.abs(b.maxx - 80)).toBeLessThan(1.5);
    expect(Math.abs(b.miny - 20)).toBeLessThan(1.5);
    expect(Math.abs(b.maxy - 80)).toBeLessThan(1.5);
  });

  it('quadrado: 4 retas (cantos preservados)', () => {
    const img = make(60, 60, (x, y) => (x >= 10 && x < 50 && y >= 10 && y < 50 ? BLUE : WHITE));
    const doc = vectorize(img, opts());
    const blue = doc.layers.find((l) => l.color.startsWith('#1e'))!;
    expect(blue.paths.length).toBe(1);
    expect(blue.paths[0].segs.length).toBe(4);
    expect(blue.paths[0].segs.every((s) => s.t === 'L')).toBe(true);
  });

  it('furo: gera 2 contornos para o anel', () => {
    const img = make(100, 100, (x, y) => {
      const d = Math.hypot(x - 50, y - 50);
      return d < 40 && d > 20 ? RED : WHITE;
    });
    const doc = vectorize(img, opts());
    const red = doc.layers.find((l) => l.color.startsWith('#dc'))!;
    expect(red.paths.length).toBe(2);
  });

  it('removeBackground descarta a cor de fundo', () => {
    const img = make(60, 60, (x, y) => (x >= 20 && x < 40 && y >= 20 && y < 40 ? RED : WHITE));
    const doc = vectorize(img, opts({ removeBackground: true }));
    expect(doc.layers.length).toBe(1);
  });

  it('pixels transparentes não geram formas', () => {
    const img = make(40, 40, (x) => (x < 20 ? RED : [0, 0, 0, 0]));
    const doc = vectorize(img, opts());
    expect(doc.layers.length).toBe(1);
  });

  it('empilhado: primeira camada cobre toda a área opaca', () => {
    const img = make(60, 60, (x) => (x < 30 ? RED : BLUE));
    const doc = vectorize(img, opts({ stacking: 'stacked' }));
    expect(doc.layers.length).toBe(2);
    const b = bbox(doc, doc.layers[0].color);
    expect(b.maxx - b.minx).toBeGreaterThanOrEqual(59);
  });

  it('imagem de uma cor só e imagem vazia não quebram', () => {
    expect(vectorize(make(20, 20, () => RED), opts()).layers.length).toBe(1);
    expect(vectorize(make(20, 20, () => [0, 0, 0, 0]), opts()).layers.length).toBe(0);
  });

  it('SVG é bem formado e tem viewBox', () => {
    const img = make(60, 60, (x, y) => (Math.hypot(x - 30, y - 30) < 15 ? RED : WHITE));
    const svg = toSVG(vectorize(img, opts()), opts());
    expect(svg.startsWith('<svg')).toBe(true);
    expect(svg).toContain('viewBox="0 0 60 60"');
    expect(svg.trim().endsWith('</svg>')).toBe(true);
    expect((svg.match(/<path/g) ?? []).length).toBe(4); // 2 camadas × (traço de fenda + preenchimento)
    expect((svg.match(/<path fill=/g) ?? []).length).toBe(2);
    expect(svg).not.toContain('NaN');
  });

  it('é determinístico', () => {
    const img = make(80, 80, (x, y) => (Math.hypot(x - 40, y - 40) < 25 ? RED : x > 40 ? BLUE : WHITE));
    const a = toSVG(vectorize(img, opts({ maxColors: 3 })), opts({ maxColors: 3 }));
    const b = toSVG(vectorize(img, opts({ maxColors: 3 })), opts({ maxColors: 3 }));
    expect(a).toBe(b);
  });
});
