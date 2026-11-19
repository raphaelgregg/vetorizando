import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { rasterize, CASES } from '../bench/cases';
import { compare, countSvgNodes } from '../bench/metrics';
import { loadThresholds, runBuiltin, runPairs } from '../bench/suite';
import type { RawImage } from '../src/engine/types';

const img = (w: number, h: number, f: (x: number, y: number) => number[]): RawImage => {
  const data = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set([...f(x, y), 255], (y * w + x) * 4);
  return { data, width: w, height: h };
};

describe('métricas', () => {
  const a = img(64, 64, (x) => (x < 20 ? [0, 0, 0] : [255, 255, 255]));
  it('imagens idênticas: SSIM 1, ΔE 0, Hausdorff 0', () => {
    const m = compare(a, a);
    expect(m.ssim).toBeCloseTo(1, 6);
    expect(m.deltaE).toBe(0);
    expect(m.hd95).toBe(0);
  });
  it('borda deslocada em 4 px: Hausdorff ≈ 4 e SSIM < 1', () => {
    const b = img(64, 64, (x) => (x < 24 ? [0, 0, 0] : [255, 255, 255]));
    const m = compare(a, b);
    expect(m.hdMax).toBeGreaterThanOrEqual(3);
    expect(m.hdMax).toBeLessThanOrEqual(5);
    expect(m.ssim).toBeLessThan(0.99);
  });
  it('ΔE entre preto e branco ≈ 100', () => {
    const m = compare(img(16, 16, () => [0, 0, 0]), img(16, 16, () => [255, 255, 255]));
    expect(m.deltaE).toBeGreaterThan(99);
  });
  it('contagem de nós de SVG externo', () => {
    expect(countSvgNodes('<svg><path d="M0 0L10 10C1 2 3 4 5 6A5 5 0 0 1 10 10Z"/></svg>')).toBe(4);
    expect(countSvgNodes('<svg><path d="m0 0 10 10 20 0z"/><polygon points="0,0 1,1 2,0"/></svg>')).toBe(3 + 3);
  });
});

describe('suíte de benchmark', () => {
  it('todos os casos embutidos passam nos limites de regressão', () => {
    const th = loadThresholds('bench/thresholds.json');
    const rows = runBuiltin(th);
    expect(rows.length).toBe(CASES.length);
    const failed = rows.filter((r) => r.failures.length).map((r) => `${r.id}: ${r.failures.join('; ')}`);
    expect(failed).toEqual([]);
  });

  it('roda com par imagem → SVG de referência e compara', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pairs-'));
    const c = CASES.find((x) => x.id === 'icon')!;
    const r = rasterize(c.svg);
    const png = new PNG({ width: r.width, height: r.height });
    png.data = Buffer.from(r.data);
    writeFileSync(join(dir, 'par.png'), PNG.sync.write(png));
    writeFileSync(join(dir, 'par.ref.svg'), c.svg); // a própria fonte vetorial = referência perfeita
    const rows = runPairs(dir, { default: {}, cases: {} });
    expect(rows.length).toBe(1);
    expect(rows[0].ref).toBeDefined();
    expect(rows[0].ref!.metrics.ssim).toBeGreaterThan(0.999);
    expect(rows[0].ours.metrics.ssim).toBeGreaterThan(0.95);
  });
});
