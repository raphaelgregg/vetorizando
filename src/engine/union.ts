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

interface Grid { S: number; W: number; H: number; ox: number; oy: number }

/** grade fina que cobre `paths` (+ margem), com escala até 3× */
function gridFor(paths: VPath[]): Grid {
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of paths) for (const q of flattenPath(p, 0.25)) { if (q.x < x0) x0 = q.x; if (q.x > x1) x1 = q.x; if (q.y < y0) y0 = q.y; if (q.y > y1) y1 = q.y; }
  const pad = 4, bw = x1 - x0 + 2 * pad, bh = y1 - y0 + 2 * pad;
  const S = Math.max(1, Math.min(3, Math.sqrt(MAX_CELLS / (bw * bh))));
  return { S, W: Math.ceil(bw * S), H: Math.ceil(bh * S), ox: x0 - pad, oy: y0 - pad };
}

/** máscara (preenchimento ≠ 0) dos caminhos na grade */
function maskOf(paths: VPath[], g: Grid): Uint8Array {
  const m = (q: Pt): Pt => ({ x: (q.x - g.ox) * g.S, y: (q.y - g.oy) * g.S });
  const scaled: VPath[] = paths.map((p) => {
    const c = toCubicPath(p);
    return { start: m(c.start), segs: c.segs.map((s) => (s.t === 'L' ? { t: 'L' as const, p: m(s.p) } : { t: 'C' as const, c1: m(s.c1), c2: m(s.c2), p: m(s.p) })) };
  });
  const out = new Uint8Array(g.W * g.H);
  const spans = rasterSpans(scaled, g.W, g.H);
  for (let k = 0; k < spans.length; k += 3) out.fill(1, spans[k] * g.W + spans[k + 1], spans[k] * g.W + spans[k + 2] + 1);
  return out;
}

/** traça a máscara e reajusta com retas/arcos/Béziers, de volta ao espaço do documento */
function traceMask(mask: Uint8Array, g: Grid): VPath[] {
  const out: VPath[] = [];
  for (const loop of traceField(mask, g.W, g.H, 0.8)) {
    const l = loop.map((q): Pt => ({ x: q.x / g.S + g.ox, y: q.y / g.S + g.oy }));
    if (Math.abs(loopArea(l)) < 2) continue;
    out.push(fitLoop(l, { tolerance: 0.4, cornerThreshold: 60, smooth: 2, arcs: true, ellipses: true }));
  }
  return out;
}

/**
 * União geométrica de formas: cada forma (contorno + furos) é rasterizada numa grade fina (até 3×), as máscaras são
 * unidas (OR) com pontes locais (onde duas formas ficam a menos de ~1,8 px uma da outra) — assim formas vizinhas,
 * sobrepostas ou separadas por uma fresta de subpixel viram UM contorno, sem costuras e sem alterar o resto do
 * contorno —, e o resultado é traçado e reajustado com retas/arcos/Béziers.
 */
export function unionShapes(shapes: VPath[][]): VPath[] {
  const all = shapes.flat();
  if (!all.length) return [];
  const g = gridFor(all);
  const mask = new Uint8Array(g.W * g.H);
  const r = Math.max(1, Math.round(g.S * 0.9)); // ponte para frestas de até ~1,8 px
  const near = new Uint8Array(g.W * g.H); // quantas formas estão a ≤ r de cada célula
  for (const sh of shapes) {
    const own = maskOf(sh, g);
    for (let i = 0; i < own.length; i++) if (own[i]) mask[i] = 1;
    const grown = morph(own, g.W, g.H, r, true);
    for (let i = 0; i < grown.length; i++) near[i] += grown[i];
  }
  if (shapes.length > 1) for (let i = 0; i < mask.length; i++) if (near[i] >= 2) mask[i] = 1;
  return traceMask(mask, g);
}

/** `a` menos (subtract) ou ∩ (intersect) a união de `bs`. Resultado vazio = []. */
export function booleanOp(a: VPath[], bs: VPath[][], op: 'subtract' | 'intersect'): VPath[] {
  if (!a.length) return [];
  const g = gridFor(a);
  const A = maskOf(a, g), B = maskOf(bs.flat(), g);
  for (let i = 0; i < A.length; i++) A[i] = op === 'subtract' ? (A[i] && !B[i] ? 1 : 0) : A[i] && B[i] ? 1 : 0;
  return traceMask(A, g);
}

/**
 * Divide a forma pela reta que passa por `p0` e `p1` (estendida). Devolve as duas metades (lado esquerdo e direito
 * da reta orientada) ou null se a reta não atravessa a forma.
 */
export function splitByLine(paths: VPath[], p0: Pt, p1: Pt): [VPath[], VPath[]] | null {
  if (!paths.length || Math.hypot(p1.x - p0.x, p1.y - p0.y) < 1e-6) return null;
  const g = gridFor(paths), A = maskOf(paths, g);
  const L = new Uint8Array(A.length), R = new Uint8Array(A.length);
  let nl = 0, nr = 0;
  for (let y = 0; y < g.H; y++) for (let x = 0; x < g.W; x++) {
    const i = y * g.W + x;
    if (!A[i]) continue;
    const px = (x + 0.5) / g.S + g.ox, py = (y + 0.5) / g.S + g.oy;
    if ((p1.x - p0.x) * (py - p0.y) - (p1.y - p0.y) * (px - p0.x) > 0) { L[i] = 1; nl++; } else { R[i] = 1; nr++; }
  }
  if (nl < 4 * g.S * g.S || nr < 4 * g.S * g.S) return null; // um lado praticamente vazio
  const a = traceMask(L, g), b = traceMask(R, g);
  return a.length && b.length ? [a, b] : null;
}
