import type { RawImage } from '../engine/types';

/** Retângulo de recorte em FRAÇÕES (0–1) da imagem já girada/espelhada: independe da resolução (prévia × original). */
export interface CropRect { x: number; y: number; w: number; h: number }

export interface Transform {
  rotate: 0 | 90 | 180 | 270; // giro em passos de 90° (horário)
  flipH: boolean;
  flipV: boolean;
  angle: number; // endireitar: -45…45° (horário positivo); a imagem ganha cantos transparentes
  crop: CropRect | null; // null = sem recorte
}

export const IDENTITY: Transform = { rotate: 0, flipH: false, flipV: false, angle: 0, crop: null };

/** Forma do recorte aplicada à saída */
export type CropShape = 'rect' | 'rounded' | 'ellipse';

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));

/** Gira em passos de 90° no sentido horário. */
export function rotate90(img: RawImage, turns: number): RawImage {
  const k = ((Math.round(turns) % 4) + 4) % 4;
  if (!k) return img;
  const { width: w, height: h } = img;
  const [W, H] = k === 2 ? [w, h] : [h, w];
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const nx = k === 1 ? h - 1 - y : k === 2 ? w - 1 - x : y;
    const ny = k === 1 ? x : k === 2 ? h - 1 - y : w - 1 - x;
    out.set(img.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (ny * W + nx) * 4);
  }
  return { data: out, width: W, height: H };
}

export function flip(img: RawImage, horizontal: boolean, vertical: boolean): RawImage {
  if (!horizontal && !vertical) return img;
  const { width: w, height: h } = img;
  const out = new Uint8ClampedArray(img.data.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const sx = horizontal ? w - 1 - x : x, sy = vertical ? h - 1 - y : y;
    out.set(img.data.subarray((sy * w + sx) * 4, (sy * w + sx) * 4 + 4), (y * w + x) * 4);
  }
  return { data: out, width: w, height: h };
}

/** Tamanho da tela que contém a imagem girada de `deg` graus. */
export function expandedSize(w: number, h: number, deg: number): [number, number] {
  const a = (Math.abs(deg) * Math.PI) / 180, c = Math.abs(Math.cos(a)), s = Math.abs(Math.sin(a));
  return [Math.max(1, Math.ceil(w * c + h * s - 1e-6)), Math.max(1, Math.ceil(w * s + h * c - 1e-6))];
}

/** Gira por um ângulo qualquer (interpolação bilinear com alfa); os cantos novos ficam transparentes. */
export function rotateAngle(img: RawImage, deg: number): RawImage {
  if (Math.abs(deg) < 1e-6) return img;
  const { width: w, height: h } = img;
  const [W, H] = expandedSize(w, h, deg);
  const a = (deg * Math.PI) / 180, c = Math.cos(a), s = Math.sin(a);
  const out = new Uint8ClampedArray(W * H * 4);
  const cx = w / 2, cy = h / 2, dx = W / 2, dy = H / 2;
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    // ponto de destino → origem (rotação inversa)
    const px = x + 0.5 - dx, py = y + 0.5 - dy;
    const sx = c * px + s * py + cx - 0.5, sy = -s * px + c * py + cy - 0.5;
    const x0 = Math.floor(sx), y0 = Math.floor(sy), fx = sx - x0, fy = sy - y0;
    let r = 0, g = 0, b = 0, al = 0;
    for (let j = 0; j < 2; j++) for (let i = 0; i < 2; i++) {
      const xx = x0 + i, yy = y0 + j, wgt = (i ? fx : 1 - fx) * (j ? fy : 1 - fy);
      if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue; // fora = transparente
      const o = (yy * w + xx) * 4, aa = (img.data[o + 3] / 255) * wgt;
      r += img.data[o] * aa; g += img.data[o + 1] * aa; b += img.data[o + 2] * aa; al += aa;
    }
    const o = (y * W + x) * 4;
    if (al > 1e-4) { out[o] = r / al; out[o + 1] = g / al; out[o + 2] = b / al; out[o + 3] = Math.round(al * 255); }
  }
  return { data: out, width: W, height: H };
}

/** Giro de 90°, espelhos e endireitar (sem recorte). */
export function applyTransform(img: RawImage, t: Transform): RawImage {
  return rotateAngle(flip(rotate90(img, t.rotate / 90), t.flipH, t.flipV), t.angle);
}

/** Recorta por fração (arredondando para pixels inteiros, sempre ≥ 1 px). */
export function cropFrac(img: RawImage, r: CropRect): RawImage {
  const { width: w, height: h } = img;
  const x0 = clamp(Math.round(r.x * w), 0, w - 1), y0 = clamp(Math.round(r.y * h), 0, h - 1);
  const cw = clamp(Math.round(r.w * w), 1, w - x0), ch = clamp(Math.round(r.h * h), 1, h - y0);
  if (x0 === 0 && y0 === 0 && cw === w && ch === h) return img;
  const out = new Uint8ClampedArray(cw * ch * 4);
  for (let y = 0; y < ch; y++) out.set(img.data.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + cw) * 4), y * cw * 4);
  return { data: out, width: cw, height: ch };
}

/** Transformação + recorte. */
export function prepare(img: RawImage, t: Transform): RawImage {
  const g = applyTransform(img, t);
  return t.crop ? cropFrac(g, t.crop) : g;
}

/** Maior retângulo alinhado aos eixos que cabe DENTRO da imagem girada `deg` (sem cantos transparentes), em frações da tela expandida. */
export function inscribedRect(w: number, h: number, deg: number): CropRect {
  const a = (Math.abs(deg) * Math.PI) / 180;
  if (a < 1e-6) return { x: 0, y: 0, w: 1, h: 1 };
  const sin = Math.sin(a), cos = Math.cos(a);
  const longer = w >= h, L = longer ? w : h, S = longer ? h : w;
  let wr: number, hr: number;
  if (S <= 2 * sin * cos * L || Math.abs(sin - cos) < 1e-10) { const x = 0.5 * S; wr = longer ? x / sin : x / cos; hr = longer ? x / cos : x / sin; }
  else { const c2 = cos * cos - sin * sin; wr = (w * cos - h * sin) / c2; hr = (h * cos - w * sin) / c2; }
  const [W, H] = expandedSize(w, h, deg);
  const fw = Math.min(1, wr / W), fh = Math.min(1, hr / H);
  return { x: (1 - fw) / 2, y: (1 - fh) / 2, w: fw, h: fh };
}

/** Maior retângulo de proporção `ratio` (largura/altura) que cabe em `w`×`h`, centrado em (cx, cy) em frações, sem sair da imagem. */
export function ratioRect(w: number, h: number, ratio: number, cx = 0.5, cy = 0.5, maxFrac = 1): CropRect {
  let rw = maxFrac, rh = (maxFrac * w) / (h * ratio);
  if (rh > maxFrac) { rh = maxFrac; rw = (maxFrac * h * ratio) / w; }
  return { x: clamp(cx - rw / 2, 0, 1 - rw), y: clamp(cy - rh / 2, 0, 1 - rh), w: rw, h: rh };
}

/** Bordas uniformes (cor do canto) ou transparentes: devolve o retângulo do conteúdo, ou null se não há o que aparar. */
export function autoTrimRect(img: RawImage, tol = 14): CropRect | null {
  const { width: w, height: h, data } = img;
  const at = (x: number, y: number) => (y * w + x) * 4;
  const transparent = data[3] < 16 && data[at(w - 1, h - 1) + 3] < 16;
  const ref = [data[0], data[1], data[2]];
  const isBg = (x: number, y: number) => {
    const o = at(x, y);
    if (transparent) return data[o + 3] < 16;
    return data[o + 3] > 200 && Math.abs(data[o] - ref[0]) <= tol && Math.abs(data[o + 1] - ref[1]) <= tol && Math.abs(data[o + 2] - ref[2]) <= tol;
  };
  const rowBg = (y: number) => { for (let x = 0; x < w; x++) if (!isBg(x, y)) return false; return true; };
  const colBg = (x: number) => { for (let y = 0; y < h; y++) if (!isBg(x, y)) return false; return true; };
  let t = 0, b = h - 1, l = 0, r = w - 1;
  while (t < b && rowBg(t)) t++;
  while (b > t && rowBg(b)) b--;
  while (l < r && colBg(l)) l++;
  while (r > l && colBg(r)) r--;
  if (t === 0 && l === 0 && b === h - 1 && r === w - 1) return null;
  if (r - l < 2 || b - t < 2) return null;
  return { x: l / w, y: t / h, w: (r - l + 1) / w, h: (b - t + 1) / h };
}

/** Proporções de recorte mais comuns. `ratio`: número = largura/altura; 'free' = livre; 'original' e 'output' são resolvidas no uso. */
export const ASPECTS: { id: string; label: string; ratio: number | 'free' | 'original' | 'output' }[] = [
  { id: 'free', label: 'Livre', ratio: 'free' },
  { id: 'original', label: 'Original', ratio: 'original' },
  { id: 'output', label: 'Do tamanho de saída', ratio: 'output' },
  { id: '1:1', label: '1:1 — quadrado', ratio: 1 },
  { id: '4:5', label: '4:5 — retrato (Instagram)', ratio: 4 / 5 },
  { id: '5:4', label: '5:4', ratio: 5 / 4 },
  { id: '3:4', label: '3:4', ratio: 3 / 4 },
  { id: '4:3', label: '4:3', ratio: 4 / 3 },
  { id: '2:3', label: '2:3', ratio: 2 / 3 },
  { id: '3:2', label: '3:2 — foto', ratio: 3 / 2 },
  { id: '9:16', label: '9:16 — story/vertical', ratio: 9 / 16 },
  { id: '16:9', label: '16:9 — widescreen', ratio: 16 / 9 },
  { id: '2:1', label: '2:1', ratio: 2 },
  { id: '3:1', label: '3:1 — banner', ratio: 3 },
  { id: '4:1', label: '4:1 — banner', ratio: 4 },
];
