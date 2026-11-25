import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { encodePng } from '../src/icons/png';
import { AUTO_PARAMS, NEUTRAL, adjust, applyCircle, autoLevels, enhance, fitToSize, grayWorld, resize, unsharp } from '../src/enhance/ops';
import { PLATFORMS, PROFILE_PACK, SOCIAL_PRESETS, presetById } from '../src/enhance/social';
import type { RawImage } from '../src/engine/types';

const make = (w: number, h: number, f: (x: number, y: number) => number[]): RawImage => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) { const c = f(x, y); data.set([c[0], c[1], c[2], c[3] ?? 255], (y * w + x) * 4); }
  return { data, width: w, height: h };
};
const px = (im: RawImage, x: number, y: number) => [...im.data.slice((y * im.width + x) * 4, (y * im.width + x) * 4 + 4)];
const mean = (im: RawImage, c: number) => { let s = 0; for (let i = 0; i < im.width * im.height; i++) s += im.data[i * 4 + c]; return s / (im.width * im.height); };
const std = (im: RawImage) => { const m = mean(im, 1); let s = 0; for (let i = 0; i < im.width * im.height; i++) s += (im.data[i * 4 + 1] - m) ** 2; return Math.sqrt(s / (im.width * im.height)); };
let seed = 7;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);

describe('redimensionar (Lanczos)', () => {
  it('cor constante continua constante, em qualquer escala', () => {
    const c = make(37, 23, () => [200, 120, 40]);
    for (const [w, h] of [[10, 6], [100, 70], [37, 23]]) { const r = resize(c, w, h); expect(r.width).toBe(w); expect(px(r, Math.floor(w / 2), Math.floor(h / 2))).toEqual([200, 120, 40, 255]); }
  });
  it('reduzir um xadrez fino dá a média; transparência não "sangra" cor', () => {
    const chk = make(64, 64, (x, y) => ((x + y) % 2 ? [255, 255, 255] : [0, 0, 0]));
    expect(Math.abs(mean(resize(chk, 8, 8), 0) - 127.5)).toBeLessThan(4);
    const half = make(40, 40, (x) => (x < 20 ? [255, 0, 0, 255] : [0, 255, 0, 0])); // direita transparente (com cor verde "escondida")
    const r = resize(half, 20, 20);
    expect(px(r, 2, 10)).toEqual([255, 0, 0, 255]);
    expect(px(r, 17, 10)[3]).toBe(0);
    expect(px(r, 9, 10)[1]).toBeLessThan(10); // sem verde na borda
  });
});

describe('cor e nitidez', () => {
  it('níveis automáticos esticam um histograma estreito e não mexem em um completo', () => {
    const flat = make(64, 64, (x) => { const v = 80 + (x / 63) * 90; return [v, v, v]; });
    const a = autoLevels(flat);
    expect(Math.min(...[...a.data].filter((_, i) => i % 4 === 0))).toBeLessThan(10);
    expect(Math.max(...[...a.data].filter((_, i) => i % 4 === 0))).toBeGreaterThan(245);
    const full = make(64, 64, (x) => { const v = (x / 63) * 255; return [v, v, v]; });
    expect(autoLevels(full)).toBe(full);
  });
  it('balanço de branco reduz a dominante azulada', () => {
    const blue = make(32, 32, () => [90, 110, 160]);
    const g = grayWorld(blue);
    expect(Math.abs(mean(g, 0) - mean(g, 2))).toBeLessThan(Math.abs(mean(blue, 0) - mean(blue, 2)));
  });
  it('ajustes: neutro devolve o mesmo objeto; brilho sobe; saturação −100 vira cinza; temperatura aquece', () => {
    const im = make(16, 16, () => [100, 140, 60]);
    expect(adjust(im, NEUTRAL)).toBe(im);
    expect(mean(adjust(im, { ...NEUTRAL, brightness: 40 }), 1)).toBeGreaterThan(140);
    const g = adjust(im, { ...NEUTRAL, saturation: -100 });
    const p = px(g, 3, 3);
    expect(Math.abs(p[0] - p[1])).toBeLessThanOrEqual(1);
    expect(Math.abs(p[1] - p[2])).toBeLessThanOrEqual(1);
    const w = adjust(im, { ...NEUTRAL, temperature: 50 });
    expect(mean(w, 0)).toBeGreaterThan(100); expect(mean(w, 2)).toBeLessThan(60);
  });
  it('nitidez: realça a borda (overshoot) e não altera área plana', () => {
    const edge = make(40, 10, (x) => (x < 20 ? [100, 100, 100] : [160, 160, 160]));
    const s = unsharp(edge, 1, 1);
    expect(px(s, 19, 5)[0]).toBeLessThan(100);
    expect(px(s, 20, 5)[0]).toBeGreaterThan(160);
    expect(px(s, 3, 5)[0]).toBe(100);
    expect(unsharp(edge, 0, 1)).toBe(edge);
  });
});

describe('ajuste ao tamanho', () => {
  const lr = make(200, 100, (x) => (x < 100 ? [255, 0, 0] : [0, 0, 255]));
  it('cover: tamanho exato; o foco escolhe o lado cortado', () => {
    const left = fitToSize(lr, 100, 100, 'cover', 0, 0.5), right = fitToSize(lr, 100, 100, 'cover', 1, 0.5), mid = fitToSize(lr, 100, 100, 'cover');
    expect([left.width, left.height]).toEqual([100, 100]);
    expect(px(left, 50, 50)).toEqual([255, 0, 0, 255]);
    expect(px(right, 50, 50)).toEqual([0, 0, 255, 255]);
    expect(px(mid, 2, 50)[0]).toBeGreaterThan(200); expect(px(mid, 97, 50)[2]).toBeGreaterThan(200);
  });
  it('contain: imagem inteira, bordas transparentes ou com a cor pedida', () => {
    const t = fitToSize(lr, 100, 100, 'contain');
    expect(px(t, 50, 2)[3]).toBe(0); expect(px(t, 50, 50)[3]).toBe(255);
    const c = fitToSize(lr, 100, 100, 'contain', 0.5, 0.5, '#00ff00');
    expect(px(c, 50, 2)).toEqual([0, 255, 0, 255]);
  });
  it('círculo: cantos transparentes e centro opaco', () => {
    const c = applyCircle(make(100, 100, () => [10, 20, 30]));
    expect(px(c, 0, 0)[3]).toBe(0); expect(px(c, 50, 50)[3]).toBe(255);
    expect(px(c, 50, 1)[3]).toBeGreaterThan(200);
  });
});

describe('melhoria completa e PNG', () => {
  it('automática: aumenta o contraste de uma foto lavada e entrega o tamanho pedido', () => {
    const dull = make(300, 200, (x, y) => { const v = 90 + (x / 299) * 70 + (y % 7); return [v, v * 0.95, v * 0.9]; });
    const out = enhance(dull, AUTO_PARAMS, { width: 100, height: 100, fit: 'cover', fx: 0.5, fy: 0.5, background: null, circle: false });
    expect([out.width, out.height]).toEqual([100, 100]);
    expect(std(out)).toBeGreaterThan(std(resize(dull, 100, 100)) * 1.3);
  });
  it('remove ruído quando detectado (e deixa imagem limpa intacta)', () => {
    const clean = make(120, 120, (x) => (x < 60 ? [200, 60, 60] : [60, 60, 200]));
    const noisy = make(120, 120, (x) => { const n = (rnd() - 0.5) * 30; return x < 60 ? [200 + n, 60 + n, 60 + n] : [60 + n, 60 + n, 200 + n]; });
    const p = { ...NEUTRAL, denoise: 1 };
    expect(enhance(clean, p)).toBe(clean);
    const d = enhance(noisy, p);
    const dev = (im: RawImage) => { let s = 0; for (let y = 5; y < 115; y++) for (let x = 5; x < 55; x++) s += Math.abs(im.data[(y * 120 + x) * 4] - 200); return s; };
    expect(dev(d)).toBeLessThan(dev(noisy) * 0.7);
  });
  it('círculo no pipeline e saída PNG decodificável idêntica', () => {
    const im = make(64, 64, (x, y) => [x * 4, y * 4, 128]);
    const out = enhance(im, NEUTRAL, { width: 32, height: 32, fit: 'cover', fx: 0.5, fy: 0.5, background: null, circle: true });
    expect(px(out, 0, 0)[3]).toBe(0);
    const png = PNG.sync.read(Buffer.from(encodePng(out.width, out.height, out.data)));
    expect([png.width, png.height]).toEqual([32, 32]);
    expect([...png.data]).toEqual([...out.data]);
  });
});

describe('tamanhos para redes sociais', () => {
  it('lista coerente e com os padrões mais comuns', () => {
    expect(new Set(SOCIAL_PRESETS.map((p) => p.id)).size).toBe(SOCIAL_PRESETS.length);
    for (const p of SOCIAL_PRESETS) { expect(p.width).toBeGreaterThan(0); expect(p.height).toBeGreaterThan(0); expect(p.note.length).toBeGreaterThan(5); }
    expect(presetById('ig-profile')).toMatchObject({ width: 320, height: 320, shape: 'circle' });
    expect(presetById('wa-profile')).toMatchObject({ width: 640, height: 640, shape: 'circle' });
    expect(presetById('ig-story')).toMatchObject({ width: 1080, height: 1920 });
    expect(presetById('ig-portrait')).toMatchObject({ width: 1080, height: 1350 });
    expect(PLATFORMS).toEqual(expect.arrayContaining(['Instagram', 'WhatsApp', 'Facebook', 'YouTube']));
    for (const id of PROFILE_PACK) expect(presetById(id)).toBeTruthy();
    for (const p of SOCIAL_PRESETS.filter((x) => x.shape === 'circle')) expect(p.width).toBe(p.height);
  });
});
