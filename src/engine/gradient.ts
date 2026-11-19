import { Lab, dist2, hex, rgbToLab } from './color';
import type { Gradient, GradientStop, Layer, VDoc } from './types';

/**
 * Detecção de gradientes lineares/radiais sobre os rótulos já quantizados.
 *
 * Ideia: um gradiente suave vira VÁRIAS bandas após a quantização. Bandas vizinhas cujo contato é "suave"
 * (diferença média entre pixels adjacentes pequena, sem saltos grandes) são agrupadas; cada grupo é ajustado por
 * um perfil 1-D (linear: projeção numa direção; radial: distância a um centro) com stops simplificados.
 * Guarda de fidelidade: só aceita se o modelo reproduz a imagem tão bem quanto as bandas sólidas e se não é
 * um degrau disfarçado. Bordas duras, texto, hairlines e áreas planas nunca formam grupo (contato com saltos).
 */

export interface GradientGroup {
  comps: number[]; // componentes (4-conexas) do grupo
  gradient: Gradient;
}

export interface GradientAnalysis {
  comp: Int32Array; // componente de cada pixel (-1 = transparente/fundo removido)
  compLabel: Int32Array;
  groups: GradientGroup[];
}

const MIN_AREA = 800;
const MAX_SAMPLES = 15000;
const BINS = 48;

const hexOf = (c: number[]) => hex(c[0], c[1], c[2]);

interface Samples { n: number; x: Float32Array; y: Float32Array; rgb: Float32Array; lab: Lab[]; band: Lab[] }

interface Profile { resid: number; tmin: number; tmax: number; mean: Float64Array; cnt: Float64Array }

function profile(s: Samples, t: Float32Array): Profile {
  let tmin = Infinity, tmax = -Infinity;
  for (let i = 0; i < s.n; i++) { if (t[i] < tmin) tmin = t[i]; if (t[i] > tmax) tmax = t[i]; }
  const span = Math.max(1e-6, tmax - tmin);
  const sum = new Float64Array(BINS * 3), cnt = new Float64Array(BINS);
  const bin = (v: number) => Math.min(BINS - 1, Math.floor(((v - tmin) / span) * BINS));
  for (let i = 0; i < s.n; i++) { const b = bin(t[i]); cnt[b]++; for (let c = 0; c < 3; c++) sum[b * 3 + c] += s.rgb[i * 3 + c]; }
  const mean = new Float64Array(BINS * 3);
  for (let b = 0; b < BINS; b++) if (cnt[b]) for (let c = 0; c < 3; c++) mean[b * 3 + c] = sum[b * 3 + c] / cnt[b];
  let r = 0;
  for (let i = 0; i < s.n; i++) { const b = bin(t[i]); for (let c = 0; c < 3; c++) { const d = s.rgb[i * 3 + c] - mean[b * 3 + c]; r += d * d; } }
  return { resid: r / s.n, tmin, tmax, mean, cnt };
}

interface Model { kind: 'linear' | 'radial'; resid: number; prof: Profile; a: number; b: number; c: number }

function fitLinear(s: Samples): Model {
  const t = new Float32Array(s.n);
  const run = (th: number) => {
    const cx = Math.cos(th), cy = Math.sin(th);
    for (let i = 0; i < s.n; i++) t[i] = s.x[i] * cx + s.y[i] * cy;
    return profile(s, t);
  };
  let best = { th: 0, p: run(0) };
  for (let k = 1; k < 12; k++) { const th = (k * Math.PI) / 12, p = run(th); if (p.resid < best.p.resid) best = { th, p }; }
  for (const step of [7.5, 3, 1, 0.4]) {
    for (const sgn of [-1, 1]) { const th = best.th + (sgn * step * Math.PI) / 180, p = run(th); if (p.resid < best.p.resid) best = { th, p }; }
  }
  return { kind: 'linear', resid: best.p.resid, prof: best.p, a: best.th, b: 0, c: 0 };
}

function fitRadial(s: Samples, bbox: number[]): Model {
  const t = new Float32Array(s.n);
  const run = (cx: number, cy: number) => {
    for (let i = 0; i < s.n; i++) t[i] = Math.hypot(s.x[i] - cx, s.y[i] - cy);
    return profile(s, t);
  };
  const [x0, y0, x1, y1] = bbox, pw = (x1 - x0) * 0.25, ph = (y1 - y0) * 0.25;
  let best = { cx: (x0 + x1) / 2, cy: (y0 + y1) / 2, p: null as unknown as Profile };
  best.p = run(best.cx, best.cy);
  for (let i = 0; i < 5; i++) for (let j = 0; j < 5; j++) {
    const cx = x0 - pw + ((x1 - x0 + 2 * pw) * i) / 4, cy = y0 - ph + ((y1 - y0 + 2 * ph) * j) / 4, p = run(cx, cy);
    if (p.resid < best.p.resid) best = { cx, cy, p };
  }
  let step = Math.max(x1 - x0, y1 - y0) / 6;
  for (let it = 0; it < 7; it++, step /= 2) {
    let improved = true;
    while (improved) {
      improved = false;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
        const cx = best.cx + dx * step, cy = best.cy + dy * step, p = run(cx, cy);
        if (p.resid < best.p.resid * 0.999) { best = { cx, cy, p }; improved = true; }
      }
    }
  }
  return { kind: 'radial', resid: best.p.resid, prof: best.p, a: best.cx, b: best.cy, c: 0 };
}

interface Knot { t: number; c: number[] }

/** Ramer–Douglas–Peucker no perfil de cor (erro = maior desvio por canal da interpolação). */
function simplify(k: Knot[], tol: number): Knot[] {
  const keep = new Uint8Array(k.length);
  keep[0] = keep[k.length - 1] = 1;
  const rec = (a: number, b: number) => {
    let worst = -1, wd = tol;
    for (let i = a + 1; i < b; i++) {
      const f = (k[i].t - k[a].t) / Math.max(1e-9, k[b].t - k[a].t);
      let d = 0;
      for (let c = 0; c < 3; c++) d = Math.max(d, Math.abs(k[i].c[c] - (k[a].c[c] + f * (k[b].c[c] - k[a].c[c]))));
      if (d > wd) { wd = d; worst = i; }
    }
    if (worst >= 0) { keep[worst] = 1; rec(a, worst); rec(worst, b); }
  };
  rec(0, k.length - 1);
  return k.filter((_, i) => keep[i]);
}

function evalKnots(k: Knot[], t: number, out: number[]): void {
  if (t <= k[0].t) { for (let c = 0; c < 3; c++) out[c] = k[0].c[c]; return; }
  const L = k.length - 1;
  if (t >= k[L].t) { for (let c = 0; c < 3; c++) out[c] = k[L].c[c]; return; }
  let i = 0;
  while (i < L - 1 && k[i + 1].t < t) i++;
  const f = (t - k[i].t) / Math.max(1e-9, k[i + 1].t - k[i].t);
  for (let c = 0; c < 3; c++) out[c] = k[i].c[c] + f * (k[i + 1].c[c] - k[i].c[c]);
}

/** Ajusta linear e radial a um conjunto de amostras e aplica a guarda de fidelidade. null = rejeitado. */
function fitGroup(s: Samples, bbox: number[]): Gradient | null {
  if (s.n < 300) return null;
  const lin = fitLinear(s), rad = fitRadial(s, bbox);
  const m = rad.resid < lin.resid * 0.85 ? rad : lin;
  const p = m.prof, span = Math.max(1e-6, p.tmax - p.tmin);
  let knots: Knot[] = [];
  for (let b = 0; b < BINS; b++) if (p.cnt[b]) knots.push({ t: p.tmin + ((b + 0.5) / BINS) * span, c: [p.mean[b * 3], p.mean[b * 3 + 1], p.mean[b * 3 + 2]] });
  if (knots.length < 6) return null;
  // degrau disfarçado: o maior salto entre perfis vizinhos não pode concentrar a variação de cor
  const labs = knots.map((q) => rgbToLab(q.c[0], q.c[1], q.c[2]));
  let range = 0, jump = 0;
  for (let i = 0; i < labs.length; i++) {
    range = Math.max(range, Math.sqrt(dist2(labs[0], labs[i])));
    if (i) jump = Math.max(jump, Math.sqrt(dist2(labs[i - 1], labs[i])));
  }
  if (range < 5 || jump > 0.35 * range) return null;
  let tol = 2;
  let st = simplify(knots, tol);
  while (st.length > 12) st = simplify(knots, (tol *= 1.5));
  knots = st;
  // guarda: o modelo tem de igualar ou superar as bandas sólidas (ΔE76 médio) e ser bom em termos absolutos
  const rgb = [0, 0, 0];
  let eg = 0, eb = 0;
  for (let i = 0; i < s.n; i++) {
    const tt = m.kind === 'linear'
      ? s.x[i] * Math.cos(m.a) + s.y[i] * Math.sin(m.a)
      : Math.hypot(s.x[i] - m.a, s.y[i] - m.b);
    evalKnots(knots, tt, rgb);
    eg += Math.sqrt(dist2(s.lab[i], rgbToLab(rgb[0], rgb[1], rgb[2])));
    eb += Math.sqrt(dist2(s.lab[i], s.band[i]));
  }
  eg /= s.n; eb /= s.n;
  if (eg > eb + 0.1 || eg > 3.5) return null;
  if (m.kind === 'linear') {
    const dx = Math.cos(m.a), dy = Math.sin(m.a);
    const stops: GradientStop[] = knots.map((q) => ({ offset: Math.round(((q.t - p.tmin) / span) * 1e4) / 1e4, color: hexOf(q.c) }));
    return { kind: 'linear', x1: dx * p.tmin, y1: dy * p.tmin, x2: dx * p.tmax, y2: dy * p.tmax, stops };
  }
  const stops: GradientStop[] = knots.map((q) => ({ offset: Math.round((q.t / p.tmax) * 1e4) / 1e4, color: hexOf(q.c) }));
  return { kind: 'radial', cx: m.a, cy: m.b, r: p.tmax, stops };
}

/**
 * Procura gradientes. `rgb` = imagem (filtrada) RGBA; `skip` marca pixels de transição (anti-aliasing) que não entram
 * como amostra. `bg` = rótulo do fundo removido (-1 se nenhum).
 */
export function analyzeGradients(rgba: Uint8ClampedArray, labels: Int16Array, palette: [number, number, number][], skip: Uint8Array, w: number, h: number, bg: number): GradientAnalysis {
  const n = w * h;
  const comp = new Int32Array(n).fill(-1);
  const compLabel: number[] = [], compArea: number[] = [];
  const stack: number[] = [];
  for (let i = 0; i < n; i++) {
    const l = labels[i];
    if (l < 0 || l === bg || comp[i] >= 0) continue;
    const id = compLabel.length;
    compLabel.push(l);
    let a = 0;
    comp[i] = id; stack.push(i);
    while (stack.length) {
      const p = stack.pop()!, x = p % w, y = (p / w) | 0;
      a++;
      if (x > 0 && comp[p - 1] < 0 && labels[p - 1] === l) { comp[p - 1] = id; stack.push(p - 1); }
      if (x < w - 1 && comp[p + 1] < 0 && labels[p + 1] === l) { comp[p + 1] = id; stack.push(p + 1); }
      if (y > 0 && comp[p - w] < 0 && labels[p - w] === l) { comp[p - w] = id; stack.push(p - w); }
      if (y < h - 1 && comp[p + w] < 0 && labels[p + w] === l) { comp[p + w] = id; stack.push(p + w); }
    }
    compArea.push(a);
  }
  const nc = compLabel.length;
  const res: GradientAnalysis = { comp, compLabel: Int32Array.from(compLabel), groups: [] };
  if (nc < 2) return res;

  // contato entre componentes vizinhas: diferença de cor entre pixels adjacentes
  const pairs = new Map<number, [number, number, number]>(); // soma, contagem, saltos grandes
  const touch = (p: number, q: number) => {
    const a = comp[p], b = comp[q];
    if (a < 0 || b < 0 || a === b) return;
    const d = Math.hypot(rgba[p * 4] - rgba[q * 4], rgba[p * 4 + 1] - rgba[q * 4 + 1], rgba[p * 4 + 2] - rgba[q * 4 + 2]);
    const key = a < b ? a * nc + b : b * nc + a;
    let e = pairs.get(key);
    if (!e) pairs.set(key, (e = [0, 0, 0]));
    e[0] += d; e[1]++; if (d > 24) e[2]++;
  };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const p = y * w + x;
    if (x < w - 1) touch(p, p + 1);
    if (y < h - 1) touch(p, p + w);
  }
  const parent = Array.from({ length: nc }, (_, i) => i);
  const find = (i: number): number => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const [key, [sum, cnt, big]] of pairs) {
    if (cnt < 6 || sum / cnt > 10 || big / cnt > 0.08) continue;
    parent[find(Math.floor(key / nc))] = find(key % nc);
  }
  const classes = new Map<number, number[]>();
  for (let c = 0; c < nc; c++) { const r = find(c); classes.set(r, [...(classes.get(r) ?? []), c]); }

  const labCache = palette.map((c) => rgbToLab(c[0], c[1], c[2]));
  for (const members of classes.values()) {
    if (members.length < 2) continue;
    let area = 0;
    for (const c of members) area += compArea[c];
    if (area < MIN_AREA) continue;
    const inClass = new Uint8Array(nc);
    for (const c of members) inClass[c] = 1;
    const stride = Math.max(1, Math.ceil(area / MAX_SAMPLES));
    const xs: number[] = [], ys: number[] = [], rgbs: number[] = [], labs: Lab[] = [], bands: Lab[] = [];
    let k = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (let i = 0; i < n; i++) {
      const c = comp[i];
      if (c < 0 || !inClass[c]) continue;
      const x = i % w, y = (i / w) | 0;
      if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y;
      if (skip[i] || k++ % stride) continue;
      xs.push(x + 0.5); ys.push(y + 0.5);
      const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
      rgbs.push(r, g, b); labs.push(rgbToLab(r, g, b)); bands.push(labCache[labels[i]]);
    }
    const s: Samples = { n: xs.length, x: Float32Array.from(xs), y: Float32Array.from(ys), rgb: Float32Array.from(rgbs), lab: labs, band: bands };
    const g = fitGroup(s, [x0, y0, x1 + 1, y1 + 1]);
    if (g) res.groups.push({ comps: members, gradient: g });
  }
  return res;
}

/** Documento só com cores sólidas: camadas com gradiente são trocadas por suas bandas equivalentes. */
export function flattenGradients(doc: VDoc): VDoc {
  if (!doc.layers.some((l) => l.gradient)) return doc;
  const layers: Layer[] = [];
  for (const l of doc.layers) {
    if (l.gradient && l.fallback) layers.push(...l.fallback); else layers.push({ color: l.color, paths: l.paths });
  }
  return { ...doc, layers };
}
