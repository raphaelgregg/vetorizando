import type { RawImage } from '../engine/types';

/** Um clique da varinha: posição em FRAÇÕES da imagem (vale em qualquer resolução), tolerância 0–100, contígua ou global. */
export interface WandClick { x: number; y: number; tol: number; contiguous: boolean; mode: 'add' | 'sub' }

/** Uma remoção: seleção formada por cliques (somar/subtrair), opcionalmente invertida, com suavização da borda (px a 1000 px de lado). */
export interface Removal { clicks: WandClick[]; invert: boolean; feather: number }

/** distância de cor (redmean, 0–255): mais próxima da percepção que a distância RGB simples */
function dist(r1: number, g1: number, b1: number, r2: number, g2: number, b2: number): number {
  const rm = (r1 + r2) / 2, dr = r1 - r2, dg = g1 - g2, db = b1 - b2;
  return Math.sqrt((2 + rm / 256) * dr * dr + 4 * dg * dg + (2 + (255 - rm) / 256) * db * db) / 3;
}

/** limiar (0–255) para uma tolerância de 0–100 */
const threshold = (tol: number) => Math.max(0, tol) * 1.6;

/**
 * Máscara (0–1) da região parecida com o pixel clicado. Dentro do limiar = 1; logo acima dele a cobertura cai
 * linearmente (borda suave, sem serrilhado). Contígua: só os pixels ligados ao clique (vizinhança 4); global: toda a imagem.
 * Pixels já transparentes nunca entram.
 */
export function wandMask(img: RawImage, c: WandClick): Float32Array {
  const { width: w, height: h, data } = img;
  const mask = new Float32Array(w * h);
  const sx = Math.min(w - 1, Math.max(0, Math.round(c.x * (w - 1)))), sy = Math.min(h - 1, Math.max(0, Math.round(c.y * (h - 1))));
  // cor de referência: média 3×3 dos pixels opacos ao redor do clique (aguenta ruído)
  let r = 0, g = 0, b = 0, n = 0;
  for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
    const x = sx + dx, y = sy + dy;
    if (x < 0 || y < 0 || x >= w || y >= h) continue;
    const o = (y * w + x) * 4;
    if (data[o + 3] < 128) continue;
    r += data[o]; g += data[o + 1]; b += data[o + 2]; n++;
  }
  if (!n) return mask; // clicou numa área já transparente
  r /= n; g /= n; b /= n;
  const T = threshold(c.tol), ramp = Math.max(3, T * 0.25);
  const cov = (i: number): number => {
    const o = i * 4;
    if (data[o + 3] < 16) return 0;
    const d = dist(data[o], data[o + 1], data[o + 2], r, g, b);
    return d <= T ? 1 : d >= T + ramp ? 0 : 1 - (d - T) / ramp;
  };
  if (!c.contiguous) { for (let i = 0; i < w * h; i++) mask[i] = cov(i); return mask; }
  const seen = new Uint8Array(w * h), stack = new Int32Array(w * h);
  let sp = 0;
  const s0 = sy * w + sx;
  stack[sp++] = s0; seen[s0] = 1;
  while (sp) {
    const i = stack[--sp], m = cov(i);
    if (m <= 0) continue;
    mask[i] = m;
    const x = i % w, y = (i / w) | 0;
    if (x > 0 && !seen[i - 1]) { seen[i - 1] = 1; stack[sp++] = i - 1; }
    if (x < w - 1 && !seen[i + 1]) { seen[i + 1] = 1; stack[sp++] = i + 1; }
    if (y > 0 && !seen[i - w]) { seen[i - w] = 1; stack[sp++] = i - w; }
    if (y < h - 1 && !seen[i + w]) { seen[i + w] = 1; stack[sp++] = i + w; }
  }
  return mask;
}

/** Seleção composta: cada clique soma (união) ou subtrai; `invert` seleciona o resto. */
export function selectionMask(img: RawImage, clicks: WandClick[], invert = false): Float32Array {
  const n = img.width * img.height;
  const sel = new Float32Array(n);
  for (const c of clicks) {
    const m = wandMask(img, c);
    if (c.mode === 'add') for (let i = 0; i < n; i++) { if (m[i] > sel[i]) sel[i] = m[i]; }
    else for (let i = 0; i < n; i++) sel[i] *= 1 - m[i];
  }
  if (invert) for (let i = 0; i < n; i++) sel[i] = 1 - sel[i];
  return sel;
}

/** suaviza a máscara (caixa 2× ≈ gaussiana) */
function blurMask(m: Float32Array, w: number, h: number, radius: number): Float32Array {
  const R = Math.round(radius);
  if (R < 1) return m;
  const pass = (src: Float32Array, horizontal: boolean): Float32Array => {
    const out = new Float32Array(src.length), len = horizontal ? w : h, lines = horizontal ? h : w;
    for (let l = 0; l < lines; l++) {
      let acc = 0;
      const at = (k: number) => src[horizontal ? l * w + Math.min(len - 1, Math.max(0, k)) : Math.min(len - 1, Math.max(0, k)) * w + l];
      for (let k = -R; k <= R; k++) acc += at(k);
      for (let k = 0; k < len; k++) {
        out[horizontal ? l * w + k : k * w + l] = acc / (2 * R + 1);
        acc += at(k + R + 1) - at(k - R);
      }
    }
    return out;
  };
  return pass(pass(pass(pass(m, true), false), true), false);
}

/** Torna transparente a região selecionada (multiplica o alfa por 1 − máscara). */
export function applyRemoval(img: RawImage, rem: Removal): RawImage {
  const { width: w, height: h } = img;
  let m = selectionMask(img, rem.clicks, rem.invert);
  m = blurMask(m, w, h, (rem.feather * Math.max(w, h)) / 1000);
  const out = new Uint8ClampedArray(img.data);
  for (let i = 0; i < w * h; i++) if (m[i] > 0) out[i * 4 + 3] = Math.round(out[i * 4 + 3] * (1 - Math.min(1, m[i])));
  return { data: out, width: w, height: h };
}

export function applyRemovals(img: RawImage, list: Removal[]): RawImage {
  let r = img;
  for (const rem of list) if (rem.clicks.length) r = applyRemoval(r, rem);
  return r;
}

/** Remover fundo: varinha contígua nos 4 cantos (e no meio das bordas) com a tolerância dada. */
export function backgroundRemoval(tol: number, feather = 1): Removal {
  const pts: [number, number][] = [[0, 0], [1, 0], [0, 1], [1, 1], [0.5, 0], [0.5, 1], [0, 0.5], [1, 0.5]];
  return { clicks: pts.map(([x, y]) => ({ x, y, tol, contiguous: true, mode: 'add' as const })), invert: false, feather };
}

/** Realce da seleção para a prévia: vermelho translúcido sobre a região (RGBA). */
export function selectionOverlay(mask: Float32Array, w: number, h: number): RawImage {
  const out = new Uint8ClampedArray(w * h * 4);
  for (let i = 0; i < w * h; i++) if (mask[i] > 0.02) { out[i * 4] = 255; out[i * 4 + 1] = 40; out[i * 4 + 2] = 90; out[i * 4 + 3] = Math.round(mask[i] * 140); }
  return { data: out, width: w, height: h };
}
