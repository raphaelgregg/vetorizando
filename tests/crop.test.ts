import { describe, expect, it } from 'vitest';
import { ASPECTS, IDENTITY, applyTransform, autoTrimRect, cropFrac, expandedSize, flip, inscribedRect, prepare, ratioRect, rotate90, rotateAngle } from '../src/enhance/crop';
import { NEUTRAL, applyShape, enhance } from '../src/enhance/ops';
import type { RawImage } from '../src/engine/types';

const make = (w: number, h: number, f: (x: number, y: number) => number[]): RawImage => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = f(x, y); data.set([c[0], c[1], c[2], c[3] ?? 255], (y * w + x) * 4); }
  return { data, width: w, height: h };
};
const px = (im: RawImage, x: number, y: number) => [...im.data.slice((y * im.width + x) * 4, (y * im.width + x) * 4 + 4)];
// pixel identificável: R = x, G = y
const grid = (w: number, h: number) => make(w, h, (x, y) => [x * 10, y * 10, 0]);

describe('girar e espelhar', () => {
  it('90° horário: (x, y) vai para (h−1−y, x); 4 giros = identidade; 180° inverte os dois eixos', () => {
    const g = grid(3, 2), r = rotate90(g, 1);
    expect([r.width, r.height]).toEqual([2, 3]);
    for (let y = 0; y < 2; y++) for (let x = 0; x < 3; x++) expect(px(r, 2 - 1 - y, x)).toEqual(px(g, x, y));
    expect([...rotate90(rotate90(rotate90(rotate90(g, 1), 1), 1), 1).data]).toEqual([...g.data]);
    const r2 = rotate90(g, 2);
    expect(px(r2, 0, 0)).toEqual(px(g, 2, 1));
    expect(rotate90(g, 0)).toBe(g);
    const r3 = rotate90(g, 3);
    expect([r3.width, r3.height]).toEqual([2, 3]);
    expect(px(r3, 0, 2)).toEqual(px(g, 0, 0)); // anti-horário: canto superior esquerdo vai para o inferior esquerdo
  });
  it('espelhos horizontal e vertical', () => {
    const g = grid(3, 2);
    expect(px(flip(g, true, false), 0, 0)).toEqual(px(g, 2, 0));
    expect(px(flip(g, false, true), 0, 0)).toEqual(px(g, 0, 1));
    expect(flip(g, false, false)).toBe(g);
    expect([...flip(flip(g, true, true), true, true).data]).toEqual([...g.data]);
  });
});

describe('endireitar (ângulo qualquer)', () => {
  it('tela expandida: 0° mantém, 90° troca, 45° cresce', () => {
    expect(expandedSize(100, 50, 0)).toEqual([100, 50]);
    expect(expandedSize(100, 50, 90)).toEqual([50, 100]);
    const [w, h] = expandedSize(100, 50, 45);
    expect(w).toBe(Math.ceil(150 / Math.SQRT2)); expect(h).toBe(w);
  });
  it('0° devolve a mesma imagem; 90° coincide com o giro exato; cantos novos ficam transparentes', () => {
    const g = grid(40, 20);
    expect(rotateAngle(g, 0)).toBe(g);
    const a = rotateAngle(g, 90), b = rotate90(g, 1);
    expect([a.width, a.height]).toEqual([b.width, b.height]);
    for (const [x, y] of [[3, 3], [10, 30], [15, 10]]) expect(px(a, x, y).slice(0, 3)).toEqual(px(b, x, y).slice(0, 3));
    const r = rotateAngle(make(60, 40, () => [200, 50, 50]), 30);
    expect(px(r, 0, 0)[3]).toBe(0); // canto vazio
    expect(px(r, r.width >> 1, r.height >> 1)).toEqual([200, 50, 50, 255]);
  });
  it('o maior retângulo inscrito não tem nenhum pixel transparente (e some quando o ângulo é 0)', () => {
    expect(inscribedRect(100, 50, 0)).toEqual({ x: 0, y: 0, w: 1, h: 1 });
    for (const deg of [5, 12.5, 30, -20, 45, 80]) {
      const img = make(120, 60, () => [10, 200, 10]);
      const rot = rotateAngle(img, deg), r = inscribedRect(120, 60, deg);
      const c = cropFrac(rot, { x: r.x + 0.01, y: r.y + 0.01, w: r.w - 0.02, h: r.h - 0.02 }); // 1 % de folga (borda suavizada)
      let minA = 255;
      for (let i = 3; i < c.data.length; i += 4) minA = Math.min(minA, c.data[i]);
      expect(minA, `${deg}°`).toBe(255);
    }
    // e é o MAIOR: a área cresce se não houvesse rotação e encolhe com o ângulo
    const a = (d: number) => { const r = inscribedRect(120, 60, d), [W, H] = expandedSize(120, 60, d); return r.w * W * r.h * H; };
    expect(a(5)).toBeLessThan(a(0.5)); expect(a(20)).toBeLessThan(a(5));
  });
});

describe('recorte', () => {
  it('por fração: tamanho e conteúdo; limites respeitados', () => {
    const g = grid(40, 20), c = cropFrac(g, { x: 0.25, y: 0.5, w: 0.5, h: 0.5 });
    expect([c.width, c.height]).toEqual([20, 10]);
    expect(px(c, 0, 0)).toEqual(px(g, 10, 10));
    expect(cropFrac(g, { x: 0, y: 0, w: 1, h: 1 })).toBe(g);
    const o = cropFrac(g, { x: 0.9, y: 0.9, w: 0.5, h: 0.5 });
    expect(o.width).toBeGreaterThanOrEqual(1); expect(o.width).toBeLessThanOrEqual(4);
  });
  it('proporção: exata, dentro da imagem e centrada onde pedido', () => {
    for (const ratio of [1, 4 / 5, 16 / 9, 9 / 16, 3]) {
      const r = ratioRect(400, 300, ratio);
      expect((r.w * 400) / (r.h * 300)).toBeCloseTo(ratio, 6);
      expect(r.x).toBeGreaterThanOrEqual(0); expect(r.y).toBeGreaterThanOrEqual(0);
      expect(r.x + r.w).toBeLessThanOrEqual(1 + 1e-9); expect(r.y + r.h).toBeLessThanOrEqual(1 + 1e-9);
      expect(Math.max(r.w, r.h)).toBeCloseTo(1, 6); // aproveita o máximo
    }
    const c = ratioRect(400, 300, 1, 0.1, 0.5); // centro pedido perto da borda: encosta sem sair
    expect(c.x).toBe(0);
    const m = ratioRect(400, 300, 1, 0.5, 0.5, 0.5);
    expect(m.w * 400).toBeCloseTo(150, 6);
  });
  it('aparar bordas: acha o conteúdo (cor uniforme ou transparente); sem borda = null', () => {
    const img = make(100, 80, (x, y) => (x >= 20 && x < 70 && y >= 10 && y < 50 ? [0, 0, 0] : [250, 250, 250]));
    const t = autoTrimRect(img)!;
    expect(t.x).toBeCloseTo(0.2, 6); expect(t.y).toBeCloseTo(10 / 80, 6); expect(t.w).toBeCloseTo(0.5, 6); expect(t.h).toBeCloseTo(0.5, 6);
    const tr = make(100, 80, (x, y) => (x >= 30 && x < 60 && y >= 20 && y < 60 ? [9, 9, 9, 255] : [0, 0, 0, 0]));
    expect(autoTrimRect(tr)!.w).toBeCloseTo(0.3, 6);
    expect(autoTrimRect(make(50, 50, (x, y) => [(x * 37 + y * 91) % 256, (x * 53 + y * 17) % 256, 90]))).toBeNull(); // conteúdo até a borda
    expect(autoTrimRect(make(50, 50, () => [1, 1, 1]))).toBeNull(); // tudo é fundo: nada a aparar
  });
  it('lista de proporções coerente', () => {
    expect(new Set(ASPECTS.map((a) => a.id)).size).toBe(ASPECTS.length);
    expect(ASPECTS.find((a) => a.id === '4:5')!.ratio).toBeCloseTo(0.8, 9);
    expect(ASPECTS.find((a) => a.id === '16:9')!.ratio).toBeCloseTo(16 / 9, 9);
  });
});

describe('forma do recorte', () => {
  const full = make(100, 60, () => [10, 20, 30]);
  it('arredondado: cantos transparentes, meio das bordas opaco; raio 0 ≈ retângulo', () => {
    const r = applyShape(full, 'rounded', 0.3);
    expect(px(r, 0, 0)[3]).toBe(0); expect(px(r, 99, 59)[3]).toBe(0);
    expect(px(r, 50, 0)[3]).toBeGreaterThan(250); expect(px(r, 0, 30)[3]).toBeGreaterThan(250); expect(px(r, 50, 30)[3]).toBe(255);
    expect(px(applyShape(full, 'rounded', 0), 0, 0)[3]).toBeGreaterThan(250);
    expect(applyShape(full, 'rect')).toBe(full);
  });
  it('elipse: cantos transparentes e pontas dos eixos opacas; quadrada vira círculo', () => {
    const e = applyShape(full, 'ellipse');
    expect(px(e, 1, 1)[3]).toBe(0); expect(px(e, 50, 0)[3]).toBeGreaterThan(200); expect(px(e, 0, 30)[3]).toBeGreaterThan(200); expect(px(e, 50, 30)[3]).toBe(255);
    const c = applyShape(make(80, 80, () => [1, 2, 3]), 'ellipse');
    expect(px(c, 40, 1)[3]).toBeGreaterThan(200); expect(px(c, 5, 5)[3]).toBe(0);
  });
});

describe('pipeline com transformação e recorte', () => {
  it('giro + recorte antes de tudo: dimensões e conteúdo; saída em tamanho fixo com forma', () => {
    const g = grid(60, 40);
    const t = { ...IDENTITY, rotate: 90 as const, crop: { x: 0, y: 0, w: 1, h: 0.5 } };
    const p = prepare(g, t);
    expect([p.width, p.height]).toEqual([40, 30]);
    expect(applyTransform(g, IDENTITY)).toBe(g);
    const out = enhance(g, NEUTRAL, { width: 20, height: 20, fit: 'cover', fx: 0.5, fy: 0.5, background: null, circle: false, shape: 'rounded', radius: 0.5 }, t);
    expect([out.width, out.height]).toEqual([20, 20]);
    expect(px(out, 0, 0)[3]).toBe(0);
    expect(px(out, 10, 10)[3]).toBe(255);
    // sem transformação o resultado é o mesmo de antes
    expect(enhance(g, NEUTRAL)).toBe(g);
  });
});
