import { describe, expect, it } from 'vitest';
import { CASES, rasterize } from '../bench/cases';
import { renderSvg } from '../bench/io';
import { compare } from '../bench/metrics';
import { fitEllipse } from '../src/engine/ellipse';
import { arcToCubics, ellipseGeom, flattenPath } from '../src/engine/geom';
import { PRESETS } from '../src/engine/presets';
import { toSVG } from '../src/engine/svg';
import { DEFAULT_OPTIONS, Options, Pt, VDoc } from '../src/engine/types';
import { vectorize } from '../src/engine/vectorize';
import { exportDoc } from '../src/export';

const opts = (p: Partial<Options> = {}): Options => ({ ...PRESETS[0].options, ...p });
const str = (d: string | Uint8Array) => (typeof d === 'string' ? d : Buffer.from(d).toString('latin1'));

/** Raster com uma elipse preenchida (cx,cy,rx,ry,rot°) via SVG → resvg (com anti-aliasing). */
function ellipseImage(cx: number, cy: number, rx: number, ry: number, rot: number) {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256" viewBox="0 0 256 256"><rect width="256" height="256" fill="#fff"/><ellipse cx="${cx}" cy="${cy}" rx="${rx}" ry="${ry}" transform="rotate(${rot} ${cx} ${cy})" fill="#c0392b"/></svg>`;
  return { svg, img: rasterize(svg, 256) };
}

describe('fitEllipse (Halir–Flusser)', () => {
  it('recupera centro, semi-eixos e rotação de pontos exatos', () => {
    const phi = (-30 * Math.PI) / 180, pts: Pt[] = [];
    for (let i = 0; i <= 120; i++) {
      const t = (i / 120) * 4.5, u = 80 * Math.cos(t), v = 30 * Math.sin(t);
      pts.push({ x: 100 + u * Math.cos(phi) - v * Math.sin(phi), y: 90 + u * Math.sin(phi) + v * Math.cos(phi) });
    }
    const f = fitEllipse(pts, 0, pts.length - 1)!;
    expect(f).not.toBeNull();
    expect(f.cx).toBeCloseTo(100, 5);
    expect(f.cy).toBeCloseTo(90, 5);
    expect(Math.max(f.rx, f.ry)).toBeCloseTo(80, 5);
    expect(Math.min(f.rx, f.ry)).toBeCloseTo(30, 5);
  });
  it('rejeita pontos colineares e poucos pontos', () => {
    const line = Array.from({ length: 20 }, (_, i) => ({ x: i, y: 2 * i }));
    expect(fitEllipse(line, 0, 19)).toBeNull();
    expect(fitEllipse(line, 0, 3)).toBeNull();
  });
});

describe('geometria de arcos elípticos', () => {
  const a = { x: 100, y: 50 }, b = { x: 40, y: 120 };
  const seg = { t: 'E' as const, rx: 70, ry: 35, rot: 25, large: 0 as const, sweep: 1 as const, p: b };
  it('Béziers geradas ficam sobre a elipse (erro < 0,2% do raio) e terminam no ponto final', () => {
    const g = ellipseGeom(a, b, seg.rx, seg.ry, seg.rot, seg.large, seg.sweep);
    const cubs = arcToCubics(a, seg);
    expect(cubs[cubs.length - 1].p).toEqual(b);
    const cp = Math.cos(g.phi), sp = Math.sin(g.phi);
    let cur = a, worst = 0;
    for (const c of cubs) {
      for (let i = 0; i <= 20; i++) {
        const t = i / 20, m = 1 - t;
        const x = m ** 3 * cur.x + 3 * m * m * t * c.c1.x + 3 * m * t * t * c.c2.x + t ** 3 * c.p.x;
        const y = m ** 3 * cur.y + 3 * m * m * t * c.c1.y + 3 * m * t * t * c.c2.y + t ** 3 * c.p.y;
        const u = (x - g.c.x) * cp + (y - g.c.y) * sp, v = -(x - g.c.x) * sp + (y - g.c.y) * cp;
        worst = Math.max(worst, Math.abs(Math.sqrt((u / g.rx) ** 2 + (v / g.ry) ** 2) - 1));
      }
      cur = c.p;
    }
    expect(worst).toBeLessThan(0.002);
  });
  it('raios pequenos demais são ampliados (como no SVG) e rx=ry reproduz o arco circular', () => {
    const g = ellipseGeom({ x: 0, y: 0 }, { x: 100, y: 0 }, 10, 10, 0, 0, 1);
    expect(g.rx).toBeCloseTo(50, 6);
    const g2 = ellipseGeom({ x: 0, y: 0 }, { x: 10, y: 10 }, 10, 10, 0, 0, 1);
    expect(g2.rx).toBeCloseTo(10, 6);
    expect(Math.abs(g2.da)).toBeCloseTo(Math.PI / 2, 6);
  });
  it('flattenPath trata E como as demais primitivas', () => {
    const pts = flattenPath({ start: a, segs: [seg, { t: 'L', p: a }] }, 0.02);
    expect(pts.length).toBeGreaterThan(8);
  });
});

describe('ajuste de elipses no motor', () => {
  const { svg, img } = ellipseImage(128, 120, 90, 38, -35);

  it('elipse rotacionada vira ≤ 3 nós, com arcos elípticos', () => {
    const d = vectorize(img, opts({ removeBackground: true }));
    expect(d.stats.nodes).toBeLessThanOrEqual(3);
    expect(d.stats.ellipses).toBeGreaterThan(0);
  });
  it('desligando `ellipses` não há arcos elípticos e há mais nós', () => {
    const on = vectorize(img, opts({ removeBackground: true }));
    const off = vectorize(img, opts({ removeBackground: true, ellipses: false }));
    expect(off.stats.ellipses).toBe(0);
    expect(off.stats.nodes).toBeGreaterThan(on.stats.nodes);
  });
  it('SVG tem `A rx ry rot` com rx≠ry e renderiza fiel ao original (SSIM ≥ 0,99, HD ≤ 1,5 px)', () => {
    const o = opts({ removeBackground: true });
    const doc = vectorize(img, o);
    const out = toSVG(doc, o);
    const m = /A([\d.]+) ([\d.]+) (-?[\d.]+) [01] [01]/.exec(out)!;
    expect(m).not.toBeNull();
    expect(Math.abs(Number(m[1]) - Number(m[2]))).toBeGreaterThan(5);
    const r = compare(img, renderSvg(out, 256));
    expect(r.ssim).toBeGreaterThan(0.99);
    expect(r.hd95).toBeLessThanOrEqual(1.5);
    void svg;
  });
  it('exportadores: PDF/EPS convertem para curvas e DXF vira polilinha sobre a elipse', () => {
    const o = opts({ removeBackground: true });
    const doc: VDoc = vectorize(img, o);
    const size = { unit: 'px' as const, dpi: 72 };
    const pdf = str(exportDoc('pdf', doc, o, size, 256, 256).data);
    expect(pdf).toMatch(/ c\n/);
    expect(pdf).not.toMatch(/ A /);
    const eps = str(exportDoc('eps', doc, o, size, 256, 256).data);
    expect(eps).toContain('curveto');
    const dxf = str(exportDoc('dxf', doc, o, { unit: 'px', dpi: 96 }, 256, 256).data).split('\n');
    const xs: number[] = [], ys: number[] = [];
    dxf.forEach((l, i) => { if (l === '0' && dxf[i + 1] === 'VERTEX') { xs.push(Number(dxf[i + 5])); ys.push(Number(dxf[i + 7])); } });
    expect(xs.length).toBeGreaterThan(30); // elipse achatada em polilinha
    const cx = 128, cy = 256 - 120;
    const phi = (35 * Math.PI) / 180; // y invertido no DXF: rotação inverte o sinal
    let worst = 0;
    xs.forEach((x, i) => {
      const u = (x - cx) * Math.cos(phi) + (ys[i] - cy) * Math.sin(phi), v = -(x - cx) * Math.sin(phi) + (ys[i] - cy) * Math.cos(phi);
      worst = Math.max(worst, Math.abs(Math.sqrt((u / 90) ** 2 + (v / 38) ** 2) - 1) * 38);
    });
    expect(worst).toBeLessThan(1.2);
  });
});

describe('precisão de cantos e cores', () => {
  it('losango girado a 45°: os 4 vértices ficam a < 0,7 px dos cantos verdadeiros', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" width="200" height="200" viewBox="0 0 200 200"><rect width="200" height="200" fill="#fff"/><polygon points="100,20 180,100 100,180 20,100" fill="#2c3e50"/></svg>';
    const d = vectorize(rasterize(svg, 200), opts({ removeBackground: true }));
    const path = d.layers[0].paths[0];
    expect(path.segs.length).toBe(4);
    const verts = [path.start, ...path.segs.slice(0, 3).map((s) => s.p)];
    for (const c of [[100, 20], [180, 100], [100, 180], [20, 100]]) {
      expect(Math.min(...verts.map((v) => Math.hypot(v.x - c[0], v.y - c[1])))).toBeLessThan(0.7);
    }
  });
  it('sem camadas de “cor de mistura”: listras têm exatamente as 4 cores originais', () => {
    const c = CASES.find((x) => x.id === 'stripes')!;
    const d = vectorize(rasterize(c.svg), opts());
    expect(d.layers.map((l) => l.color).sort()).toEqual(['#1f9d55', '#d62839', '#ffd100', '#ffffff']);
  });
  it('fronteira compartilhada coerente: sem fenda > 0,5 px entre regiões vizinhas (ΔE>25 só em ≤ 1 coluna)', () => {
    const c = CASES.find((x) => x.id === 'stripes')!;
    const img = rasterize(c.svg);
    const o = opts();
    const r = compare(img, renderSvg(toSVG(vectorize(img, o), o), img.width));
    expect(r.deltaE).toBeLessThan(0.4);
    expect(r.ssim).toBeGreaterThan(0.99);
  });
});

describe('teto de nós em texto e formas pequenas (vs. 6148de8; fidelidade tem prioridade)', () => {
  const run = (id: string) => {
    const c = CASES.find((x) => x.id === id)!;
    return vectorize(rasterize(c.svg), PRESETS.find((p) => p.id === c.preset)!.options);
  };
  it('texto: ≥ 20% menos nós que antes (984 → ≤ 790), mesmo com tolerância menor', () => expect(run('text').stats.nodes).toBeLessThanOrEqual(790));
  it('elipses/compactos: não mais que antes (59 → ≤ 66)', () => expect(run('ellipses').stats.nodes).toBeLessThanOrEqual(66));
  it('não existem micro-segmentos (< 0,75 px) em retas', () => {
    const d = run('text');
    let micro = 0;
    for (const l of d.layers) for (const p of l.paths) {
      let cur = p.start;
      for (const s of p.segs) { if (s.t === 'L' && Math.hypot(s.p.x - cur.x, s.p.y - cur.y) < 0.75 && p.segs.length > 3) micro++; cur = s.p; }
    }
    expect(micro).toBe(0);
  });
  it('DEFAULT_OPTIONS liga arcos e elipses', () => {
    expect(DEFAULT_OPTIONS.arcs && DEFAULT_OPTIONS.ellipses).toBe(true);
  });
});
