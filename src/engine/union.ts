import { loopArea, traceField } from './contour';
import { fitLoop } from './fit';
import { flattenPath, toCubicPath } from './geom';
import { rasterSpans } from './shapepaint';
import type { Pt, VPath } from './types';

const MAX_CELLS = 6e6;

/** dilatação/erosão por janela quadrada de raio r (separável) */
function morph(src: Uint8Array, w: number, h: number, r: number, dilate: boolean): Uint8Array {
  const pass = (a: Uint8Array, horizontal: boolean): Uint8Array => {
    const out = new Uint8Array(a.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let v = dilate ? 0 : 1;
      for (let d = -r; d <= r; d++) {
        const xx = horizontal ? x + d : x, yy = horizontal ? y : y + d;
        const q = xx < 0 || yy < 0 || xx >= w || yy >= h ? 0 : a[yy * w + xx];
        if (dilate ? q : !q) { v = dilate ? 1 : 0; break; }
      }
      out[y * w + x] = v;
    }
    return out;
  };
  return pass(pass(src, true), false);
}

/**
 * União geométrica de formas: cada forma (contorno + furos) é rasterizada numa grade fina (até 3×), as máscaras são
 * unidas (OR) e fechadas por 1 passo morfológico — assim formas vizinhas, sobrepostas ou separadas por uma fresta de
 * subpixel viram UM contorno, sem costuras —, e o resultado é traçado e reajustado com retas/arcos/Béziers.
 * Furos que continuam existindo na união são preservados; furos preenchidos por outra forma desaparecem.
 */
export function unionShapes(shapes: VPath[][]): VPath[] {
  const all = shapes.flat();
  if (!all.length) return [];
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of all) for (const q of flattenPath(p, 0.25)) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
  const pad = 4;
  const bw = x1 - x0 + 2 * pad, bh = y1 - y0 + 2 * pad;
  const S = Math.max(1, Math.min(3, Math.sqrt(MAX_CELLS / (bw * bh))));
  const W = Math.ceil(bw * S), H = Math.ceil(bh * S);
  const ox = x0 - pad, oy = y0 - pad;
  const mask = new Uint8Array(W * H);
  for (const sh of shapes) {
    const scaled: VPath[] = sh.map((p) => {
      const c = toCubicPath(p), m = (q: Pt): Pt => ({ x: (q.x - ox) * S, y: (q.y - oy) * S });
      return { start: m(c.start), segs: c.segs.map((s) => (s.t === 'L' ? { t: 'L' as const, p: m(s.p) } : { t: 'C' as const, c1: m(s.c1), c2: m(s.c2), p: m(s.p) })) };
    });
    const spans = rasterSpans(scaled, W, H);
    for (let k = 0; k < spans.length; k += 3) mask.fill(1, spans[k] * W + spans[k + 1], spans[k] * W + spans[k + 2] + 1);
  }
  const r = Math.max(1, Math.round(S * 0.6));
  const closed = morph(morph(mask, W, H, r, true), W, H, r, false);
  const out: VPath[] = [];
  for (const loop of traceField(closed, W, H, 0.8)) {
    const l = loop.map((q): Pt => ({ x: q.x / S + ox, y: q.y / S + oy }));
    if (Math.abs(loopArea(l)) < 2) continue;
    out.push(fitLoop(l, { tolerance: 0.4, cornerThreshold: 60, smooth: 2, arcs: true, ellipses: true }));
  }
  return out;
}
