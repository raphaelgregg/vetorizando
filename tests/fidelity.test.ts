import { describe, expect, it } from 'vitest';
import { CASES, rasterize } from '../bench/cases';
import { renderSvg } from '../bench/io';
import { compare } from '../bench/metrics';
import { loopArea } from '../src/engine/contour';
import { fitLoop } from '../src/engine/fit';
import { flattenPath } from '../src/engine/geom';
import { PRESETS } from '../src/engine/presets';
import { toSVG } from '../src/engine/svg';
import { DEFAULT_OPTIONS, Options, Pt, RawImage } from '../src/engine/types';
import { vectorize } from '../src/engine/vectorize';

const opts = (p: Partial<Options> = {}): Options => ({ ...PRESETS[0].options, ...p });
const svgDoc = (body: string, w = 200, h = 200, bg = '#fff') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">${bg ? `<rect width="${w}" height="${h}" fill="${bg}"/>` : ''}${body}</svg>`;

/** “Tinta” (escuridão) somada numa caixa — mede espessura/posição de traços finos sem depender de bordas. */
function ink(img: RawImage, x0: number, y0: number, x1: number, y1: number): number {
  let s = 0;
  for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
    const i = (y * img.width + x) * 4, a = img.data[i + 3] / 255;
    const lum = 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
    s += 255 - (lum * a + 255 * (1 - a)); // compõe sobre branco (o render tem alfa nas bordas)
  }
  return s;
}
function roundtrip(svg: string, o: Options, w: number) {
  const img = rasterize(svg, w);
  const out = renderSvg(toSVG(vectorize(img, o), o), w);
  return { img, out };
}

describe('preenchimento de fendas não engrossa formas', () => {
  it('barra preta de 4 px: tinta do SVG renderizado ≈ original (±5%, ≈ 0,2 px de largura)', () => {
    const { img, out } = roundtrip(svgDoc('<rect x="20" y="90" width="160" height="4" fill="#000"/>'), opts({ gapFiller: true }), 200);
    const a = ink(img, 10, 80, 190, 105), b = ink(out, 10, 80, 190, 105);
    expect(Math.abs(b / a - 1)).toBeLessThan(0.05);
  });
  it('fendas ficam ABAIXO dos preenchimentos e, com transparência, recortadas pela união das regiões', () => {
    const c = CASES.find((x) => x.id === 'icon')!;
    const o = opts();
    const doc = vectorize(rasterize(c.svg), o);
    expect(doc.openBoundary).toBe(true);
    const svg = toSVG(doc, o);
    expect(svg).toContain('<clipPath id="uniao">');
    expect(svg.indexOf('id="fendas"')).toBeLessThan(svg.indexOf('fill="#'));
    expect(svg).not.toContain('paint-order'); // o antigo traço sobre o preenchimento (engrossava)
  });
  it('fundo opaco: sem clipPath (a união é a imagem inteira)', () => {
    const c = CASES.find((x) => x.id === 'stripes')!;
    const doc = vectorize(rasterize(c.svg), opts());
    expect(doc.openBoundary).toBe(false);
    expect(toSVG(doc, opts())).not.toContain('clipPath');
  });
});

describe('traços finos e detalhes pequenos são preservados', () => {
  it.each([[3, 30], [2, 60], [1.5, 90]])('linha vertical de %s px mantém ≥ 85%% da tinta (e ≤ 115%%)', (wpx, x) => {
    const { img, out } = roundtrip(svgDoc(`<rect x="${x - wpx / 2}" y="30" width="${wpx}" height="140" fill="#111"/>`), opts(), 200);
    const a = ink(img, x - 6, 20, x + 6, 180), b = ink(out, x - 6, 20, x + 6, 180);
    expect(b / a).toBeGreaterThan(0.85);
    expect(b / a).toBeLessThan(1.15);
  });
  it('tira de 2 px não degenera (área ≥ 90% de 2×140) — regressão do caminho ida-e-volta', () => {
    const W = 100, H = 200, data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) data.set(x >= 49 && x < 51 && y >= 30 && y < 170 ? [17, 17, 17, 255] : [255, 255, 255, 255], (y * W + x) * 4);
    const d = vectorize({ width: W, height: H, data }, opts({ removeBackground: true }));
    const p = d.layers[0].paths[0];
    expect(Math.abs(loopArea(flattenPath(p, 0.02)))).toBeGreaterThan(0.9 * 280);
  });
  it('linha diagonal de 1,2 px não some (remoção de manchas por conectividade 8 + contraste)', () => {
    const { img, out } = roundtrip(svgDoc('<path d="M20 30L180 70" stroke="#111" stroke-width="1.2" fill="none"/>'), opts({ maxColors: 8 }), 200);
    const a = ink(img, 10, 20, 190, 80), b = ink(out, 10, 20, 190, 80);
    expect(b / a).toBeGreaterThan(0.6);
  });
  it('ponto contrastante de 2×2 px é mantido; ruído de baixo contraste é removido', () => {
    const W = 60, H = 60, data = new Uint8ClampedArray(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const dot = x >= 10 && x < 12 && y >= 10 && y < 12; // 4 px, preto no branco
      const noise = x >= 40 && x < 42 && y >= 40 && y < 42; // 4 px, quase branco
      data.set(dot ? [0, 0, 0, 255] : noise ? [247, 247, 247, 255] : [255, 255, 255, 255], (y * W + x) * 4);
    }
    const d = vectorize({ width: W, height: H, data }, opts({ maxColors: 4, mergeDeltaE: 2 }));
    const near = (px: number, py: number) => d.layers.some((l) => l.color !== '#ffffff' && l.paths.some((p) => Math.abs(p.start.x - px) < 4 && Math.abs(p.start.y - py) < 4));
    expect(near(11, 11)).toBe(true);
    expect(near(41, 41)).toBe(false);
  });
  it('cantos de ponta aguda (15°) e quadradinhos de 6 px mantêm a forma (caso `details` ≥ 0,985 de SSIM)', () => {
    const c = CASES.find((x) => x.id === 'details')!;
    const img = rasterize(c.svg), o = { ...opts(), ...c.options } as Options;
    const m = compare(img, renderSvg(toSVG(vectorize(img, o), o), img.width));
    expect(m.ssim).toBeGreaterThan(0.985);
    expect(m.deltaE).toBeLessThan(0.4);
  });
});

/** tinta por coluna numa faixa vertical em torno de uma reta y = f(x) */
function inkColumns(img: RawImage, f: (x: number) => number, xa: number, xb: number, hw = 4): number[] {
  const out: number[] = [];
  for (let x = xa; x < xb; x++) out.push(ink(img, x, Math.round(f(x)) - hw, x + 1, Math.round(f(x)) + hw + 1));
  return out;
}

describe('hairlines e linhas finas de baixa cobertura (sem tracejado)', () => {
  it('diagonal de 1,2 px: contínua (nenhuma coluna perde > 25% da tinta) e erro médio de tinta ≤ 12%', () => {
    const svg = svgDoc('<path d="M20 30L180 70" stroke="#111" stroke-width="1.2" fill="none"/>');
    const { img, out } = roundtrip(svg, opts({ maxColors: 8 }), 200);
    const f = (x: number) => 30 + ((x - 20) * 40) / 160;
    const a = inkColumns(img, f, 30, 170), b = inkColumns(out, f, 30, 170);
    expect(Math.min(...b.map((v, i) => v / a[i]))).toBeGreaterThan(0.75); // antes: colunas com 0% (tracejado)
    const mean = b.reduce((x, y) => x + y, 0) / a.reduce((x, y) => x + y, 0);
    expect(Math.abs(mean - 1)).toBeLessThan(0.12);
  });
  it('linha de 0,9 px a cavalo entre duas fileiras (≈ 45% cada, abaixo do limiar 0,5) não desaparece', () => {
    const { img, out } = roundtrip(svgDoc('<rect x="20" y="49.55" width="160" height="0.9" fill="#000"/>'), opts(), 200);
    const a = ink(img, 10, 40, 190, 60), b = ink(out, 10, 40, 190, 60);
    expect(b / a).toBeGreaterThan(0.7);
    expect(b / a).toBeLessThan(1.4);
  });
  it('linha fraca de 1 pixel isolada (cobertura 0,6 numa fileira) mantém a tinta (crista isolada)', () => {
    const { img, out } = roundtrip(svgDoc('<rect x="20" y="49.2" width="160" height="0.6" fill="#000"/>'), opts(), 200);
    const a = ink(img, 10, 40, 190, 60), b = ink(out, 10, 40, 190, 60);
    expect(b / a).toBeGreaterThan(0.7);
    expect(b / a).toBeLessThan(1.4);
  });
  it('ponta de forma (estrela) não é inflada pelo remapeamento de cristas', () => {
    const star = svgDoc('<polygon fill="#222" points="100,20 118,80 180,80 130,115 150,180 100,140 50,180 70,115 20,80 82,80"/>', 200, 200);
    const img = rasterize(star, 200), o = opts();
    const m = compare(img, renderSvg(toSVG(vectorize(img, o), o), 200));
    // valores de referência medidos no commit anterior (85a3c45): SSIM 0,9933 · ΔEborda 1,67 · 38 nós
    expect(m.ssim).toBeGreaterThan(0.992);
    expect(m.deltaEEdge).toBeLessThan(1.8);
    expect(vectorize(img, o).stats.nodes).toBeLessThanOrEqual(42);
  });
});

describe('estruturas finas: espessura medida por estrutura, cantos e fendas', () => {
  const grid = svgDoc(`<g stroke="#111" stroke-width="1" fill="none">${[40, 60, 80, 100].map((y) => `<path d="M20 ${y}H180"/>`).join('')}${[20, 70, 120, 170].map((x) => `<path d="M${x} 40V100"/>`).join('')}</g>`, 200, 140);
  it('moldura de grade de 1 px: nenhuma aresta LONGA inclinada (regressão: vértice de canto mal posto virava diagonal de 60 px)', () => {
    const d = vectorize(rasterize(grid, 200), opts({ maxColors: 8 }));
    const black = d.layers.filter((l) => l.color !== '#ffffff').flatMap((l) => l.paths);
    expect(black.length).toBeGreaterThan(0);
    for (const p of black) {
      let cur = p.start;
      for (const sg of p.segs) {
        const dx = Math.abs(sg.p.x - cur.x), dy = Math.abs(sg.p.y - cur.y);
        if (Math.max(dx, dy) > 5) expect(Math.min(dx, dy)).toBeLessThan(0.3); // arestas longas são H/V (chanfros de ~1 px nos cruzamentos são do raster)
        cur = sg.p;
      }
    }
  });
  it('estruturas finas (grade) são marcadas `thin` e ficam FORA do traço de fendas', () => {
    const o = opts({ maxColors: 8 });
    const d = vectorize(rasterize(grid, 200), o);
    const thin = d.layers.flatMap((l) => l.paths).filter((p) => p.thin);
    expect(thin.length).toBeGreaterThan(0);
    const svg = toSVG(d, o);
    const gaps = svg.slice(svg.indexOf('id="fendas"'), svg.indexOf('</g>', svg.indexOf('id="fendas"')));
    expect(gaps).not.toContain('stroke="#111111"'); // o traço de 0,6 px sobre uma linha de 1 px a engrossaria ~30%
  });
  it('barra de 4 px termina em pontas QUADRADAS (retângulo de 4 retas), não em arcos', () => {
    const d = vectorize(rasterize(svgDoc('<rect x="20" y="90" width="160" height="4" fill="#000"/>'), 200), opts({ removeBackground: true }));
    const p = d.layers[0].paths[0];
    expect(p.segs.length).toBe(4);
    expect(p.segs.every((sg) => sg.t === 'L')).toBe(true);
  });
});

describe('fusão pós-ajuste conservadora', () => {
  /** contorno denso de um retângulo arredondado (raio 20) com ruído determinístico de ±0,08 px */
  function roundedRect(): Pt[] {
    const pts: Pt[] = [], w = 120, h = 70, r = 20;
    const line = (x0: number, y0: number, x1: number, y1: number) => { const n = Math.max(1, Math.round(Math.hypot(x1 - x0, y1 - y0))); for (let i = 0; i < n; i++) pts.push({ x: x0 + ((x1 - x0) * i) / n, y: y0 + ((y1 - y0) * i) / n }); };
    const arc = (cx: number, cy: number, a0: number) => { const n = Math.round((r * Math.PI) / 2); for (let i = 0; i < n; i++) { const a = a0 + (i / n) * (Math.PI / 2); pts.push({ x: cx + r * Math.cos(a), y: cy + r * Math.sin(a) }); } };
    line(r, 0, w - r, 0); arc(w - r, r, -Math.PI / 2);
    line(w, r, w, h - r); arc(w - r, h - r, 0);
    line(w - r, h, r, h); arc(r, h - r, Math.PI / 2);
    line(0, h - r, 0, r); arc(r, r, Math.PI);
    return pts.map((p, i) => ({ x: p.x + Math.sin(i * 12.9) * 0.08, y: p.y + Math.cos(i * 7.1) * 0.08 }));
  }
  const fo = { tolerance: 0.3, cornerThreshold: 60, smooth: 0, arcs: true, ellipses: true };
  const segDist = (p: Pt, a: Pt, b: Pt) => {
    const dx = b.x - a.x, dy = b.y - a.y, l2 = dx * dx + dy * dy;
    const t = l2 ? Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / l2)) : 0;
    return Math.hypot(p.x - (a.x + t * dx), p.y - (a.y + t * dy));
  };
  /** desvio máximo: do contorno original até o caminho ajustado (distância a segmentos, não a vértices) */
  const dev = (path: ReturnType<typeof fitLoop>, loop: Pt[]) => {
    const f = flattenPath(path, 0.02);
    let worst = 0;
    for (const p of loop) { let best = Infinity; for (let i = 0; i < f.length; i++) best = Math.min(best, segDist(p, f[i], f[(i + 1) % f.length])); worst = Math.max(worst, best); }
    return worst;
  };
  it('nunca aumenta nós e o desvio máximo continua ≤ tolerância (+ folga de amostragem)', () => {
    const loop = roundedRect();
    const on = fitLoop(loop, fo), off = fitLoop(loop, { ...fo, merge: false });
    expect(on.segs.length).toBeLessThanOrEqual(off.segs.length);
    expect(dev(on, loop)).toBeLessThan(0.3 + 0.12);
    expect(dev(off, loop)).toBeLessThan(0.3 + 0.12);
  });
  it('no benchmark: fusão não piora SSIM/ΔE (texto)', () => {
    const c = CASES.find((x) => x.id === 'text')!;
    const img = rasterize(c.svg), o = opts();
    const r = (m: boolean) => { const d = vectorize(img, o, undefined, { merge: m }); return { n: d.stats.nodes, m: compare(img, renderSvg(toSVG(d, o), img.width)) }; };
    const on = r(true), off = r(false);
    expect(on.n).toBeLessThanOrEqual(off.n);
    expect(on.m.ssim).toBeGreaterThan(off.m.ssim - 0.0015);
  });
});

describe('cores e bordas', () => {
  it('logo: cores exatas das formas originais (sem tons de anti-aliasing)', () => {
    const c = CASES.find((x) => x.id === 'logo')!;
    const d = vectorize(rasterize(c.svg), opts());
    expect(d.layers.map((l) => l.color).sort()).toEqual(['#171717'.replace('#171717', '#171a2b'), '#2547d0', '#ff7a1a', '#ffffff'].sort());
  });
  it('DEFAULT_OPTIONS permanece com arcos/elipses ligados', () => expect(DEFAULT_OPTIONS.arcs && DEFAULT_OPTIONS.ellipses).toBe(true));
});
