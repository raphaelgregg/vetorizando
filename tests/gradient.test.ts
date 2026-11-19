import { DOMParser } from '@xmldom/xmldom';
import { describe, expect, it } from 'vitest';
import { CASES, rasterize } from '../bench/cases';
import { renderSvg } from '../bench/io';
import { compare } from '../bench/metrics';
import { DEGRADATIONS } from '../bench/stress';
import { flattenGradients } from '../src/engine/gradient';
import { applyPaletteEdits } from '../src/engine/palette';
import { PRESETS } from '../src/engine/presets';
import { toSVG } from '../src/engine/svg';
import { Options, RawImage } from '../src/engine/types';
import { vectorize } from '../src/engine/vectorize';
import { exportDoc } from '../src/export';
import { vectorDrawable } from '../src/icons/android';

const opts = (p: Partial<Options> = {}): Options => ({ ...PRESETS[0].options, ...p });
const wrap = (body: string, bg = '#ffffff', w = 256, h = 256) => `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ''}${body}</svg>`;
const LIN = wrap(`<defs><linearGradient id="g" x1="0" y1="0" x2="256" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#1b3a8a"/><stop offset="0.5" stop-color="#4f8fe0"/><stop offset="1" stop-color="#ffd27a"/></linearGradient></defs><rect width="256" height="256" fill="url(#g)"/>`, '');
const RAD = wrap(`<defs><radialGradient id="g" cx="128" cy="128" r="100" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff2c2"/><stop offset="0.5" stop-color="#f2a33a"/><stop offset="1" stop-color="#9a3d0b"/></radialGradient></defs><circle cx="128" cy="128" r="100" fill="url(#g)"/>`);
const ras = (svg: string) => rasterize(svg, 256);
const ssimOf = (img: RawImage, svg: string) => compare(img, renderSvg(svg, img.width)).ssim;

function noisy(img: RawImage, sigma: number, seed = 5): RawImage {
  let s = seed >>> 0;
  const r = () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296);
  const d = new Uint8ClampedArray(img.data);
  for (let i = 0; i < d.length; i += 4) for (let c = 0; c < 3; c++) d[i + c] += Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()) * sigma;
  return { data: d, width: img.width, height: img.height };
}

describe('gradientes: detecção e ajuste', () => {
  it('recupera um gradiente linear horizontal (direção e stops)', () => {
    const doc = vectorize(ras(LIN), opts());
    const l = doc.layers.find((x) => x.gradient);
    expect(doc.stats.gradients).toBe(1);
    const g = l!.gradient!;
    expect(g.kind).toBe('linear');
    if (g.kind !== 'linear') return;
    expect(Math.abs(g.y2 - g.y1)).toBeLessThan(8);
    expect(g.x1).toBeLessThan(10);
    expect(g.x2).toBeGreaterThan(246);
    expect(g.stops[0].color).toMatch(/^#/);
    expect(g.stops.length).toBeGreaterThanOrEqual(3);
    expect(g.stops.length).toBeLessThanOrEqual(12);
    expect(g.stops[0].offset).toBeLessThan(0.1);
  });

  it('recupera um gradiente radial (centro e raio)', () => {
    const doc = vectorize(ras(RAD), opts());
    const l = doc.layers.find((x) => x.gradient);
    expect(l).toBeTruthy();
    const g = l!.gradient!;
    expect(g.kind).toBe('radial');
    if (g.kind !== 'radial') return;
    expect(Math.hypot(g.cx - 128, g.cy - 128)).toBeLessThan(8);
    expect(g.r).toBeGreaterThan(90);
    expect(g.r).toBeLessThan(110);
  });

  it('não detecta gradientes em imagens de bordas duras e áreas planas (resultado idêntico)', () => {
    for (const id of ['logo', 'icon', 'lineart', 'text', 'details', 'stripes', 'ellipses']) {
      const c = CASES.find((x) => x.id === id)!;
      const img = rasterize(c.svg);
      const o = opts();
      const a = vectorize(img, o), b = vectorize(img, { ...o, gradients: false });
      expect(a.stats.gradients, id).toBe(0);
      expect(toSVG(a, o), id).toBe(toSVG(b, o));
    }
  });

  it('mais fiel e com bem menos nós que as bandas sólidas', () => {
    const img = ras(LIN);
    const o = opts({ maxColors: 12 });
    const on = vectorize(img, o), off = vectorize(img, { ...o, gradients: false });
    expect(on.stats.nodes).toBeLessThan(off.stats.nodes);
    expect(ssimOf(img, toSVG(on, o))).toBeGreaterThanOrEqual(ssimOf(img, toSVG(off, o)) - 1e-4);
    expect(ssimOf(img, toSVG(on, o))).toBeGreaterThan(0.99);
  });

  it('caso do bench: gradientes + sólidos juntos; borda dura do botão e formas sólidas preservadas', () => {
    const c = CASES.find((x) => x.id === 'gradients')!;
    const img = rasterize(c.svg);
    const o = { ...PRESETS.find((p) => p.id === c.preset)!.options };
    const on = vectorize(img, o), off = vectorize(img, { ...o, gradients: false });
    expect(on.stats.gradients).toBeGreaterThanOrEqual(3);
    expect(on.stats.nodes).toBeLessThan(off.stats.nodes * 0.5);
    expect(ssimOf(img, toSVG(on, o))).toBeGreaterThan(ssimOf(img, toSVG(off, o)));
    expect(on.layers.some((l) => !l.gradient)).toBe(true); // barras sólidas continuam sólidas
  });

  it('robusto a ruído e JPEG', () => {
    const img = ras(LIN);
    const o = opts();
    expect(vectorize(noisy(img, 6), o).stats.gradients).toBe(1);
    const jpg = DEGRADATIONS.find((d) => d.id === 'jpeg50')!.apply(img);
    expect(vectorize(jpg, o).stats.gradients).toBe(1);
  });
});

describe('gradientes: saída e fallbacks', () => {
  const o = opts();
  const doc = vectorize(ras(RAD), o);

  it('SVG válido com <radialGradient>/<stop> referenciado', () => {
    const svg = toSVG(doc, o);
    const errors: string[] = [];
    const d = new DOMParser({ onError: (lv, m) => { if (lv !== 'warning') errors.push(m); } }).parseFromString(svg, 'text/xml');
    expect(errors).toEqual([]);
    expect(d.getElementsByTagName('radialGradient').length).toBe(1);
    expect(d.getElementsByTagName('stop').length).toBeGreaterThanOrEqual(3);
    expect(svg).toMatch(/fill="url\(#g0\)"/);
  });

  it('SvgColors.gradients=false → só cores sólidas, sem <stop>', () => {
    const svg = toSVG(doc, o, {}, { mode: 'hex', gradients: false });
    expect(svg).not.toMatch(/Gradient|<stop/);
    expect(flattenGradients(doc).layers.some((l) => l.gradient)).toBe(false);
  });

  it('PDF/EPS/DXF e Android Vector Drawable usam bandas sólidas', () => {
    const size = { unit: 'px' as const, dpi: 96 };
    for (const f of ['pdf', 'eps', 'dxf'] as const) {
      const out = exportDoc(f, doc, o, size, 256, 256);
      expect(String(typeof out.data === 'string' ? out.data : new TextDecoder('latin1').decode(out.data))).not.toMatch(/Gradient|url\(#/);
    }
    const xml = vectorDrawable(doc, o, { dp: 24, viewport: 24 });
    expect(xml).not.toMatch(/gradient|url\(#/i);
    expect(xml.match(/<path/g)!.length).toBeGreaterThan(1);
  });

  it('o SVG sem gradientes renderiza próximo ao com gradientes (bandas como fallback)', () => {
    const img = ras(RAD);
    const bands = ssimOf(img, toSVG(doc, o, {}, { mode: 'hex', gradients: false }));
    expect(bands).toBeGreaterThan(0.8);
    expect(ssimOf(img, toSVG(doc, o))).toBeGreaterThan(bands);
  });

  it('editar a cor de uma camada com gradiente a torna sólida; ocultar remove', () => {
    const l = doc.layers.find((x) => x.gradient)!;
    const solid = applyPaletteEdits(doc, { [l.color]: { color: '#ff0000' } });
    expect(solid.layers.some((x) => x.gradient)).toBe(false);
    expect(solid.stats.gradients).toBe(0);
    expect(applyPaletteEdits(doc, {}).stats.gradients).toBe(1);
    expect(applyPaletteEdits(doc, { [l.color]: { hidden: true } }).layers.some((x) => x.gradient)).toBe(false);
  });

  it('opção gradients=false e preset CNC: nenhum gradiente', () => {
    const img = ras(RAD);
    expect(vectorize(img, opts({ gradients: false })).stats.gradients).toBe(0);
    const cnc = PRESETS.find((p) => p.id === 'cnc')!.options;
    expect(cnc.gradients).toBe(false);
    expect(vectorize(img, cnc).stats.gradients).toBe(0);
    expect(vectorize(img, opts({ drawStyle: 'outline' })).stats.gradients).toBe(0);
  });

  it('modo empilhado também detecta e mantém a fidelidade', () => {
    const img = ras(LIN);
    const os = opts({ stacking: 'stacked', gapFiller: false });
    const d = vectorize(img, os);
    expect(d.stats.gradients).toBe(1);
    expect(ssimOf(img, toSVG(d, os))).toBeGreaterThan(0.99);
  });
});
