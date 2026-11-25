import type { RawImage } from '../engine/types';

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const rgbOf = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
const copy = (img: RawImage): RawImage => ({ data: new Uint8ClampedArray(img.data), width: img.width, height: img.height });

export function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  r /= 255; g /= 255; b /= 255;
  const max = Math.max(r, g, b), min = Math.min(r, g, b), l = (max + min) / 2, d = max - min;
  if (d === 0) return [0, 0, l];
  const s = d / (1 - Math.abs(2 * l - 1));
  const h = max === r ? ((g - b) / d + (g < b ? 6 : 0)) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return [h * 60, s, l];
}

export function hslToRgb(h: number, s: number, l: number): [number, number, number] {
  h = ((h % 360) + 360) % 360;
  const c = (1 - Math.abs(2 * l - 1)) * s, x = c * (1 - Math.abs(((h / 60) % 2) - 1)), m = l - c / 2;
  const [r, g, b] = h < 60 ? [c, x, 0] : h < 120 ? [x, c, 0] : h < 180 ? [0, c, x] : h < 240 ? [0, x, c] : h < 300 ? [x, 0, c] : [c, 0, x];
  return [(r + m) * 255, (g + m) * 255, (b + m) * 255];
}

/** Gira o matiz de todas as cores (−180…180°); cinzas não mudam. */
export function hueShift(img: RawImage, deg: number): RawImage {
  if (!deg) return img;
  const out = copy(img);
  for (let i = 0; i < out.data.length; i += 4) {
    const [h, s, l] = rgbToHsl(out.data[i], out.data[i + 1], out.data[i + 2]);
    if (s < 0.001) continue;
    const [r, g, b] = hslToRgb(h + deg, s, l);
    out.data[i] = clamp8(r); out.data[i + 1] = clamp8(g); out.data[i + 2] = clamp8(b);
  }
  return out;
}

/** Filtros de cor prontos */
export const FILTERS: { id: string; label: string }[] = [
  { id: 'none', label: 'Nenhum' },
  { id: 'bw', label: 'Preto e branco' },
  { id: 'sepia', label: 'Sépia' },
  { id: 'cool', label: 'Frio' },
  { id: 'warm', label: 'Quente' },
  { id: 'vintage', label: 'Vintage' },
  { id: 'fade', label: 'Desbotado' },
  { id: 'dramatic', label: 'Dramático' },
  { id: 'invert', label: 'Negativo (invertido)' },
];

/** aplica o filtro `id` com intensidade 0–100 (mistura com o original) */
export function applyFilter(img: RawImage, id: string, amount = 100): RawImage {
  if (id === 'none' || amount <= 0) return img;
  const k = Math.min(1, amount / 100), out = copy(img);
  for (let i = 0; i < out.data.length; i += 4) {
    const r = out.data[i], g = out.data[i + 1], b = out.data[i + 2], y = 0.299 * r + 0.587 * g + 0.114 * b;
    let nr = r, ng = g, nb = b;
    switch (id) {
      case 'bw': nr = ng = nb = y; break;
      case 'sepia': nr = 0.393 * r + 0.769 * g + 0.189 * b; ng = 0.349 * r + 0.686 * g + 0.168 * b; nb = 0.272 * r + 0.534 * g + 0.131 * b; break;
      case 'cool': nr = r * 0.9; ng = g * 1.0; nb = b * 1.15 + 6; break;
      case 'warm': nr = r * 1.12 + 6; ng = g * 1.02; nb = b * 0.85; break;
      case 'vintage': nr = 0.6 * r + 0.3 * g + 0.1 * b + 20; ng = 0.2 * r + 0.65 * g + 0.15 * b + 8; nb = 0.15 * r + 0.25 * g + 0.5 * b + 4; break;
      case 'fade': nr = r * 0.8 + 38; ng = g * 0.8 + 36; nb = b * 0.8 + 40; break;
      case 'dramatic': { const f = (v: number) => (v - 128) * 1.35 + 128; const s = (v: number) => y + (v - y) * 0.75; nr = f(s(r)); ng = f(s(g)); nb = f(s(b)); break; }
      case 'invert': nr = 255 - r; ng = 255 - g; nb = 255 - b; break;
    }
    out.data[i] = clamp8(r + (nr - r) * k); out.data[i + 1] = clamp8(g + (ng - g) * k); out.data[i + 2] = clamp8(b + (nb - b) * k);
  }
  return out;
}

/** Colorir: mistura uma cor sobre a imagem mantendo a luminosidade (quantidade 0–100). */
export function tint(img: RawImage, color: string | null, amount: number): RawImage {
  if (!color || amount <= 0) return img;
  const [tr, tg, tb] = rgbOf(color), [th, ts] = rgbToHsl(tr, tg, tb), k = Math.min(1, amount / 100), out = copy(img);
  for (let i = 0; i < out.data.length; i += 4) {
    const [, , l] = rgbToHsl(out.data[i], out.data[i + 1], out.data[i + 2]);
    const [cr, cg, cb] = hslToRgb(th, ts, l);
    out.data[i] = clamp8(out.data[i] + (cr - out.data[i]) * k); out.data[i + 1] = clamp8(out.data[i + 1] + (cg - out.data[i + 1]) * k); out.data[i + 2] = clamp8(out.data[i + 2] + (cb - out.data[i + 2]) * k);
  }
  return out;
}

export interface ColorReplace { from: string; to: string; tol: number }

/**
 * Substitui uma cor: pixels parecidos com `from` (tolerância 0–100, borda suave) ganham o matiz/saturação de `to`,
 * mantendo o relevo de luminosidade (sombras e brilhos continuam).
 */
export function replaceColors(img: RawImage, list: ColorReplace[]): RawImage {
  if (!list.length) return img;
  let cur = img;
  for (const rep of list) {
    const [fr, fg, fb] = rgbOf(rep.from), [tr, tg, tb] = rgbOf(rep.to);
    const [, fs, fl] = rgbToHsl(fr, fg, fb), [th, ts, tl] = rgbToHsl(tr, tg, tb);
    const T = rep.tol * 1.6, ramp = Math.max(3, T * 0.25), out = copy(cur);
    for (let i = 0; i < out.data.length; i += 4) {
      if (out.data[i + 3] < 8) continue;
      const r = out.data[i], g = out.data[i + 1], b = out.data[i + 2], rm = (r + fr) / 2;
      const d = Math.sqrt((2 + rm / 256) * (r - fr) ** 2 + 4 * (g - fg) ** 2 + (2 + (255 - rm) / 256) * (b - fb) ** 2) / 3;
      const w = d <= T ? 1 : d >= T + ramp ? 0 : 1 - (d - T) / ramp;
      if (w <= 0) continue;
      const [, s, l] = rgbToHsl(r, g, b);
      const [nr, ng, nb] = hslToRgb(th, Math.min(1, ts * (fs > 0.05 ? s / fs : 1)), Math.min(1, Math.max(0, l + (tl - fl))));
      out.data[i] = clamp8(r + (nr - r) * w); out.data[i + 1] = clamp8(g + (ng - g) * w); out.data[i + 2] = clamp8(b + (nb - b) * w);
    }
    cur = out;
  }
  return cur;
}
