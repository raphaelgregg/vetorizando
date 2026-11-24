import { denoise } from './denoise';
import { PRESETS } from './presets';
import type { Options, RawImage } from './types';

/** Características gerais da imagem (calculadas numa versão reduzida), usadas para sugerir o preset e o número de cores. */
export interface ImageProfile {
  dominant: number; // cores (em 4 bits/canal) que ocupam ≥ 0,5 % dos pixels opacos
  flat: number; // fração de pixels em vizinhança plana (variação ≤ 3 níveis)
  mid: number; // fração com variação intermediária (4–40): degradês, sombreado, textura, anti-aliasing largo
  edge: number; // fração com borda forte (> 40)
  transparent: number; // fração de pixels transparentes
}

export function profileImage(img: RawImage, maxSide = 256): ImageProfile {
  const k = Math.max(1, Math.floor(Math.max(img.width, img.height) / maxSide));
  const w = Math.floor(img.width / k), h = Math.floor(img.height / k);
  const small = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    // média do bloco k×k (evita que o ruído fino de imagens grandes pareça textura)
    let r = 0, g = 0, b = 0, a = 0;
    for (let dy = 0; dy < k; dy++) for (let dx = 0; dx < k; dx++) { const i = ((y * k + dy) * img.width + x * k + dx) * 4; r += img.data[i]; g += img.data[i + 1]; b += img.data[i + 2]; a += img.data[i + 3]; }
    const o = (y * w + x) * 4, n = k * k;
    small[o] = r / n; small[o + 1] = g / n; small[o + 2] = b / n; small[o + 3] = a / n;
  }
  // ruído/JPEG inflariam a variação local e a contagem de cores: mede-se a imagem já filtrada (barato em ≤ 256 px)
  const px = denoise({ data: small, width: w, height: h }, 1).image.data;
  const bins = new Map<number, number>();
  let opaque = 0, transparent = 0, flat = 0, mid = 0, edge = 0, tested = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const o = (y * w + x) * 4;
    if (px[o + 3] < 128) { transparent++; continue; }
    opaque++;
    const key = ((px[o] >> 4) << 8) | ((px[o + 1] >> 4) << 4) | (px[o + 2] >> 4);
    bins.set(key, (bins.get(key) ?? 0) + 1);
    if (x === 0 || y === 0 || x === w - 1 || y === h - 1) continue;
    let m = 0;
    for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
      const q = ((y + dy) * w + x + dx) * 4;
      m = Math.max(m, Math.abs(px[q] - px[o]), Math.abs(px[q + 1] - px[o + 1]), Math.abs(px[q + 2] - px[o + 2]));
    }
    tested++;
    if (m <= 3) flat++; else if (m <= 40) mid++; else edge++;
  }
  let dominant = 0;
  for (const c of bins.values()) if (c >= opaque * 0.005) dominant++;
  const t = Math.max(1, tested);
  return { dominant, flat: flat / t, mid: mid / t, edge: edge / t, transparent: transparent / Math.max(1, w * h) };
}

export interface Suggestion {
  preset: string;
  options: Partial<Options>;
  reason: string;
}

/**
 * Escolha automática de preset e nº de cores a partir do perfil da imagem (regras gerais, sem depender do conteúdo):
 *  - poucas cores dominantes e quase sem variação intermediária → arte chapada (logo/ícone/texto);
 *  - muita variação intermediária com muitas cores → foto/arte complexa;
 *  - o resto (degradês, sombreado, ilustração) → ilustração, com cores ≈ dominantes.
 */
export function suggestPreset(p: ImageProfile): Suggestion {
  const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, Math.round(v)));
  if (p.dominant <= 8 && p.mid <= 0.08) {
    return { preset: 'logo', options: { maxColors: clamp(p.dominant + 2, 6, 10) }, reason: `arte chapada (${p.dominant} cores dominantes, poucas transições suaves)` };
  }
  if (p.mid > 0.2 && p.dominant >= 40) {
    return { preset: 'photo', options: { maxColors: clamp(p.dominant * 0.6, 24, 48) }, reason: `muita variação suave e ${p.dominant} cores dominantes (foto/arte complexa)` };
  }
  return { preset: 'illustration', options: { maxColors: clamp(p.dominant * 1.2, 12, 32) }, reason: `${p.dominant} cores dominantes e sombreado/degradês (ilustração)` };
}

export function autoOptions(img: RawImage): { options: Options; suggestion: Suggestion } {
  const s = suggestPreset(profileImage(img));
  const base = PRESETS.find((x) => x.id === s.preset)!.options;
  return { options: { ...base, ...s.options }, suggestion: s };
}
