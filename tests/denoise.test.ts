import { describe, expect, it } from 'vitest';
import { CASES, rasterize } from '../bench/cases';
import { renderSvg } from '../bench/io';
import { compare } from '../bench/metrics';
import { DEGRADATIONS } from '../bench/stress';
import { denoise, estimateNoise } from '../src/engine/denoise';
import { PRESETS } from '../src/engine/presets';
import { toSVG } from '../src/engine/svg';
import { DEFAULT_OPTIONS, Options, RawImage } from '../src/engine/types';
import { vectorize } from '../src/engine/vectorize';

const src = (id: string) => CASES.find((c) => c.id === id)!.svg;
const deg = (id: string) => DEGRADATIONS.find((d) => d.id === id)!;
const opts = (p: Partial<Options> = {}): Options => ({ ...PRESETS[0].options, ...p });
const svgDoc = (body: string, w = 200, h = 200) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}"><rect width="${w}" height="${h}" fill="#fff"/>${body}</svg>`;

/** ruído gaussiano determinístico por canal (σ em níveis de 0–255), cortado em 0/255 como numa câmera */
function noisy(img: RawImage, sigma: number, seed = 11): RawImage {
  let s = seed >>> 0;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const d = new Uint8ClampedArray(img.data);
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] += Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()) * sigma;
  return { data: d, width: img.width, height: img.height };
}
const lum = (im: RawImage, x: number, y: number) => { const i = (y * im.width + x) * 4, a = im.data[i + 3] / 255; return (0.299 * im.data[i] + 0.587 * im.data[i + 1] + 0.114 * im.data[i + 2]) * a + 255 * (1 - a); };
const ink = (im: RawImage, x0: number, y0: number, x1: number, y1: number) => { let s = 0; for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) s += 255 - lum(im, x, y); return s; };

describe('detector: só age com evidência (imagens limpas passam intactas)', () => {
  it('nenhuma imagem limpa é filtrada — em 3 resoluções, inclusive hairlines, degradês, texto e elipses', () => {
    for (const c of CASES) for (const w of [256, 512, 1024]) {
      const img = rasterize(c.svg, w);
      const n = estimateNoise(img);
      expect(n.kind, `${c.id}@${w}`).toBe('none');
      const r = denoise(img, 1);
      expect(r.applied).toBe(false);
      expect(r.image).toBe(img); // o MESMO objeto: nenhum pixel tocado
    }
  });
  it('ruído branco → kind "noise" com σ̂ próximo do real; JPEG → "jpeg"; suavização (blur) → nada', () => {
    const clean = rasterize(src('logo'));
    const n4 = estimateNoise(noisy(clean, 4));
    expect(n4.kind).toBe('noise');
    expect(n4.sigma).toBeGreaterThan(2.5);
    expect(n4.sigma).toBeLessThan(5.5);
    for (const q of ['jpeg95', 'jpeg85', 'jpeg70', 'jpeg50']) expect(estimateNoise(deg(q).apply(clean)).kind, q).toBe('jpeg');
    expect(estimateNoise(deg('suave').apply(clean)).kind).toBe('none');
  });
  it('strength 0 desliga; `denoise: 0` nas opções também', () => {
    const img = noisy(rasterize(src('logo')), 6);
    expect(denoise(img, 0).image).toBe(img);
    expect(vectorize(img, opts({ denoise: 0 })).stats.denoised).toBe(false);
    expect(DEFAULT_OPTIONS.denoise).toBe(1);
  });
});

describe('preservação de bordas, cantos, linhas finas e alfa sob ruído', () => {
  it('borda reta de alto contraste: posição (±0,3 px) e contraste preservados', () => {
    const w = 64, h = 64, data = new Uint8ClampedArray(w * h * 4);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) data.set(x < 32 ? [20, 20, 20, 255] : [230, 230, 230, 255], (y * w + x) * 4);
    const clean: RawImage = { data, width: w, height: h };
    const r = denoise(noisy(clean, 6), 1);
    expect(r.applied).toBe(true);
    const row = (im: RawImage, y: number) => Array.from({ length: w }, (_, x) => lum(im, x, y));
    const cross = (v: number[]) => v.findIndex((q) => q > 125); // metade do contraste
    let worst = 0;
    for (let y = 8; y < 56; y += 4) worst = Math.max(worst, Math.abs(cross(row(r.image, y)) - 32));
    expect(worst).toBeLessThanOrEqual(1); // sem deslocar a borda
    const left = lum(r.image, 8, 30), right = lum(r.image, 56, 30);
    expect(right - left).toBeGreaterThan(190 * 0.95); // contraste (210) mantido
  });

  it('linha de 2 px (preta) em imagem ruidosa mantém ≥ 85% da tinta depois do filtro e da vetorização', () => {
    const clean = rasterize(svgDoc('<rect x="20" y="90" width="160" height="2" fill="#000"/>'), 200);
    const o = opts();
    const doc = vectorize(noisy(clean, 6), o);
    expect(doc.stats.denoised).toBe(true);
    const out = renderSvg(toSVG(doc, o), 200);
    expect(ink(out, 10, 80, 190, 102) / ink(clean, 10, 80, 190, 102)).toBeGreaterThan(0.85);
    expect(ink(out, 10, 80, 190, 102) / ink(clean, 10, 80, 190, 102)).toBeLessThan(1.15);
  });

  it('cantos vivos: um quadrado ruidoso continua com 4 vértices a < 0,8 px dos cantos verdadeiros', () => {
    const clean = rasterize(svgDoc('<rect x="50" y="50" width="100" height="100" fill="#2c3e50"/>'), 200);
    const doc = vectorize(noisy(clean, 6), opts({ removeBackground: true }));
    const p = doc.layers[0].paths[0];
    expect(p.segs.length).toBe(4);
    const v = [p.start, ...p.segs.slice(0, 3).map((s) => s.p)];
    for (const c of [[50, 50], [150, 50], [150, 150], [50, 150]]) expect(Math.min(...v.map((q) => Math.hypot(q.x - c[0], q.y - c[1])))).toBeLessThan(0.8);
  });

  it('canal alfa e pixels transparentes não são tocados; só a cor dos opacos é filtrada', () => {
    const clean = rasterize(src('icon')); // fundo transparente
    const n = noisy(clean, 6);
    const r = denoise(n, 1);
    expect(r.applied).toBe(true);
    for (let i = 0; i < n.data.length; i += 4) {
      expect(r.image.data[i + 3]).toBe(n.data[i + 3]);
      if (n.data[i + 3] < 128) { expect(r.image.data[i]).toBe(n.data[i]); expect(r.image.data[i + 1]).toBe(n.data[i + 1]); }
    }
  });
});

describe('integração no motor (estresse)', () => {
  const logo = rasterize(src('logo'));
  const cleanNodes = vectorize(logo, opts()).stats.nodes;

  it('imagem limpa: estatísticas indicam sem ruído e nada muda', () => {
    const d = vectorize(logo, opts());
    expect(d.stats.denoised).toBe(false);
    expect(d.stats.noise).toBe(0);
    expect(JSON.stringify(d.layers)).toBe(JSON.stringify(vectorize(logo, opts({ denoise: 0 })).layers));
  });

  it('JPEG q50: ≥ 3× menos nós que sem o filtro e fidelidade à verdade mantida', () => {
    const input = deg('jpeg50').apply(logo);
    const off = vectorize(input, opts({ denoise: 0 })), on = vectorize(input, opts());
    expect(on.stats.denoised).toBe(true);
    expect(on.stats.nodes * 3).toBeLessThan(off.stats.nodes);
    expect(on.stats.nodes).toBeLessThan(cleanNodes * 4);
    expect(compare(logo, renderSvg(toSVG(on, opts()), logo.width)).ssim).toBeGreaterThan(0.995);
  });

  it('ruído σ=10: mesmos nós da imagem limpa (±10%) e cores exatas (mediana, sem viés do corte em 0/255)', () => {
    const on = vectorize(noisy(logo, 10), opts());
    expect(on.stats.denoised).toBe(true);
    expect(Math.abs(on.stats.nodes - cleanNodes)).toBeLessThanOrEqual(cleanNodes * 0.1);
    const truth = vectorize(logo, opts()).layers.map((l) => l.color).sort();
    const got = on.layers.map((l) => l.color).sort();
    expect(got.length).toBe(truth.length);
    got.forEach((c, i) => { for (let k = 0; k < 3; k++) expect(Math.abs(parseInt(c.slice(1 + 2 * k, 3 + 2 * k), 16) - parseInt(truth[i].slice(1 + 2 * k, 3 + 2 * k), 16))).toBeLessThanOrEqual(2); });
    const m = compare(logo, renderSvg(toSVG(on, opts()), logo.width));
    expect(m.deltaEFlat).toBeLessThan(0.1); // antes do filtro: ≈ 1,0
    expect(m.ssim).toBeGreaterThan(0.995);
  });

  it('ilustração com ruído σ=4: nós caem ≥ 20× e o SSIM sobe de ~0,74 para > 0,94', () => {
    const ic = CASES.find((c) => c.id === 'illustration')!;
    const o = PRESETS.find((p) => p.id === 'illustration')!.options;
    const clean = rasterize(ic.svg), input = noisy(clean, 4);
    const on = vectorize(input, o);
    const m = compare(clean, renderSvg(toSVG(on, o), clean.width));
    expect(m.ssim).toBeGreaterThan(0.94);
    expect(on.stats.nodes).toBeLessThan(20000); // sem filtro: ~380 000
  }, 60000);
});
