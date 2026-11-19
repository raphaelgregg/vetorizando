import type { Pt, Seg, VPath } from './types';

export interface ArcGeom { c: Pt; r: number; a0: number; da: number }
export interface EllipseGeom { c: Pt; rx: number; ry: number; phi: number; a0: number; da: number }

/** Parametrização central de um arco elíptico SVG (a → b), rot em graus (SVG F.6.5). */
export function ellipseGeom(a: Pt, b: Pt, rx: number, ry: number, rotDeg: number, large: number, sweep: number): EllipseGeom {
  const phi = (rotDeg * Math.PI) / 180, cp = Math.cos(phi), sp = Math.sin(phi);
  const hx = (a.x - b.x) / 2, hy = (a.y - b.y) / 2;
  const x1 = cp * hx + sp * hy, y1 = -sp * hx + cp * hy;
  const lam = (x1 * x1) / (rx * rx) + (y1 * y1) / (ry * ry);
  if (lam > 1) { const k = Math.sqrt(lam); rx *= k; ry *= k; }
  const den = rx * rx * y1 * y1 + ry * ry * x1 * x1;
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rx * rx * ry * ry - den) / (den || 1)));
  const cx1 = (coef * rx * y1) / ry, cy1 = (-coef * ry * x1) / rx;
  const c = { x: cp * cx1 - sp * cy1 + (a.x + b.x) / 2, y: sp * cx1 + cp * cy1 + (a.y + b.y) / 2 };
  const a0 = Math.atan2((y1 - cy1) / ry, (x1 - cx1) / rx);
  const a1 = Math.atan2((-y1 - cy1) / ry, (-x1 - cx1) / rx);
  let da = a1 - a0;
  if (!sweep && da > 0) da -= 2 * Math.PI;
  if (sweep && da < 0) da += 2 * Math.PI;
  return { c, rx, ry, phi, a0, da };
}

/** Parametrização central de um arco circular SVG (a → b). */
export function arcGeom(a: Pt, b: Pt, r: number, large: number, sweep: number): ArcGeom {
  const g = ellipseGeom(a, b, r, r, 0, large, sweep);
  return { c: g.c, r: g.rx, a0: g.a0, da: g.da };
}

/** Arco circular ou elíptico → Béziers cúbicas (cada uma ≤ 90° paramétricos). */
export function arcToCubics(a: Pt, s: Extract<Seg, { t: 'A' | 'E' }>): { c1: Pt; c2: Pt; p: Pt }[] {
  const g = s.t === 'A' ? ellipseGeom(a, s.p, s.r, s.r, 0, s.large, s.sweep) : ellipseGeom(a, s.p, s.rx, s.ry, s.rot, s.large, s.sweep);
  const cp = Math.cos(g.phi), sp = Math.sin(g.phi);
  const at = (t: number): Pt => ({ x: g.c.x + cp * g.rx * Math.cos(t) - sp * g.ry * Math.sin(t), y: g.c.y + sp * g.rx * Math.cos(t) + cp * g.ry * Math.sin(t) });
  const dv = (t: number): Pt => ({ x: -cp * g.rx * Math.sin(t) - sp * g.ry * Math.cos(t), y: -sp * g.rx * Math.sin(t) + cp * g.ry * Math.cos(t) });
  const n = Math.max(1, Math.ceil(Math.abs(g.da) / (Math.PI / 2) - 1e-9));
  const step = g.da / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: { c1: Pt; c2: Pt; p: Pt }[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = g.a0 + i * step, t1 = t0 + step;
    const p0 = at(t0), p1 = i === n - 1 ? s.p : at(t1);
    const d0 = dv(t0), d1 = dv(t1);
    out.push({ c1: { x: p0.x + k * d0.x, y: p0.y + k * d0.y }, c2: { x: p1.x - k * d1.x, y: p1.y - k * d1.y }, p: p1 });
  }
  return out;
}

/** Caminho com apenas retas e Béziers cúbicas (arcos convertidos). */
export function toCubicPath(p: VPath): { start: Pt; segs: ({ t: 'L'; p: Pt } | { t: 'C'; c1: Pt; c2: Pt; p: Pt })[] } {
  const segs: ({ t: 'L'; p: Pt } | { t: 'C'; c1: Pt; c2: Pt; p: Pt })[] = [];
  let cur = p.start;
  for (const s of p.segs) {
    if (s.t === 'A' || s.t === 'E') for (const c of arcToCubics(cur, s)) segs.push({ t: 'C', ...c });
    else segs.push(s);
    cur = s.p;
  }
  return { start: p.start, segs };
}

/** Pontos (sem o inicial) que aproximam uma Bézier cúbica com erro ≤ tol. */
export function flattenCubic(p0: Pt, c1: Pt, c2: Pt, p3: Pt, tol: number): Pt[] {
  const m = Math.max(Math.hypot(p0.x - 2 * c1.x + c2.x, p0.y - 2 * c1.y + c2.y), Math.hypot(c1.x - 2 * c2.x + p3.x, c1.y - 2 * c2.y + p3.y));
  const n = Math.min(200, Math.max(2, Math.ceil(Math.sqrt((0.75 * m) / tol))));
  const out: Pt[] = [];
  for (let i = 1; i <= n; i++) {
    const t = i / n, u = 1 - t;
    out.push({
      x: u * u * u * p0.x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t * t * t * p3.x,
      y: u * u * u * p0.y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t * t * t * p3.y,
    });
  }
  return out;
}

/** Polilinha que aproxima o caminho com erro ≤ tol (sem repetir o ponto inicial no fim). */
export function flattenPath(p: VPath, tol = 0.05): Pt[] {
  const pts: Pt[] = [p.start];
  let cur = p.start;
  for (const s of toCubicPath(p).segs) {
    if (s.t === 'L') pts.push(s.p);
    else {
      const m = Math.max(
        Math.hypot(cur.x - 2 * s.c1.x + s.c2.x, cur.y - 2 * s.c1.y + s.c2.y),
        Math.hypot(s.c1.x - 2 * s.c2.x + s.p.x, s.c1.y - 2 * s.c2.y + s.p.y),
      );
      const n = Math.min(200, Math.max(2, Math.ceil(Math.sqrt((0.75 * m) / tol))));
      for (let i = 1; i <= n; i++) {
        const t = i / n, u = 1 - t;
        pts.push({
          x: u * u * u * cur.x + 3 * u * u * t * s.c1.x + 3 * u * t * t * s.c2.x + t * t * t * s.p.x,
          y: u * u * u * cur.y + 3 * u * u * t * s.c1.y + 3 * u * t * t * s.c2.y + t * t * t * s.p.y,
        });
      }
    }
    cur = s.p;
  }
  const f = pts[0], l = pts[pts.length - 1];
  if (pts.length > 1 && Math.hypot(f.x - l.x, f.y - l.y) < 1e-9) pts.pop();
  return pts;
}
