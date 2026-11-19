import { Lab, dist2, rgbToLab } from './color';
import type { RawImage } from './types';

/**
 * Remove pixels de transição (anti-aliasing): um pixel cuja cor é uma mistura de duas
 * cores vizinhas da paleta é realocado para a mais próxima (pela projeção na mistura),
 * evitando anéis/“bolhas” de tons intermediários nas bordas.
 */
export interface Transitions {
  idx: Int32Array; // pixel
  a: Int16Array; // cor de menor t
  b: Int16Array; // cor de maior t
  t: Float32Array; // fração de b no pixel (0..1)
}

export const NO_TRANSITIONS: Transitions = { idx: new Int32Array(0), a: new Int16Array(0), b: new Int16Array(0), t: new Float32Array(0) };

export function resolveTransitions(img: RawImage, labels: Int16Array, palette: Lab[], rgb: [number, number, number][], delta: number, passes = 2): Transitions {
  if (delta <= 0 || palette.length < 3) return NO_TRANSITIONS;
  const found = new Map<number, [number, number, number]>();
  const { data, width: w, height: h } = img;
  for (let pass = 0; pass < passes; pass++) {
    const src = labels.slice();
    let any = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x;
        const m = src[i];
        if (m < 0) continue;
        const nb: number[] = [];
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            if (!dx && !dy) continue;
            const xx = x + dx, yy = y + dy;
            if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
            const l = src[yy * w + xx];
            if (l >= 0 && l !== m && !nb.includes(l)) nb.push(l);
          }
        }
        if (nb.length < 1) continue;
        const cand = [m, ...nb];
        const p = rgbToLab(data[i * 4], data[i * 4 + 1], data[i * 4 + 2]);
        const own = Math.sqrt(dist2(p, palette[m]));
        let bestD = delta, ba = -1, bb = -1, bt = 0;
        for (let x = 0; x < cand.length; x++) {
          for (let y = x + 1; y < cand.length; y++) {
            const A = palette[cand[x]], B = palette[cand[y]];
            const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
            const L2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
            if (L2 < delta * delta) continue; // extremos indistinguíveis
            const t = Math.min(1, Math.max(0, ((p[0] - A[0]) * ab[0] + (p[1] - A[1]) * ab[1] + (p[2] - A[2]) * ab[2]) / L2));
            const q: Lab = [A[0] + t * ab[0], A[1] + t * ab[1], A[2] + t * ab[2]];
            const d = Math.sqrt(dist2(p, q));
            if (d >= bestD) continue;
            if (x !== 0 && d >= own) continue; // par sem a cor própria: precisa explicar melhor que ela
            // fração no espaço sRGB (composição usual de anti-aliasing)
            const RA = rgb[cand[x]], RB = rgb[cand[y]];
            const dr = [RB[0] - RA[0], RB[1] - RA[1], RB[2] - RA[2]];
            const l2 = dr[0] * dr[0] + dr[1] * dr[1] + dr[2] * dr[2] || 1;
            bt = Math.min(1, Math.max(0, ((data[i * 4] - RA[0]) * dr[0] + (data[i * 4 + 1] - RA[1]) * dr[1] + (data[i * 4 + 2] - RA[2]) * dr[2]) / l2));
            bestD = d; ba = cand[x]; bb = cand[y];
          }
        }
        if (ba < 0) continue;
        const lab = bt < 0.5 ? ba : bb;
        if (lab !== m) { labels[i] = lab; any = true; }
        if (bt > 0.03 && bt < 0.97) found.set(i, [ba, bb, bt]);
        else found.delete(i);
      }
    }
    if (!any) break;
  }
  const n = found.size;
  const out: Transitions = { idx: new Int32Array(n), a: new Int16Array(n), b: new Int16Array(n), t: new Float32Array(n) };
  let k = 0;
  for (const [i, [a, b, t]] of found) { out.idx[k] = i; out.a[k] = a; out.b[k] = b; out.t[k] = t; k++; }
  return out;
}
