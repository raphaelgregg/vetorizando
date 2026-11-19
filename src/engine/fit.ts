import type { Pt, Seg, VPath } from './types';

const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const add = (a: Pt, b: Pt): Pt => ({ x: a.x + b.x, y: a.y + b.y });
const mul = (a: Pt, s: number): Pt => ({ x: a.x * s, y: a.y * s });
const dot = (a: Pt, b: Pt) => a.x * b.x + a.y * b.y;
const len = (a: Pt) => Math.hypot(a.x, a.y);
const norm = (a: Pt): Pt => {
  const l = len(a);
  return l < 1e-12 ? { x: 0, y: 0 } : { x: a.x / l, y: a.y / l };
};

type Bez = [Pt, Pt, Pt, Pt];

function bezAt(b: Bez, t: number): Pt {
  const m = 1 - t;
  const b0 = m * m * m, b1 = 3 * m * m * t, b2 = 3 * m * t * t, b3 = t * t * t;
  return {
    x: b0 * b[0].x + b1 * b[1].x + b2 * b[2].x + b3 * b[3].x,
    y: b0 * b[0].y + b1 * b[1].y + b2 * b[2].y + b3 * b[3].y,
  };
}

function bezD1(b: Bez, t: number): Pt {
  const m = 1 - t;
  return {
    x: 3 * m * m * (b[1].x - b[0].x) + 6 * m * t * (b[2].x - b[1].x) + 3 * t * t * (b[3].x - b[2].x),
    y: 3 * m * m * (b[1].y - b[0].y) + 6 * m * t * (b[2].y - b[1].y) + 3 * t * t * (b[3].y - b[2].y),
  };
}

function bezD2(b: Bez, t: number): Pt {
  const m = 1 - t;
  return {
    x: 6 * m * (b[2].x - 2 * b[1].x + b[0].x) + 6 * t * (b[3].x - 2 * b[2].x + b[1].x),
    y: 6 * m * (b[2].y - 2 * b[1].y + b[0].y) + 6 * t * (b[3].y - 2 * b[2].y + b[1].y),
  };
}

function chordParam(pts: Pt[]): number[] {
  const u = [0];
  for (let i = 1; i < pts.length; i++) u.push(u[i - 1] + len(sub(pts[i], pts[i - 1])));
  const t = u[u.length - 1] || 1;
  return u.map((v) => v / t);
}

function generate(pts: Pt[], u: number[], t1: Pt, t2: Pt): Bez {
  const p0 = pts[0], p3 = pts[pts.length - 1];
  let c00 = 0, c01 = 0, c11 = 0, x0 = 0, x1 = 0;
  for (let i = 0; i < pts.length; i++) {
    const m = 1 - u[i];
    const b0 = m * m * m, b1 = 3 * u[i] * m * m, b2 = 3 * u[i] * u[i] * m, b3 = u[i] ** 3;
    const a1 = mul(t1, b1), a2 = mul(t2, b2);
    c00 += dot(a1, a1); c01 += dot(a1, a2); c11 += dot(a2, a2);
    const tmp = sub(pts[i], add(mul(p0, b0 + b1), mul(p3, b2 + b3)));
    x0 += dot(a1, tmp); x1 += dot(a2, tmp);
  }
  const det = c00 * c11 - c01 * c01;
  let aL = det === 0 ? 0 : (x0 * c11 - x1 * c01) / det;
  let aR = det === 0 ? 0 : (c00 * x1 - c01 * x0) / det;
  const seg = len(sub(p3, p0));
  if (aL < 1e-6 * seg || aR < 1e-6 * seg) aL = aR = seg / 3;
  return [p0, add(p0, mul(t1, aL)), add(p3, mul(t2, aR)), p3];
}

function reparam(b: Bez, pts: Pt[], u: number[]): number[] {
  return u.map((t, i) => {
    const d = sub(bezAt(b, t), pts[i]);
    const d1 = bezD1(b, t), d2 = bezD2(b, t);
    const num = dot(d, d1), den = dot(d1, d1) + dot(d, d2);
    return den === 0 ? t : Math.min(1, Math.max(0, t - num / den));
  });
}

function maxErr(b: Bez, pts: Pt[], u: number[]): { err: number; at: number } {
  let err = 0, at = Math.floor(pts.length / 2);
  for (let i = 1; i < pts.length - 1; i++) {
    const d = sub(bezAt(b, u[i]), pts[i]);
    const e = dot(d, d);
    if (e >= err) { err = e; at = i; }
  }
  return { err, at };
}

/** Ajuste de Bézier cúbica por mínimos quadrados (Schneider) com divisão recursiva. */
function fitCubic(pts: Pt[], t1: Pt, t2: Pt, tol: number, out: Seg[], depth = 0): void {
  const p0 = pts[0], p3 = pts[pts.length - 1];
  if (pts.length === 2) {
    const d = len(sub(p3, p0)) / 3;
    out.push({ t: 'C', c1: add(p0, mul(t1, d)), c2: add(p3, mul(t2, d)), p: p3 });
    return;
  }
  let u = chordParam(pts);
  let b = generate(pts, u, t1, t2);
  let { err, at } = maxErr(b, pts, u);
  const tol2 = tol * tol;
  if (err < tol2) { out.push({ t: 'C', c1: b[1], c2: b[2], p: p3 }); return; }
  if (err < tol2 * 16) {
    for (let i = 0; i < 4; i++) {
      u = reparam(b, pts, u);
      b = generate(pts, u, t1, t2);
      ({ err, at } = maxErr(b, pts, u));
      if (err < tol2) { out.push({ t: 'C', c1: b[1], c2: b[2], p: p3 }); return; }
    }
  }
  if (depth > 24 || pts.length < 4) { out.push({ t: 'C', c1: b[1], c2: b[2], p: p3 }); return; }
  at = Math.min(Math.max(at, 1), pts.length - 2);
  const tc = norm(sub(pts[at - 1], pts[at + 1]));
  fitCubic(pts.slice(0, at + 1), t1, tc, tol, out, depth + 1);
  fitCubic(pts.slice(at), mul(tc, -1), t2, tol, out, depth + 1);
}

function maxLineDist(pts: Pt[]): number {
  const a = pts[0], b = pts[pts.length - 1];
  const d = sub(b, a), l = len(d);
  let m = 0;
  for (let i = 1; i < pts.length - 1; i++) {
    const v = sub(pts[i], a);
    const dist = l < 1e-9 ? len(v) : Math.abs(v.x * d.y - v.y * d.x) / l;
    if (dist > m) m = dist;
  }
  return m;
}

function detectCorners(p: Pt[], thresholdDeg: number, k: number): number[] {
  const n = p.length;
  const kk = Math.min(k, Math.floor(n / 4));
  if (kk < 1) return [];
  const ang = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const a = sub(p[i], p[(i - kk + n) % n]);
    const b = sub(p[(i + kk) % n], p[i]);
    const la = len(a), lb = len(b);
    ang[i] = la && lb ? (Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (la * lb)))) * 180) / Math.PI : 0;
  }
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    if (ang[i] < thresholdDeg) continue;
    let peak = true;
    for (let j = 1; j <= kk && peak; j++) {
      if (ang[(i + j) % n] > ang[i] || ang[(i - j + n) % n] >= ang[i]) peak = false;
    }
    if (peak) corners.push(i);
  }
  return corners;
}

function smoothPoints(p: Pt[], corners: number[], radius: number): Pt[] {
  const n = p.length;
  if (radius < 1) return p;
  const isCorner = new Uint8Array(n);
  for (const c of corners) isCorner[c] = 1;
  // distância circular até o canto mais próximo
  const dist = new Int32Array(n).fill(n);
  if (corners.length) {
    for (let pass = 0; pass < 2; pass++) {
      for (let i = 0; i < 2 * n; i++) {
        const idx = i % n, prev = (idx - 1 + n) % n;
        dist[idx] = isCorner[idx] ? 0 : Math.min(dist[idx], dist[prev] + 1);
      }
      for (let i = 2 * n - 1; i >= 0; i--) {
        const idx = i % n, next = (idx + 1) % n;
        dist[idx] = isCorner[idx] ? 0 : Math.min(dist[idx], dist[next] + 1);
      }
    }
  }
  const res: Pt[] = new Array(n);
  for (let i = 0; i < n; i++) {
    const r = Math.min(radius, dist[i] - 1);
    if (isCorner[i] || r < 1) { res[i] = p[i]; continue; }
    let sx = 0, sy = 0;
    for (let j = -r; j <= r; j++) {
      const q = p[(i + j + n) % n];
      sx += q.x; sy += q.y;
    }
    const c = 2 * r + 1;
    res[i] = { x: sx / c, y: sy / c };
  }
  return res;
}

function segmentPath(pts: Pt[], tol: number, out: Seg[]): void {
  if (pts.length < 2) return;
  if (pts.length === 2 || maxLineDist(pts) <= tol) {
    out.push({ t: 'L', p: pts[pts.length - 1] });
    return;
  }
  const k = Math.min(4, pts.length - 1);
  const t1 = norm(sub(pts[k], pts[0]));
  const t2 = norm(sub(pts[pts.length - 1 - k], pts[pts.length - 1]));
  fitCubic(pts, t1, t2, tol, out);
}

export interface FitOptions {
  tolerance: number;
  cornerThreshold: number;
  smooth: number;
}

/** Converte um contorno denso (vértices de grade) em caminho com retas e Béziers cúbicas. */
export function fitLoop(loop: Pt[], o: FitOptions): VPath {
  // remove vértices repetidos consecutivos
  const p = loop.filter((q, i) => i === 0 || q.x !== loop[i - 1].x || q.y !== loop[i - 1].y);
  const n = p.length;
  if (n < 4) return { start: p[0], segs: p.slice(1).map((q) => ({ t: 'L', p: q })) };
  const corners = detectCorners(p, o.cornerThreshold, 4);
  const s = smoothPoints(p, corners, Math.round(o.smooth));
  const segs: Seg[] = [];
  if (corners.length === 0) {
    const pts = [...s, s[0]];
    const t1 = norm(sub(s[1], s[n - 1]));
    const tol = o.tolerance;
    fitCubic(pts, t1, mul(t1, -1), tol, segs);
    return { start: s[0], segs };
  }
  for (let c = 0; c < corners.length; c++) {
    const a = corners[c], b = corners[(c + 1) % corners.length];
    const part: Pt[] = [];
    for (let i = a; ; i = (i + 1) % n) {
      part.push(s[i]);
      if (i === b && part.length > 1) break;
      if (part.length > n + 1) break;
    }
    segmentPath(part, o.tolerance, segs);
  }
  return { start: s[corners[0]], segs };
}
