import type { Pt } from './types';

export interface EllipseFit { cx: number; cy: number; rx: number; ry: number; phi: number }

type M3 = [[number, number, number], [number, number, number], [number, number, number]];
type V3 = [number, number, number];

const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];

function inv3(m: M3): M3 | null {
  const [[a, b, c], [d, e, f], [g, h, i]] = m;
  const A = e * i - f * h, B = -(d * i - f * g), C = d * h - e * g;
  const det = a * A + b * B + c * C;
  if (Math.abs(det) < 1e-14) return null;
  return [
    [A / det, -(b * i - c * h) / det, (b * f - c * e) / det],
    [B / det, (a * i - c * g) / det, -(a * f - c * d) / det],
    [C / det, -(a * h - b * g) / det, (a * e - b * d) / det],
  ];
}

const mul = (a: M3, b: M3): M3 => a.map((r) => [0, 1, 2].map((j) => r[0] * b[0][j] + r[1] * b[1][j] + r[2] * b[2][j])) as M3;

/** Raízes reais de x³ + c2 x² + c1 x + c0. */
function realRoots(c2: number, c1: number, c0: number): number[] {
  const a = c1 - (c2 * c2) / 3, b = (2 * c2 ** 3) / 27 - (c2 * c1) / 3 + c0, sh = -c2 / 3;
  const disc = (b / 2) ** 2 + (a / 3) ** 3;
  if (disc > 0) {
    const sq = Math.sqrt(disc);
    return [Math.cbrt(-b / 2 + sq) + Math.cbrt(-b / 2 - sq) + sh];
  }
  const r = Math.sqrt(Math.max(0, -((a / 3) ** 3)));
  if (r < 1e-18) return [sh];
  const ph = Math.acos(Math.max(-1, Math.min(1, -b / 2 / r)));
  const m = 2 * Math.cbrt(r);
  return [0, 1, 2].map((k) => m * Math.cos((ph + 2 * Math.PI * k) / 3) + sh);
}

/**
 * Ajuste direto de elipse (Halir & Flusser, numericamente estável) aos pontos P[s..e].
 * Retorna centro, semi-eixos (rx ao longo de phi) ou null se o melhor cônico não for elipse.
 */
export function fitEllipse(P: Pt[], s: number, e: number): EllipseFit | null {
  const n = e - s + 1;
  if (n < 6) return null;
  let mx = 0, my = 0;
  for (let i = s; i <= e; i++) { mx += P[i].x; my += P[i].y; }
  mx /= n; my /= n;
  let sc = 0;
  for (let i = s; i <= e; i++) sc += (P[i].x - mx) ** 2 + (P[i].y - my) ** 2;
  sc = Math.sqrt(sc / n);
  if (sc < 1e-9) return null;
  const S1: M3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], S2: M3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], S3: M3 = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
  for (let i = s; i <= e; i++) {
    const x = (P[i].x - mx) / sc, y = (P[i].y - my) / sc;
    const d1: V3 = [x * x, x * y, y * y], d2: V3 = [x, y, 1];
    for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) { S1[r][c] += d1[r] * d1[c]; S2[r][c] += d1[r] * d2[c]; S3[r][c] += d2[r] * d2[c]; }
  }
  const S3i = inv3(S3);
  if (!S3i) return null;
  const S2t: M3 = [[S2[0][0], S2[1][0], S2[2][0]], [S2[0][1], S2[1][1], S2[2][1]], [S2[0][2], S2[1][2], S2[2][2]]];
  const T = mul(S3i, S2t).map((r) => r.map((v) => -v)) as M3;
  const S2T = mul(S2, T);
  const M: M3 = [0, 1, 2].map((r) => [0, 1, 2].map((c) => S1[r][c] + S2T[r][c])) as M3;
  const Mp: M3 = [M[2].map((v) => v / 2) as V3, M[1].map((v) => -v) as V3, M[0].map((v) => v / 2) as V3];
  const tr = Mp[0][0] + Mp[1][1] + Mp[2][2];
  const minors = (Mp[0][0] * Mp[1][1] - Mp[0][1] * Mp[1][0]) + (Mp[0][0] * Mp[2][2] - Mp[0][2] * Mp[2][0]) + (Mp[1][1] * Mp[2][2] - Mp[1][2] * Mp[2][1]);
  const det = Mp[0][0] * (Mp[1][1] * Mp[2][2] - Mp[1][2] * Mp[2][1]) - Mp[0][1] * (Mp[1][0] * Mp[2][2] - Mp[1][2] * Mp[2][0]) + Mp[0][2] * (Mp[1][0] * Mp[2][1] - Mp[1][1] * Mp[2][0]);
  let a1: V3 | null = null;
  for (const lam of realRoots(-tr, minors, -det)) {
    const R = Mp.map((r, i) => r.map((v, j) => v - (i === j ? lam : 0))) as M3;
    const cands = [cross(R[0], R[1]), cross(R[0], R[2]), cross(R[1], R[2])];
    let v = cands[0], best = -1;
    for (const c of cands) { const l = Math.hypot(...c); if (l > best) { best = l; v = c; } }
    if (best < 1e-12) continue;
    v = v.map((x) => x / best) as V3;
    if (4 * v[0] * v[2] - v[1] * v[1] > 0) { a1 = v; break; }
  }
  if (!a1) return null;
  const a2 = [0, 1, 2].map((r) => T[r][0] * a1![0] + T[r][1] * a1![1] + T[r][2] * a1![2]);
  const [A, B, C, D, E, F] = [a1[0], a1[1], a1[2], a2[0], a2[1], a2[2]];
  const dt = 4 * A * C - B * B;
  if (dt <= 0) return null;
  const cx = (B * E - 2 * C * D) / dt, cy = (B * D - 2 * A * E) / dt;
  const Fp = F + (D * cx + E * cy) / 2;
  const phi = 0.5 * Math.atan2(B, A - C);
  const cp = Math.cos(phi), sp = Math.sin(phi);
  const l1 = A * cp * cp + B * sp * cp + C * sp * sp, l2 = A * sp * sp - B * sp * cp + C * cp * cp;
  const r1 = -Fp / l1, r2 = -Fp / l2;
  if (!(r1 > 0) || !(r2 > 0)) return null;
  return { cx: cx * sc + mx, cy: cy * sc + my, rx: Math.sqrt(r1) * sc, ry: Math.sqrt(r2) * sc, phi };
}
