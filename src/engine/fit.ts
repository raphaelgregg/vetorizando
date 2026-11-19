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

function detectCorners(p: Pt[], thresholdDeg: number, k: number): { corners: number[]; ang: Float64Array } {
  const n = p.length;
  const kk = Math.min(k, Math.floor(n / 4));
  const ang = new Float64Array(n);
  if (kk < 1) return { corners: [], ang };
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
  return { corners, ang };
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
  // duas passagens de média móvel (≈ triangular), sem atravessar cantos
  let cur = p;
  const r0 = Math.max(1, Math.round(radius * 0.7));
  for (let pass = 0; pass < 2; pass++) {
    const res: Pt[] = new Array(n);
    for (let i = 0; i < n; i++) {
      const r = Math.min(r0, dist[i] - 1);
      if (isCorner[i] || r < 1) { res[i] = cur[i]; continue; }
      let sx = 0, sy = 0;
      for (let j = -r; j <= r; j++) {
        const q = cur[(i + j + n) % n];
        sx += q.x; sy += q.y;
      }
      const c = 2 * r + 1;
      res[i] = { x: sx / c, y: sy / c };
    }
    cur = res;
  }
  return cur;
}

function lineOk(P: Pt[], s: number, e: number, tol: number): boolean {
  const a = P[s], b = P[e];
  const d = sub(b, a), l2 = dot(d, d);
  for (let i = s + 1; i < e; i++) {
    const v = sub(P[i], a);
    const t = l2 < 1e-12 ? 0 : Math.min(1, Math.max(0, dot(v, d) / l2));
    if (Math.hypot(v.x - d.x * t, v.y - d.y * t) > tol) return false;
  }
  return true;
}

interface ArcFit { seg: Seg; tOut: Pt }

/** Arco circular ligando P[s]→P[e] (extremos exatos), validado contra todos os pontos. */
function arcFit(P: Pt[], s: number, e: number, tol: number): ArcFit | null {
  const n = e - s + 1;
  if (n < 4) return null;
  let mx = 0, my = 0;
  for (let i = s; i <= e; i++) { mx += P[i].x; my += P[i].y; }
  mx /= n; my /= n;
  let suu = 0, suv = 0, svv = 0, suuu = 0, svvv = 0, suvv = 0, svuu = 0;
  for (let i = s; i <= e; i++) {
    const u = P[i].x - mx, v = P[i].y - my;
    suu += u * u; suv += u * v; svv += v * v; suuu += u * u * u; svvv += v * v * v; suvv += u * v * v; svuu += v * u * u;
  }
  const det = suu * svv - suv * suv;
  if (Math.abs(det) < 1e-9) return null;
  const r1 = 0.5 * (suuu + suvv), r2 = 0.5 * (svvv + svuu);
  const uc = (r1 * svv - r2 * suv) / det, vc = (r2 * suu - r1 * suv) / det;
  const fx = mx + uc, fy = my + vc;
  let r = Math.sqrt(uc * uc + vc * vc + (suu + svv) / n);
  if (!isFinite(r) || r > 1e5) return null;
  const A = P[s], B = P[e];
  const c = len(sub(B, A));
  if (c < 1e-9) return null;
  if (r < c / 2) r = c / 2;
  const h = Math.sqrt(Math.max(0, r * r - (c * c) / 4));
  const mid = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
  const nrm = { x: -(B.y - A.y) / c, y: (B.x - A.x) / c };
  const c1 = { x: mid.x + nrm.x * h, y: mid.y + nrm.y * h }, c2 = { x: mid.x - nrm.x * h, y: mid.y - nrm.y * h };
  const C = Math.hypot(c1.x - fx, c1.y - fy) <= Math.hypot(c2.x - fx, c2.y - fy) ? c1 : c2;
  let total = 0, prev = Math.atan2(A.y - C.y, A.x - C.x), sign = 0;
  for (let i = s; i <= e; i++) {
    if (Math.abs(Math.hypot(P[i].x - C.x, P[i].y - C.y) - r) > tol) return null;
    if (i === s) continue;
    const a = Math.atan2(P[i].y - C.y, P[i].x - C.x);
    let d = a - prev;
    while (d > Math.PI) d -= 2 * Math.PI;
    while (d <= -Math.PI) d += 2 * Math.PI;
    if (Math.abs(d) > 1e-9) {
      if (sign === 0) sign = Math.sign(d);
      else if (Math.sign(d) !== sign) return null; // não monotônico
    }
    total += d;
    prev = a;
  }
  const span = Math.abs(total);
  if (span < 0.05 || span > 5.6) return null;
  const sweep: 0 | 1 = total > 0 ? 1 : 0;
  const rad = norm(sub(B, C));
  const tOut = sweep ? { x: -rad.y, y: rad.x } : { x: rad.y, y: -rad.x };
  return { seg: { t: 'A', r, large: span > Math.PI ? 1 : 0, sweep, p: B }, tOut };
}

function cubicFit(P: Pt[], s: number, e: number, t1: Pt, t2: Pt, tol: number): Bez | null {
  const pts = P.slice(s, e + 1);
  if (pts.length < 3) return null;
  let u = chordParam(pts);
  let b = generate(pts, u, t1, t2);
  let { err } = maxErr(b, pts, u);
  const tol2 = tol * tol;
  for (let i = 0; i < 4 && err >= tol2; i++) {
    u = reparam(b, pts, u);
    b = generate(pts, u, t1, t2);
    ({ err } = maxErr(b, pts, u));
  }
  return err < tol2 ? b : null;
}

/** Maior e em [minE, maxE] com ok(e) (galope + busca binária); -1 se ok(minE) falha. */
function extent(ok: (e: number) => boolean, minE: number, maxE: number): number {
  if (minE > maxE || !ok(minE)) return -1;
  let lo = minE, hi = minE, step = 2;
  while (hi < maxE) {
    const nx = Math.min(maxE, hi + step);
    if (ok(nx)) { lo = nx; hi = nx; step *= 2; } else { hi = nx; break; }
  }
  if (lo >= maxE || hi === lo) return lo;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (ok(m)) lo = m; else hi = m;
  }
  return lo;
}

/**
 * Cobre a sequência de pontos com o MENOR número de primitivas: a cada passo estende
 * o trecho o máximo possível com reta, arco ou Bézier cúbica (continuidade G1 entre elas).
 */
function fitRun(P: Pt[], tStart: Pt, tEnd: Pt, tol: number, arcs: boolean): Seg[] {
  const m = P.length;
  const out: Seg[] = [];
  const tAt = (k: number) => (k >= m - 1 ? tEnd : norm(sub(P[Math.min(k + 2, m - 1)], P[Math.max(k - 2, 0)])));
  let s = 0, tIn = tStart;
  while (s < m - 1) {
    const last = m - 1;
    let kind: 'L' | 'A' | 'C' = 'L';
    let e = extent((x) => lineOk(P, s, x, tol), s + 1, last);
    if (e < last && arcs) {
      const ea = extent((x) => arcFit(P, s, x, tol) !== null, s + 3, last);
      if (ea > e + 1) { e = ea; kind = 'A'; }
    }
    if (e < last) {
      const ec = extent((x) => cubicFit(P, s, x, tIn, mul(tAt(x), -1), tol) !== null, s + 2, last);
      if (ec > e + 2) { e = ec; kind = 'C'; }
    }
    if (kind === 'A') {
      const f = arcFit(P, s, e, tol)!;
      out.push(f.seg); tIn = f.tOut;
    } else if (kind === 'C') {
      const b = cubicFit(P, s, e, tIn, mul(tAt(e), -1), tol)!;
      out.push({ t: 'C', c1: b[1], c2: b[2], p: b[3] });
      tIn = norm(sub(b[3], b[2]));
    } else {
      out.push({ t: 'L', p: P[e] });
      tIn = norm(sub(P[e], P[s]));
    }
    s = e;
  }
  return out;
}

export interface FitOptions {
  tolerance: number;
  cornerThreshold: number;
  smooth: number;
  arcs: boolean;
}

/** Converte um contorno denso em caminho com retas, arcos e Béziers cúbicas. */
export function fitLoop(loop: Pt[], o: FitOptions): VPath {
  const p = loop.filter((q, i) => i === 0 || q.x !== loop[i - 1].x || q.y !== loop[i - 1].y);
  if (p.length > 1 && p[0].x === p[p.length - 1].x && p[0].y === p[p.length - 1].y) p.pop();
  const n = p.length;
  if (n < 4) return { start: p[0], segs: p.slice(1).map((q) => ({ t: 'L' as const, p: q })) };
  const { corners, ang } = detectCorners(p, o.cornerThreshold, 4);
  const s = smoothPoints(p, corners, Math.round(o.smooth));
  if (corners.length === 0) {
    let a0 = 0;
    for (let i = 1; i < n; i++) if (ang[i] > ang[a0]) a0 = i;
    const r = [...s.slice(a0), ...s.slice(0, a0)];
    const t = norm(sub(r[2 % n], r[n - 2]));
    return { start: r[0], segs: fitRun([...r, r[0]], t, t, o.tolerance, o.arcs) };
  }
  const segs: Seg[] = [];
  for (let c = 0; c < corners.length; c++) {
    const a = corners[c], b = corners[(c + 1) % corners.length];
    const part: Pt[] = [];
    for (let i = a; ; i = (i + 1) % n) {
      part.push(s[i]);
      if (i === b && part.length > 1) break;
      if (part.length > n + 1) break;
    }
    const m = part.length;
    const t1 = norm(sub(part[Math.min(3, m - 1)], part[0]));
    const t2 = norm(sub(part[m - 1], part[Math.max(m - 4, 0)]));
    segs.push(...fitRun(part, t1, t2, o.tolerance, o.arcs));
  }
  return { start: s[corners[0]], segs };
}
