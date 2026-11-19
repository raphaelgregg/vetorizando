import type { Pt, Seg, VPath } from './types';

export interface ArcGeom { c: Pt; r: number; a0: number; da: number }

/** Parametrização central de um arco circular SVG (a → b). */
export function arcGeom(a: Pt, b: Pt, r: number, large: number, sweep: number): ArcGeom {
  const x1 = (a.x - b.x) / 2, y1 = (a.y - b.y) / 2;
  const d2 = x1 * x1 + y1 * y1;
  let rr = r;
  if (d2 > rr * rr) rr = Math.sqrt(d2);
  const coef = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, (rr * rr - d2) / (d2 || 1)));
  const cx1 = coef * y1, cy1 = -coef * x1;
  const c = { x: cx1 + (a.x + b.x) / 2, y: cy1 + (a.y + b.y) / 2 };
  const a0 = Math.atan2(y1 - cy1, x1 - cx1);
  const a1 = Math.atan2(-y1 - cy1, -x1 - cx1);
  let da = a1 - a0;
  if (!sweep && da > 0) da -= 2 * Math.PI;
  if (sweep && da < 0) da += 2 * Math.PI;
  return { c, r: rr, a0, da };
}

/** Arco → lista de Béziers cúbicas (cada uma ≤ 90°). */
export function arcToCubics(a: Pt, s: Extract<Seg, { t: 'A' }>): { c1: Pt; c2: Pt; p: Pt }[] {
  const g = arcGeom(a, s.p, s.r, s.large, s.sweep);
  const n = Math.max(1, Math.ceil(Math.abs(g.da) / (Math.PI / 2) - 1e-9));
  const step = g.da / n;
  const k = (4 / 3) * Math.tan(step / 4);
  const out: { c1: Pt; c2: Pt; p: Pt }[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = g.a0 + i * step, t1 = t0 + step;
    const p0 = { x: g.c.x + g.r * Math.cos(t0), y: g.c.y + g.r * Math.sin(t0) };
    const p1 = i === n - 1 ? s.p : { x: g.c.x + g.r * Math.cos(t1), y: g.c.y + g.r * Math.sin(t1) };
    out.push({
      c1: { x: p0.x - k * g.r * Math.sin(t0), y: p0.y + k * g.r * Math.cos(t0) },
      c2: { x: p1.x + k * g.r * Math.sin(t1), y: p1.y - k * g.r * Math.cos(t1) },
      p: p1,
    });
  }
  return out;
}

/** Caminho com apenas retas e Béziers cúbicas (arcos convertidos). */
export function toCubicPath(p: VPath): { start: Pt; segs: ({ t: 'L'; p: Pt } | { t: 'C'; c1: Pt; c2: Pt; p: Pt })[] } {
  const segs: ({ t: 'L'; p: Pt } | { t: 'C'; c1: Pt; c2: Pt; p: Pt })[] = [];
  let cur = p.start;
  for (const s of p.segs) {
    if (s.t === 'A') for (const c of arcToCubics(cur, s)) segs.push({ t: 'C', ...c });
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
