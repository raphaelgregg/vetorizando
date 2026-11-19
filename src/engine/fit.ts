import { ellipseGeom } from './geom';
import { fitEllipse } from './ellipse';
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

function turnAngle(q: Pt[], i: number, k: number): number {
  const n = q.length;
  const a = sub(q[i], q[(i - k + n * 4) % n]);
  const b = sub(q[(i + k) % n], q[i]);
  const la = len(a), lb = len(b);
  return la && lb ? (Math.acos(Math.max(-1, Math.min(1, dot(a, b) / (la * lb)))) * 180) / Math.PI : 0;
}

/**
 * Cantos por ângulo em duas escalas (k e 2k) sobre pontos levemente suavizados: num canto
 * verdadeiro o ângulo persiste nas duas escalas; numa curva fechada ele dobra com a escala.
 * Evita falsos cantos em curvas pequenas e no ruído.
 */
function detectCorners(p: Pt[], thresholdDeg: number, k: number, light = true, ratioTest = true): { corners: number[]; ang: Float64Array } {
  const n = p.length;
  const ang = new Float64Array(n);
  const kk = Math.min(k, Math.floor(n / 6));
  if (kk < 2) return { corners: [], ang };
  const q = !light ? p : p.map((_, i) => {
    const a = p[(i - 1 + n) % n], b = p[(i + 1) % n];
    return { x: (a.x + p[i].x + b.x) / 3, y: (a.y + p[i].y + b.y) / 3 };
  });
  const wide = ratioTest && 2 * kk < n / 2; // em traço fino a janela 2k abrange a feature inteira: sem teste de razão
  const ang2 = new Float64Array(n);
  for (let i = 0; i < n; i++) { ang[i] = turnAngle(q, i, kk); if (wide) ang2[i] = turnAngle(q, i, 2 * kk); }
  const corners: number[] = [];
  for (let i = 0; i < n; i++) {
    if (ang[i] < thresholdDeg) continue;
    if (wide && ang2[i] > 1.45 * ang[i]) continue; // curva, não canto
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

/** Arco elíptico P[s]→P[e]: elipse ajustada (Halir–Flusser) + extremos exatos, validada ponto a ponto. */
function ellipseArcFit(P: Pt[], s: number, e: number, tol: number): ArcFit | null {
  const f = fitEllipse(P, s, e);
  if (!f) return null;
  const big = Math.max(f.rx, f.ry), small = Math.min(f.rx, f.ry);
  if (small < 0.8 || big > 1e4 || big / small > 40 || (big - small) / big < 0.06) return null;
  // sentido e abertura pela fase paramétrica em torno do centro ajustado
  const phase = (x: number, y: number, c: Pt, rx: number, ry: number, ph: number) => {
    const u = (x - c.x) * Math.cos(ph) + (y - c.y) * Math.sin(ph), v = -(x - c.x) * Math.sin(ph) + (y - c.y) * Math.cos(ph);
    return Math.atan2(v / ry, u / rx);
  };
  const track = (c: Pt, rx: number, ry: number, ph: number): { total: number } | null => {
    let prev = phase(P[s].x, P[s].y, c, rx, ry, ph), total = 0, sign = 0;
    for (let i = s + 1; i <= e; i++) {
      const a = phase(P[i].x, P[i].y, c, rx, ry, ph);
      let d = a - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d <= -Math.PI) d += 2 * Math.PI;
      if (Math.abs(d) > 1e-9) { if (sign === 0) sign = Math.sign(d); else if (Math.sign(d) !== sign) return null; }
      total += d; prev = a;
    }
    return { total };
  };
  const t0 = track({ x: f.cx, y: f.cy }, f.rx, f.ry, f.phi);
  if (!t0 || Math.abs(t0.total) < 0.05 || Math.abs(t0.total) > 5.6) return null;
  const sweep: 0 | 1 = t0.total > 0 ? 1 : 0, large: 0 | 1 = Math.abs(t0.total) > Math.PI ? 1 : 0;
  const rot = (f.phi * 180) / Math.PI;
  const A = P[s], B = P[e];
  const g = ellipseGeom(A, B, f.rx, f.ry, rot, large, sweep); // centro real a partir dos extremos exatos
  const t1 = track(g.c, g.rx, g.ry, g.phi);
  if (!t1 || (t1.total > 0 ? 1 : 0) !== sweep) return null;
  const gc = Math.cos(g.phi), gs = Math.sin(g.phi);
  for (let i = s; i <= e; i++) {
    const u = (P[i].x - g.c.x) * gc + (P[i].y - g.c.y) * gs, v = -(P[i].x - g.c.x) * gs + (P[i].y - g.c.y) * gc;
    const F = (u * u) / (g.rx * g.rx) + (v * v) / (g.ry * g.ry) - 1;
    const grad = 2 * Math.hypot(u / (g.rx * g.rx), v / (g.ry * g.ry));
    if (grad < 1e-12 || Math.abs(F) / grad > tol) return null; // distância geométrica de 1ª ordem
  }
  const end = phase(B.x, B.y, g.c, g.rx, g.ry, g.phi);
  const dv = { x: -gc * g.rx * Math.sin(end) - gs * g.ry * Math.cos(end), y: -gs * g.rx * Math.sin(end) + gc * g.ry * Math.cos(end) };
  const tOut = norm(sweep ? dv : mul(dv, -1));
  return { seg: { t: 'E', rx: g.rx, ry: g.ry, rot, large, sweep, p: B }, tOut };
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

interface PrimInfo { seg: Seg; s: number; e: number; tOut: Pt }

const MERGE_TOL = 0.8; // fusão só se o desvio máximo ≤ 80% da tolerância de ajuste
const MERGE_MAX_TURN = 25; // graus: não funde através de uma junta com mudança brusca de direção

function turnAt(P: Pt[], k: number): number {
  const a = Math.max(0, k - 3), b = Math.min(P.length - 1, k + 3);
  const u = sub(P[k], P[a]), v = sub(P[b], P[k]);
  const lu = len(u), lv = len(v);
  return lu && lv ? (Math.acos(Math.max(-1, Math.min(1, dot(u, v) / (lu * lv)))) * 180) / Math.PI : 0;
}

/** Tenta cobrir P[s..e] com UMA primitiva (reta → arco → elipse → cúbica) dentro de `tol`. */
function onePrimitive(P: Pt[], s: number, e: number, tIn: Pt, tEndIn: Pt, tol: number, arcs: boolean, ellipses: boolean): PrimInfo | null {
  if (lineOk(P, s, e, tol)) return { seg: { t: 'L', p: P[e] }, s, e, tOut: norm(sub(P[e], P[s])) };
  if (arcs) { const f = arcFit(P, s, e, tol); if (f) return { seg: f.seg, s, e, tOut: f.tOut }; }
  if (ellipses && e - s >= 16) { const f = ellipseArcFit(P, s, e, tol); if (f) return { seg: f.seg, s, e, tOut: f.tOut }; }
  const b = cubicFit(P, s, e, tIn, mul(tEndIn, -1), tol);
  if (b) { const t = norm(sub(b[3], b[2])); return { seg: { t: 'C', c1: b[1], c2: b[2], p: b[3] }, s, e, tOut: t }; }
  return null;
}

/**
 * Fusão pós-ajuste CONSERVADORA: funde 2–3 primitivas vizinhas numa só quando uma única
 * primitiva cobre todo o trecho com desvio ≤ 80% da tolerância (contra o contorno original) e a
 * junta interna é suave (< 25°). Nunca atravessa cantos nem detalhes de curvatura brusca.
 */
function mergePrimitives(P: Pt[], infos: PrimInfo[], tStart: Pt, tAt: (k: number) => Pt, tol: number, arcs: boolean, ellipses: boolean): PrimInfo[] {
  let changed = true;
  for (let guard = 0; changed && guard < 50; guard++) {
    changed = false;
    for (let i = 0; i + 1 < infos.length && !changed; i++) {
      for (const span of [3, 2]) {
        if (i + span > infos.length) continue;
        let sharp = false;
        for (let j = i; j < i + span - 1; j++) if (turnAt(P, infos[j].e) > MERGE_MAX_TURN) sharp = true;
        if (sharp) continue;
        const s = infos[i].s, e = infos[i + span - 1].e;
        const m = onePrimitive(P, s, e, i === 0 ? tStart : infos[i - 1].tOut, tAt(e), tol, arcs, ellipses);
        if (m) { infos.splice(i, span, m); changed = true; break; }
      }
    }
  }
  return infos;
}

/**
 * Cobre a sequência de pontos com o MENOR número de primitivas: a cada passo estende
 * o trecho o máximo possível com reta, arco ou Bézier cúbica (continuidade G1 entre elas).
 */
function fitRun(P: Pt[], tStart: Pt, tEnd: Pt, tol: number, arcs: boolean, ellipses: boolean, cornerRun = false, merge = true): Seg[] {
  const m = P.length;
  // trecho entre dois cantos que é uma única reta: a ponta (arredondada pela cobertura do pixel) não conta;
  // o vértice exato é recuperado depois pela interseção das retas vizinhas
  if (cornerRun && m >= 4) {
    const l = tlsLine(P);
    if (l) {
      let ok = true;
      const off = (q: Pt) => Math.abs((q.x - l.c.x) * l.d.y - (q.y - l.c.y) * l.d.x);
      const trim = m > 8 ? 2 : 1; // pontas arredondadas pela cobertura do pixel (chanfro de ~0,7 px) não contam
      for (let i = trim; i < m - trim && ok; i++) if (off(P[i]) > tol) ok = false;
      if (off(P[0]) > Math.max(1, tol * 2) || off(P[m - 1]) > Math.max(1, tol * 2)) ok = false; // pontas fora da reta: não é aresta de polígono
      if (ok) return [{ t: 'L', p: P[m - 1] }];
    }
  }
  const tAt = (k: number) => (k >= m - 1 ? tEnd : norm(sub(P[Math.min(k + 2, m - 1)], P[Math.max(k - 2, 0)])));
  const infos: PrimInfo[] = [];
  let s = 0, tIn = tStart;
  while (s < m - 1) {
    const last = m - 1;
    let kind: 'L' | 'A' | 'E' | 'C' = 'L';
    let e = extent((x) => lineOk(P, s, x, tol), s + 1, last);
    if (e < last && arcs) {
      const ea = extent((x) => arcFit(P, s, x, tol) !== null, s + 3, last);
      if (ea > e + 1) { e = ea; kind = 'A'; }
    }
    if (e < last && ellipses) {
      // poucos pontos deixam a elipse mal-condicionada: sonda a partir de trechos maiores
      const okE = (x: number) => ellipseArcFit(P, s, x, tol) !== null;
      let ee = -1;
      for (const st of [s + 16, s + 40, last]) {
        if (st > last || e >= st) continue;
        if (okE(st)) { ee = extent(okE, st, last); break; }
      }
      if (ee > e + 2) { e = ee; kind = 'E'; }
    }
    if (e < last) {
      const ec = extent((x) => cubicFit(P, s, x, tIn, mul(tAt(x), -1), tol) !== null, s + 2, last);
      if (ec > e + 2) { e = ec; kind = 'C'; }
    }
    if (kind === 'A' || kind === 'E') {
      const f = (kind === 'A' ? arcFit(P, s, e, tol) : ellipseArcFit(P, s, e, tol))!;
      infos.push({ seg: f.seg, s, e, tOut: f.tOut }); tIn = f.tOut;
    } else if (kind === 'C') {
      const b = cubicFit(P, s, e, tIn, mul(tAt(e), -1), tol)!;
      tIn = norm(sub(b[3], b[2]));
      infos.push({ seg: { t: 'C', c1: b[1], c2: b[2], p: b[3] }, s, e, tOut: tIn });
    } else {
      tIn = norm(sub(P[e], P[s]));
      infos.push({ seg: { t: 'L', p: P[e] }, s, e, tOut: tIn });
    }
    s = e;
  }
  return (merge ? mergePrimitives(P, infos, tStart, tAt, tol * MERGE_TOL, arcs, ellipses) : infos).map((i) => i.seg);
}

/** Reta por mínimos quadrados totais (ignora os 2 pontos de cada ponta, afetados pelo arredondamento do canto). */
function tlsLine(pts: Pt[]): { c: Pt; d: Pt } | null {
  const trim = pts.length > 8 ? 2 : pts.length > 4 ? 1 : 0;
  const q = pts.slice(trim, pts.length - trim);
  if (q.length < 3) return null;
  let mx = 0, my = 0;
  for (const p of q) { mx += p.x; my += p.y; }
  mx /= q.length; my /= q.length;
  let sxx = 0, sxy = 0, syy = 0;
  for (const p of q) { sxx += (p.x - mx) ** 2; sxy += (p.x - mx) * (p.y - my); syy += (p.y - my) ** 2; }
  const th = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return { c: { x: mx, y: my }, d: { x: Math.cos(th), y: Math.sin(th) } };
}

const MIN_TERMINAL_LINE = 3; // px: reta terminal curta demais não define direção

/** Reta do último segmento de um trecho (se for reta longa). */
function endLine(r: { segs: Seg[] }, runStart: Pt): { c: Pt; d: Pt } | null {
  const n = r.segs.length, last = r.segs[n - 1];
  if (last.t !== 'L') return null;
  const from = n > 1 ? r.segs[n - 2].p : runStart;
  const dx = last.p.x - from.x, dy = last.p.y - from.y, l = Math.hypot(dx, dy);
  return l >= MIN_TERMINAL_LINE ? { c: last.p, d: { x: dx / l, y: dy / l } } : null;
}

/** Reta do primeiro segmento de um trecho (se for reta longa). */
function startLine(r: { segs: Seg[] }, runStart: Pt): { c: Pt; d: Pt } | null {
  const first = r.segs[0];
  if (first.t !== 'L') return null;
  const dx = first.p.x - runStart.x, dy = first.p.y - runStart.y, l = Math.hypot(dx, dy);
  return l >= MIN_TERMINAL_LINE ? { c: runStart, d: { x: dx / l, y: dy / l } } : null;
}

function intersect(a: { c: Pt; d: Pt }, b: { c: Pt; d: Pt }): Pt | null {
  const den = a.d.x * b.d.y - a.d.y * b.d.x;
  if (Math.abs(den) < 0.35) return null; // quase paralelas (< ~20°): não refina
  const t = ((b.c.x - a.c.x) * b.d.y - (b.c.y - a.c.y) * b.d.x) / den;
  return { x: a.c.x + a.d.x * t, y: a.c.y + a.d.y * t };
}

/** Douglas–Peucker iterativo para um contorno FECHADO (divide em dois pelos pontos mais distantes). */
function simplifyClosed(p: Pt[], tol: number): Pt[] {
  const n = p.length;
  let far = 0, fd = -1;
  for (let i = 1; i < n; i++) { const d = Math.hypot(p[i].x - p[0].x, p[i].y - p[0].y); if (d > fd) { fd = d; far = i; } }
  const keep = new Uint8Array(n);
  keep[0] = 1; keep[far] = 1;
  const stack: [number, number][] = [[0, far], [far, n]]; // o segundo trecho fecha no ponto 0 (índice n ≡ 0)
  while (stack.length) {
    const [a, b] = stack.pop()!;
    const A = p[a % n], B = p[b % n];
    const dx = B.x - A.x, dy = B.y - A.y, l = Math.hypot(dx, dy);
    let md = -1, mi = -1;
    for (let i = a + 1; i < b; i++) {
      const q = p[i % n];
      const d = l < 1e-9 ? Math.hypot(q.x - A.x, q.y - A.y) : Math.abs((q.x - A.x) * dy - (q.y - A.y) * dx) / l;
      if (d > md) { md = d; mi = i; }
    }
    if (md > tol && mi > 0) { keep[mi % n] = 1; stack.push([a, mi], [mi, b]); }
  }
  return p.filter((_, i) => keep[i]);
}

/** Remove retas minúsculas entre outras primitivas: o ponto final da anterior absorve o da reta. */
function dropMicroSegments(path: VPath, minLen: number): VPath {
  if (minLen <= 0) return path;
  const segs = path.segs.slice();
  let start = path.start;
  for (let i = 0; i < segs.length && segs.length > 3; ) {
    const sg = segs[i];
    const from = i === 0 ? start : segs[i - 1].p;
    if (sg.t === 'L' && Math.hypot(sg.p.x - from.x, sg.p.y - from.y) < minLen) {
      if (i === 0) { start = sg.p; segs.shift(); continue; } // início do caminho absorve a reta
      const prev = segs[i - 1];
      segs[i - 1] = { ...prev, p: sg.p } as Seg;
      segs.splice(i, 1);
      continue;
    }
    i++;
  }
  // o último segmento fecha no início
  const last = segs[segs.length - 1];
  if (last && Math.hypot(last.p.x - start.x, last.p.y - start.y) > 1e-6 && Math.hypot(last.p.x - path.start.x, last.p.y - path.start.y) < 1e-6) segs[segs.length - 1] = { ...last, p: start } as Seg;
  return { start, segs };
}

/** `thin` = sem traço de fenda: só para traços realmente finos (< ~3 px); o traço de 0,6 px os engrossaria muito */
const mark = (p: VPath, hyd: number): VPath => (hyd < NO_GAP_HYDRAULIC ? { ...p, thin: true } : p);

const MICRO = 0.75; // px
const NO_GAP_HYDRAULIC = 1.5; // px: abaixo disto o contorno não recebe traço de preenchimento de fendas
const THIN_POLYLINE = 0.9; // px: abaixo disto (largura ≲ 2,2 px) curvas não fazem sentido — polilinha exata simplificada
const POLY_TOL = 0.25; // px
const THIN_HYDRAULIC = 2.2; // px: abaixo disso o contorno é de um traço fino (largura ≲ 4 px)
const THIN_TOL = 0.25; // px

export interface FitOptions {
  /** raio hidráulico da ESTRUTURA a que o laço pertence (contorno externo + furos); vale o menor entre ele e o do próprio laço */
  hydraulic?: number;
  merge?: boolean; // fusão conservadora pós-ajuste (padrão: ligada)
  tolerance: number;
  cornerThreshold: number;
  smooth: number;
  arcs: boolean;
  ellipses: boolean;
}

/** Converte um contorno denso em caminho com retas, arcos e Béziers cúbicas. */
export function fitLoop(loop: Pt[], opts: FitOptions): VPath {
  let o = opts;
  const p = loop.filter((q, i) => i === 0 || q.x !== loop[i - 1].x || q.y !== loop[i - 1].y);
  if (p.length > 1 && p[0].x === p[p.length - 1].x && p[0].y === p[p.length - 1].y) p.pop();
  const n = p.length;
  if (n < 4) return { start: p[0], segs: p.slice(1).map((q) => ({ t: 'L' as const, p: q })) };
  // contorno fino (raio hidráulico = área/perímetro ≈ meia largura): preserva largura e posição
  let area2 = 0, per = 0;
  for (let i = 0; i < n; i++) { const q = p[(i + 1) % n]; area2 += p[i].x * q.y - q.x * p[i].y; per += Math.hypot(q.x - p[i].x, q.y - p[i].y); }
  const hyd = Math.min(per > 0 ? Math.abs(area2 / 2) / per : 0, o.hydraulic ?? Infinity);
  const thin = hyd < THIN_HYDRAULIC;
  if (hyd < THIN_POLYLINE && n >= 6) {
    // ultrafino: a forma É a polilinha (cantos e pontas exatos, sem curva inventada)
    const v = simplifyClosed(p, POLY_TOL);
    if (v.length >= 3) return { start: v[0], segs: [...v.slice(1), v[0]].map((q) => ({ t: 'L' as const, p: q })), thin: true }; // ultrafino também é “sem fenda”
  }
  const micro = thin ? 0.3 : MICRO; // em traço fino, 1 px é detalhe real
  if (thin) o = { ...o, smooth: 0, tolerance: Math.min(o.tolerance, THIN_TOL) };
  const { corners, ang } = detectCorners(p, o.cornerThreshold, thin ? 2 : 4, !thin, !thin);
  // janela proporcional ao contorno: formas pequenas (texto, pontos) não podem ser encolhidas pela média móvel
  const s = smoothPoints(p, corners, Math.min(Math.round(o.smooth), Math.max(1, Math.floor(n / 40))));
  if (corners.length === 0) {
    let a0 = 0;
    for (let i = 1; i < n; i++) if (ang[i] > ang[a0]) a0 = i;
    const r = [...s.slice(a0), ...s.slice(0, a0)];
    const t = norm(sub(r[2 % n], r[n - 2]));
    return mark(dropMicroSegments({ start: r[0], segs: fitRun([...r, r[0]], t, t, o.tolerance, o.arcs, o.ellipses, false, o.merge !== false) }, micro), hyd);
  }
  // ajusta cada trecho entre cantos e guarda a reta (TLS) dos trechos que viraram uma única reta
  interface Run { segs: Seg[]; line: { c: Pt; d: Pt } | null; start: Pt }
  const runs: Run[] = [];
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
    const rs = fitRun(part, t1, t2, o.tolerance, o.arcs, o.ellipses, true, o.merge !== false);
    runs.push({ segs: rs, line: rs.length === 1 && rs[0].t === 'L' ? tlsLine(part) : null, start: part[0] });
  }
  // refino de cantos: vértice entre duas retas = interseção das retas ajustadas
  let start = s[corners[0]];
  const R = runs.length;
  const prevStart = (c: number) => runs[(c - 1 + R) % R].start;
  for (let c = 0; c < R; c++) {
    const prev = runs[(c - 1 + R) % R], next = runs[c];
    const orig = s[corners[c]];
    // reta de cada lado: o trecho inteiro (TLS) ou, se o trecho é composto, o seu segmento terminal quando for uma reta longa
    const lineEnd = prev.line ?? endLine(prev, prevStart(c));
    const lineStart = next.line ?? startLine(next, orig);
    const v = lineEnd && lineStart ? intersect(lineEnd, lineStart) : null;
    if (!v || Math.hypot(v.x - orig.x, v.y - orig.y) > Math.max(2, o.tolerance * 3)) continue;
    prev.segs[prev.segs.length - 1] = { t: 'L', p: v };
    if (c === 0) start = v;
  }
  const segs: Seg[] = runs.flatMap((r) => r.segs);
  return mark(dropMicroSegments({ start, segs }, micro), hyd);
}
