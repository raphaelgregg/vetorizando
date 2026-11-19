import type { RawImage } from './types';

/**
 * Pré-filtro de ruído e artefatos de compressão com preservação de bordas.
 *
 * Detecta DOIS tipos de degradação e só filtra quando há evidência (imagens limpas passam intactas):
 *  - ruído em áreas planas: σ pelo kernel de Immerkær ([1 −2 1; −2 4 −2; 1 −2 1]) em pixels sem borda (mediana/0,6745/6);
 *  - ringing/“mosquito noise” de JPEG: resíduo do mesmo kernel na zona a ≤ 6 px de uma borda forte, onde uma imagem
 *    limpa é exatamente plana — o percentil 90 é 0 em imagens limpas e ≥ 9 até em JPEG q95.
 * O filtro é bilateral (média ponderada por proximidade e por semelhança de cor; σr proporcional ao ruído estimado):
 * bordas, cantos e linhas finas de alto contraste não são misturados com o outro lado, e áreas exatamente planas são puladas.
 */
export interface NoiseEstimate {
  /** σ do ruído em áreas planas (por canal RGB) */
  flat: number;
  /** percentil 90 do resíduo perto das bordas (0 em imagem limpa) */
  ringing: number;
  /** nível efetivo usado para dimensionar o filtro (0 = nada a filtrar) */
  sigma: number;
  /** tipo dominante: ruído branco (áreas planas) ou artefatos de compressão (ringing perto das bordas) */
  kind: 'none' | 'noise' | 'jpeg';
}

export interface DenoiseResult { image: RawImage; noise: NoiseEstimate; applied: boolean }

const LUMA_TO_RGB = 1 / 0.67; // ruído independente por canal aparece ×0,67 na luminância
const P90_PER_SIGMA = 9.9; // p90 de |kernel| para ruído gaussiano: 1,645 · 6σ
const FLAT_MIN = 0.9; // σ mínimo (por canal) para considerar ruído em áreas planas
const RING_MIN = 3; // p90 mínimo do resíduo perto das bordas para considerar artefatos JPEG
const NEAR_EDGE = 6; // px
const GRAD_FLAT = 60, GRAD_STRONG = 240; // limiares de Sobel (luminância)

function luma(img: RawImage): Float32Array {
  const { width: w, height: h, data } = img;
  const L = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) L[i] = 0.299 * data[i * 4] + 0.587 * data[i * 4 + 1] + 0.114 * data[i * 4 + 2];
  return L;
}

/** dilatação separável (janela quadrada de raio R) de uma máscara binária, em O(n) */
function dilate(mask: Uint8Array, w: number, h: number, R: number): Uint8Array {
  const tmp = new Uint8Array(w * h), out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    let cnt = 0;
    for (let x = 0; x < Math.min(w, R); x++) cnt += mask[y * w + x];
    for (let x = 0; x < w; x++) {
      if (x + R < w) cnt += mask[y * w + x + R];
      if (x - R - 1 >= 0) cnt -= mask[y * w + x - R - 1];
      tmp[y * w + x] = cnt > 0 ? 1 : 0;
    }
  }
  for (let x = 0; x < w; x++) {
    let cnt = 0;
    for (let y = 0; y < Math.min(h, R); y++) cnt += tmp[y * w + x];
    for (let y = 0; y < h; y++) {
      if (y + R < h) cnt += tmp[(y + R) * w + x];
      if (y - R - 1 >= 0) cnt -= tmp[(y - R - 1) * w + x];
      out[y * w + x] = cnt > 0 ? 1 : 0;
    }
  }
  return out;
}

export function estimateNoise(img: RawImage): NoiseEstimate {
  const { width: w, height: h, data } = img;
  if (w < 8 || h < 8) return { flat: 0, ringing: 0, sigma: 0, kind: 'none' };
  const L = luma(img);
  const grad = new Float32Array(w * h), res = new Float32Array(w * h), strong = new Uint8Array(w * h);
  const ok = new Uint8Array(w * h); // pixel opaco (a estimativa ignora transparência)
  for (let i = 0; i < w * h; i++) ok[i] = data[i * 4 + 3] === 255 ? 1 : 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const a = L[i - w - 1], b = L[i - w], c = L[i - w + 1], d = L[i - 1], e = L[i], f = L[i + 1], g = L[i + w - 1], hh = L[i + w], k = L[i + w + 1];
      const gx = c + 2 * f + k - a - 2 * d - g, gy = g + 2 * hh + k - a - 2 * b - c;
      const m = Math.hypot(gx, gy);
      grad[i] = m;
      res[i] = Math.abs(a - 2 * b + c - 2 * d + 4 * e - 2 * f + g - 2 * hh + k);
      if (m > GRAD_STRONG) strong[i] = 1;
    }
  }
  const near = dilate(strong, w, h, NEAR_EDGE);
  const flatRes: number[] = [], nearRes: number[] = [];
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      if (!ok[i] || grad[i] >= GRAD_FLAT) continue;
      flatRes.push(res[i]);
      if (near[i]) nearRes.push(res[i]);
    }
  }
  const q = (v: number[], p: number) => { if (!v.length) return 0; v.sort((x, y) => x - y); return v[Math.min(v.length - 1, Math.floor(v.length * p))]; };
  const flat = (q(flatRes, 0.5) / 0.6745 / 6) * LUMA_TO_RGB;
  const ringing = nearRes.length >= 200 ? q(nearRes, 0.9) : 0;
  const sFlat = flat >= FLAT_MIN ? flat : 0;
  const sRing = ringing > RING_MIN ? ringing / P90_PER_SIGMA : 0;
  return { flat, ringing, sigma: Math.max(sFlat, sRing), kind: sFlat === 0 && sRing === 0 ? 'none' : sFlat >= sRing ? 'noise' : 'jpeg' };
}

/**
 * Parâmetros por tipo de degradação (calibrados no `npm run bench:stress`):
 *  - ruído branco: filtro suave (σ de cor ≈ 3σ̂; 1–3 passadas conforme o nível) — mais forte que isso funde bandas de degradê;
 *  - JPEG: a blocagem 8×8 cria degraus maiores que o ruído medido, então o σ de cor é bem maior (≈ 10σ̂), 2 passadas.
 */
const PARAMS = {
  noise: { k: 3, min: 4, max: 60 },
  jpeg: { k: 10, min: 4, max: 60 },
} as const;

/** Bilateral adaptativo. `strength` multiplica o σ de cor (0 = desligado, 1 = automático). */
export function denoise(img: RawImage, strength = 1): DenoiseResult {
  if (strength <= 0) return { image: img, noise: { flat: 0, ringing: 0, sigma: 0, kind: 'none' }, applied: false };
  const noise = estimateNoise(img);
  if (noise.sigma <= 0) return { image: img, noise, applied: false };
  const { width: w, height: h } = img;
  const pr = PARAMS[noise.kind === 'jpeg' ? 'jpeg' : 'noise'];
  const sr = Math.min(pr.max, Math.max(pr.min, noise.sigma * pr.k)) * strength;
  const jpegMode = noise.kind === 'jpeg';
  const R = jpegMode ? 3 : noise.sigma < 2.5 ? 2 : 3;
  const passes = jpegMode ? 2 : noise.sigma < 2.5 ? 1 : noise.sigma < 6 ? 2 : 3;
  const cap = Math.ceil((3 * sr) ** 2);
  const lut = new Float32Array(cap + 1);
  for (let d = 0; d <= cap; d++) lut[d] = Math.exp(-d / (2 * sr * sr));
  const ss = 1.5 * (R / 2); // σ espacial
  const sw: number[] = [];
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) sw.push(Math.exp(-(dx * dx + dy * dy) / (2 * ss * ss)));

  let cur = img.data;
  for (let pass = 0; pass < passes; pass++) {
    const out = new Uint8ClampedArray(cur);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        const i = (y * w + x) * 4;
        if (cur[i + 3] < 128) continue;
        const r0 = cur[i], g0 = cur[i + 1], b0 = cur[i + 2];
        let sr_ = 0, sg = 0, sb = 0, sw_ = 0, varied = false, k = 0;
        for (let dy = -R; dy <= R; dy++) {
          const yy = y + dy;
          if (yy < 0 || yy >= h) { k += 2 * R + 1; continue; }
          for (let dx = -R; dx <= R; dx++, k++) {
            const xx = x + dx;
            if (xx < 0 || xx >= w) continue;
            const j = (yy * w + xx) * 4;
            if (cur[j + 3] < 128) continue;
            const dr = cur[j] - r0, dg = cur[j + 1] - g0, db = cur[j + 2] - b0;
            const d2 = dr * dr + dg * dg + db * db;
            if (d2 > cap) { varied = true; continue; }
            if (d2) varied = true;
            const wgt = sw[k] * lut[d2];
            sr_ += wgt * cur[j]; sg += wgt * cur[j + 1]; sb += wgt * cur[j + 2]; sw_ += wgt;
          }
        }
        if (!varied || sw_ === 0) continue; // vizinhança exatamente plana: nada a fazer
        out[i] = sr_ / sw_; out[i + 1] = sg / sw_; out[i + 2] = sb / sw_;
      }
    }
    cur = out;
  }
  return { image: { data: cur as Uint8ClampedArray, width: w, height: h }, noise, applied: true };
}
