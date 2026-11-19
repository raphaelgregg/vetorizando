import { Lab, dist2, rgbToLab } from './color';
import type { RawImage } from './types';

export interface Transitions {
  idx: Int32Array; // pixel
  a: Int16Array; // cor de menor t
  b: Int16Array; // cor de maior t
  t: Float32Array; // fração de b no pixel (0..1)
}

export const NO_TRANSITIONS: Transitions = { idx: new Int32Array(0), a: new Int16Array(0), b: new Int16Array(0), t: new Float32Array(0) };

const R = 2; // vizinhança 5×5
/** Espessura local (px, truncada em 3): menor corrida horizontal/vertical do mesmo rótulo passando pelo pixel. */
function thickness(labels: Int16Array, w: number, h: number, x: number, y: number, m: number): number {
  const run = (dx: number, dy: number) => {
    let n = 1;
    for (let s = 1; s <= 2; s++) { const xx = x - dx * s, yy = y - dy * s; if (xx < 0 || yy < 0 || xx >= w || yy >= h || labels[yy * w + xx] !== m) break; n++; }
    for (let s = 1; s <= 2; s++) { const xx = x + dx * s, yy = y + dy * s; if (xx < 0 || yy < 0 || xx >= w || yy >= h || labels[yy * w + xx] !== m) break; n++; }
    return Math.min(3, n);
  };
  return Math.min(run(1, 0), run(0, 1));
}

const THIN_CLUSTER = 0.6; // fração mínima de pixels finos para um cluster ser tratado como mistura de rampa

interface Blend { d: number; t: number }

/** Projeta o pixel (Lab `p`, sRGB `px`) no segmento A–B: distância (Lab) e fração de B (sRGB). */
function blend(p: Lab, px: [number, number, number], A: Lab, B: Lab, RA: number[], RB: number[], delta: number): Blend | null {
  const ab = [B[0] - A[0], B[1] - A[1], B[2] - A[2]];
  const L2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  if (L2 < delta * delta) return null; // extremos indistinguíveis
  const t = Math.min(1, Math.max(0, ((p[0] - A[0]) * ab[0] + (p[1] - A[1]) * ab[1] + (p[2] - A[2]) * ab[2]) / L2));
  const q: Lab = [A[0] + t * ab[0], A[1] + t * ab[1], A[2] + t * ab[2]];
  const d = Math.sqrt(dist2(p, q));
  const dr = [RB[0] - RA[0], RB[1] - RA[1], RB[2] - RA[2]];
  const l2 = dr[0] * dr[0] + dr[1] * dr[1] + dr[2] * dr[2] || 1;
  const ts = Math.min(1, Math.max(0, ((px[0] - RA[0]) * dr[0] + (px[1] - RA[1]) * dr[1] + (px[2] - RA[2]) * dr[2]) / l2));
  return { d, t: ts };
}

function neighbours(labels: Int16Array, w: number, h: number, x: number, y: number, m: number, skip: Uint8Array | null): number[] {
  const nb: number[] = [];
  for (let dy = -R; dy <= R; dy++) {
    for (let dx = -R; dx <= R; dx++) {
      const xx = x + dx, yy = y + dy;
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
      const l = labels[yy * w + xx];
      if (l >= 0 && l !== m && !(skip && skip[l]) && !nb.includes(l)) nb.push(l);
    }
  }
  return nb;
}

/**
 * Extremos da rampa: se as cores A e B estão (≤ `tol` ΔE) sobre um segmento E1–E2 mais longo da paleta,
 * A e/ou B são tons intermediários (misturas) e a cobertura deve ser medida entre E1 e E2.
 * Só substitui um extremo se o cluster dele for FINO (maioria dos pixels em franjas/traços de ≤ 2 px) —
 * regiões largas (degradês, áreas cinza reais) continuam intactas.
 */
function rampExtremes(a: number, b: number, palette: Lab[], thinFrac: Float64Array, tol: number): [number, number] {
  const A = palette[a], B = palette[b];
  const lenAB = Math.sqrt(dist2(A, B));
  let best: [number, number] = [a, b], bestLen = lenAB;
  const near = (P: Lab, E1: Lab, E2: Lab) => {
    const ab = [E2[0] - E1[0], E2[1] - E1[1], E2[2] - E1[2]];
    const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
    const t = ((P[0] - E1[0]) * ab[0] + (P[1] - E1[1]) * ab[1] + (P[2] - E1[2]) * ab[2]) / l2;
    if (t < -0.05 || t > 1.05) return false;
    const q: Lab = [E1[0] + t * ab[0], E1[1] + t * ab[1], E1[2] + t * ab[2]];
    return Math.sqrt(dist2(P, q)) <= tol;
  };
  for (let e1 = 0; e1 < palette.length; e1++) {
    for (let e2 = e1 + 1; e2 < palette.length; e2++) {
      const len = Math.sqrt(dist2(palette[e1], palette[e2]));
      if (len <= bestLen + 1) continue;
      if (!near(A, palette[e1], palette[e2]) || !near(B, palette[e1], palette[e2])) continue;
      // os extremos escolhidos só podem trocar clusters pequenos (A/B que não forem eles mesmos)
      const keepsA = e1 === a || e2 === a, keepsB = e1 === b || e2 === b;
      if ((!keepsA && thinFrac[a] < THIN_CLUSTER) || (!keepsB && thinFrac[b] < THIN_CLUSTER)) continue;
      best = [e1, e2]; bestLen = len;
    }
  }
  return best;
}

/**
 * Anti-aliasing: pixels de borda são mistura de duas cores da paleta. Esta etapa
 *  1) descarta clusters “de mistura” (pequenos e explicáveis como mistura de dois outros),
 *  2) estima, para cada pixel de borda, a fração (cobertura) de cada uma das duas cores e
 *  3) realoca o pixel para a cor dominante.
 * A cobertura alimenta o contorno subpixel (`traceField`), eliminando “bolhas” e degraus.
 */
export function resolveTransitions(img: RawImage, labels: Int16Array, palette: Lab[], rgb: [number, number, number][], delta: number, passes = 2): Transitions {
  if (delta <= 0 || palette.length < 3) return NO_TRANSITIONS;
  const { data, width: w, height: h } = img;
  const n = palette.length;
  const pix = (i: number): { lab: Lab; px: [number, number, number] } => {
    const px: [number, number, number] = [data[i * 4], data[i * 4 + 1], data[i * 4 + 2]];
    return { lab: rgbToLab(px[0], px[1], px[2]), px };
  };

  // 1) clusters de mistura
  const tot = new Float64Array(n), expl = new Float64Array(n), thinCnt = new Float64Array(n);
  let opaque = 0;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x, m = labels[i];
      if (m < 0) continue;
      opaque++; tot[m]++;
      if (thickness(labels, w, h, x, y, m) <= 2) thinCnt[m]++;
      const nb = neighbours(labels, w, h, x, y, m, null);
      if (nb.length < 2) continue;
      const { lab, px } = pix(i);
      let ok = false;
      for (let a = 0; a < nb.length && !ok; a++) {
        for (let b = a + 1; b < nb.length && !ok; b++) {
          const r = blend(lab, px, palette[nb[a]], palette[nb[b]], rgb[nb[a]], rgb[nb[b]], delta);
          if (r && r.d < delta) ok = true;
        }
      }
      if (ok) expl[m]++;
    }
  }
  const mix = new Uint8Array(n);
  let kept = n;
  for (let m = 0; m < n; m++) if (tot[m] > 0 && kept > 2 && expl[m] / tot[m] >= 0.5 && tot[m] <= 0.015 * opaque) { mix[m] = 1; kept--; }

  const thinFrac = new Float64Array(n);
  for (let m = 0; m < n; m++) thinFrac[m] = tot[m] ? thinCnt[m] / tot[m] : 0;
  const rampCache = new Map<number, [number, number]>();
  const ramp = (a: number, b: number) => {
    const key = a * n + b;
    let r = rampCache.get(key);
    if (!r) { r = rampExtremes(a, b, palette, thinFrac, 10); rampCache.set(key, r); }
    return r;
  };
  const thin = (src: Int16Array, x: number, y: number, m: number) => thickness(src, w, h, x, y, m) <= 2; // traço de até 2 px
  // 2–3) cobertura e realocação
  const found = new Map<number, [number, number, number]>();
  for (let pass = 0; pass < passes; pass++) {
    const src = labels.slice();
    let any = false;
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = y * w + x, m = src[i];
        if (m < 0) continue;
        const nb = neighbours(src, w, h, x, y, m, mix);
        const own = !mix[m];
        if (own ? nb.length < 1 : nb.length < 1) continue;
        const cand = own ? [m, ...nb] : nb;
        const { lab, px } = pix(i);
        const ownD = Math.sqrt(dist2(lab, palette[m]));
        let bestD = delta * (own ? 1 : 2), ba = -1, bb = -1, bt = 0;
        for (let a = 0; a < cand.length; a++) {
          for (let b = a + 1; b < cand.length; b++) {
            const r = blend(lab, px, palette[cand[a]], palette[cand[b]], rgb[cand[a]], rgb[cand[b]], delta);
            if (!r || r.d >= bestD) continue;
            if (own && a !== 0 && r.d >= ownD) continue; // par sem a cor própria: precisa explicar melhor que ela
            bestD = r.d; ba = cand[a]; bb = cand[b]; bt = r.t;
          }
        }
        if (ba < 0) {
          // cluster de mistura sem par que explique: com ≥ 2 cores vizinhas vai para a mais próxima (franja de AA);
          // com uma só vizinha é tinta isolada (linha fina) e permanece
          if (!own && nb.length >= 2) {
            let bl = nb[0], bd = Infinity;
            for (const l of nb) { const d = dist2(lab, palette[l]); if (d < bd) { bd = d; bl = l; } }
            labels[i] = bl; any = true;
          }
          continue;
        }
        if (thin(src, x, y, m)) {
          // pixel de traço fino: a cobertura é medida entre os EXTREMOS da rampa, não contra cinzas intermediários
          const [e1, e2] = ramp(ba, bb);
          if (e1 !== ba || e2 !== bb) {
            const RA = rgb[e1], RB = rgb[e2];
            const dr = [RB[0] - RA[0], RB[1] - RA[1], RB[2] - RA[2]];
            const l2 = dr[0] * dr[0] + dr[1] * dr[1] + dr[2] * dr[2] || 1;
            const t = Math.min(1, Math.max(0, ((px[0] - RA[0]) * dr[0] + (px[1] - RA[1]) * dr[1] + (px[2] - RA[2]) * dr[2]) / l2));
            ba = e1; bb = e2; bt = t;
          }
        }
        const lab2 = bt < 0.5 ? ba : bb;
        if (lab2 !== m) { labels[i] = lab2; any = true; }
        if (bt > 0.03 && bt < 0.97) found.set(i, [ba, bb, bt]);
        else found.delete(i);
      }
    }
    if (!any) break;
  }
  const k = found.size;
  const out: Transitions = { idx: new Int32Array(k), a: new Int16Array(k), b: new Int16Array(k), t: new Float32Array(k) };
  let j = 0;
  for (const [i, [a, b, t]] of found) { out.idx[j] = i; out.a[j] = a; out.b[j] = b; out.t[j] = t; j++; }
  return out;
}
