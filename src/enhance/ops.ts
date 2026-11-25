import { denoise } from '../engine/denoise';
import type { RawImage } from '../engine/types';
import { ColorReplace, FILTERS, applyFilter, hueShift, replaceColors, tint } from './colors';
import { CropShape, Transform, prepare } from './crop';
import { Overlay, drawOverlays } from './overlay';
import { Removal, applyRemovals } from './wand';

/** Parâmetros da melhoria de imagem (sem vetorizar). Controles de -100 a 100 são neutros em 0. */
export interface EnhanceParams {
  auto: boolean; // corrige níveis (ponto preto/branco) pelo histograma de luminosidade
  whiteBalance: boolean; // balanço de branco (mundo cinza)
  brightness: number;
  contrast: number;
  saturation: number;
  temperature: number; // + quente (laranja) · − frio (azul)
  denoise: number; // 0 = desligado · 1 = automático (só com ruído/JPEG detectado) · até 3 = mais forte
  sharpen: number; // 0–100 (máscara de nitidez)
  hue: number; // −180…180° (gira o matiz)
  filter: string; // filtro de cor pronto (ver FILTERS); 'none' = nenhum
  filterAmount: number; // 0–100
  tint: string | null; // cor para colorir (#rrggbb)
  tintAmount: number; // 0–100
  replaces: ColorReplace[]; // substituições de cor
}

export const NEUTRAL: EnhanceParams = { auto: false, whiteBalance: false, brightness: 0, contrast: 0, saturation: 0, temperature: 0, denoise: 0, sharpen: 0, hue: 0, filter: 'none', filterAmount: 100, tint: null, tintAmount: 0, replaces: [] };
/** "Melhorar automaticamente": níveis, leve saturação, remoção de ruído/artefatos só se detectados e nitidez moderada. */
export const AUTO_PARAMS: EnhanceParams = { auto: true, whiteBalance: false, brightness: 0, contrast: 0, saturation: 8, temperature: 0, denoise: 1, sharpen: 35, hue: 0, filter: 'none', filterAmount: 100, tint: null, tintAmount: 0, replaces: [] };

export interface OutputSpec {
  width: number;
  height: number;
  fit: 'cover' | 'contain'; // cover = preenche e corta; contain = cabe inteira, com bordas
  fx: number; // posição do corte/colocação (0–1)
  fy: number;
  background: string | null; // cor das bordas em "contain"; null = transparente
  circle: boolean; // recorte circular (cantos transparentes); equivale a shape = 'ellipse'
  shape?: CropShape; // forma do recorte: retângulo, retângulo arredondado ou elipse (círculo se quadrado)
  radius?: number; // arredondamento (0–0,5 do menor lado) para 'rounded'
}

const clamp8 = (v: number) => (v < 0 ? 0 : v > 255 ? 255 : v);
const copy = (img: RawImage): RawImage => ({ data: new Uint8ClampedArray(img.data), width: img.width, height: img.height });

/** Níveis automáticos: pontos preto/branco pelos percentis 0,5 % / 99,5 % da luminosidade, aplicados igual aos 3 canais (não muda o matiz). */
export function autoLevels(img: RawImage): RawImage {
  const hist = new Uint32Array(256);
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) {
    if (img.data[i + 3] < 128) continue;
    hist[Math.round(0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2])]++;
    n++;
  }
  if (!n) return img;
  const at = (q: number) => { let a = 0; for (let v = 0; v < 256; v++) { a += hist[v]; if (a >= n * q) return v; } return 255; };
  const lo = Math.min(at(0.005), 90), hi = Math.max(at(0.995), 165); // limites: não estica além do razoável (cenas escuras/claras mantêm o clima)
  if (hi - lo < 20 || (lo <= 2 && hi >= 253)) return img;
  const lut = new Uint8ClampedArray(256);
  for (let v = 0; v < 256; v++) lut[v] = clamp8(((v - lo) * 255) / (hi - lo));
  const out = copy(img);
  for (let i = 0; i < out.data.length; i += 4) { out.data[i] = lut[out.data[i]]; out.data[i + 1] = lut[out.data[i + 1]]; out.data[i + 2] = lut[out.data[i + 2]]; }
  return out;
}

/** Balanço de branco "mundo cinza": iguala as médias dos canais (fator limitado a 0,8–1,25 e atenuado). */
export function grayWorld(img: RawImage): RawImage {
  const m = [0, 0, 0];
  let n = 0;
  for (let i = 0; i < img.data.length; i += 4) { if (img.data[i + 3] < 128) continue; m[0] += img.data[i]; m[1] += img.data[i + 1]; m[2] += img.data[i + 2]; n++; }
  if (!n) return img;
  const avg = (m[0] + m[1] + m[2]) / (3 * n);
  const f = m.map((s) => Math.min(1.25, Math.max(0.8, avg / Math.max(1, s / n))) ** 0.7);
  if (f.every((x) => Math.abs(x - 1) < 0.005)) return img;
  const out = copy(img);
  for (let i = 0; i < out.data.length; i += 4) for (let c = 0; c < 3; c++) out.data[i + c] = clamp8(out.data[i + c] * f[c]);
  return out;
}

/** Brilho, contraste, temperatura (por tabela) e saturação. */
export function adjust(img: RawImage, p: Pick<EnhanceParams, 'brightness' | 'contrast' | 'saturation' | 'temperature'>): RawImage {
  if (!p.brightness && !p.contrast && !p.saturation && !p.temperature) return img;
  const c = p.contrast * 2.55, cf = (259 * (c + 255)) / (255 * (259 - c));
  const lut = [0, 1, 2].map((ch) => {
    const t = ch === 0 ? p.temperature * 0.4 : ch === 2 ? -p.temperature * 0.4 : 0;
    const l = new Uint8ClampedArray(256);
    for (let v = 0; v < 256; v++) l[v] = clamp8(cf * (v + p.brightness * 1.28 + t - 128) + 128);
    return l;
  });
  const sat = 1 + p.saturation / 100;
  const out = copy(img);
  for (let i = 0; i < out.data.length; i += 4) {
    const r = lut[0][out.data[i]], g = lut[1][out.data[i + 1]], b = lut[2][out.data[i + 2]];
    if (sat === 1) { out.data[i] = r; out.data[i + 1] = g; out.data[i + 2] = b; continue; }
    const y = 0.299 * r + 0.587 * g + 0.114 * b;
    out.data[i] = clamp8(y + (r - y) * sat); out.data[i + 1] = clamp8(y + (g - y) * sat); out.data[i + 2] = clamp8(y + (b - y) * sat);
  }
  return out;
}

function blurChannel(src: Float32Array, w: number, h: number, sigma: number): Float32Array {
  const R = Math.max(1, Math.ceil(sigma * 3)), k = new Float32Array(2 * R + 1);
  let s = 0;
  for (let i = -R; i <= R; i++) { k[i + R] = Math.exp(-(i * i) / (2 * sigma * sigma)); s += k[i + R]; }
  for (let i = 0; i < k.length; i++) k[i] /= s;
  const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let d = -R; d <= R; d++) a += k[d + R] * src[y * w + Math.min(w - 1, Math.max(0, x + d))];
    tmp[y * w + x] = a;
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    let a = 0;
    for (let d = -R; d <= R; d++) a += k[d + R] * tmp[Math.min(h - 1, Math.max(0, y + d)) * w + x];
    out[y * w + x] = a;
  }
  return out;
}

/** Máscara de nitidez (unsharp mask) na luminosidade: realça detalhe sem colorir bordas. `amount` 0–1,5. */
export function unsharp(img: RawImage, amount: number, sigma: number, threshold = 2): RawImage {
  if (amount <= 0) return img;
  const { width: w, height: h } = img;
  const Y = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) Y[i] = 0.299 * img.data[i * 4] + 0.587 * img.data[i * 4 + 1] + 0.114 * img.data[i * 4 + 2];
  const B = blurChannel(Y, w, h, sigma);
  const out = copy(img);
  for (let i = 0; i < w * h; i++) {
    const d = Y[i] - B[i];
    if (Math.abs(d) < threshold) continue;
    const add = amount * d;
    out.data[i * 4] = clamp8(out.data[i * 4] + add); out.data[i * 4 + 1] = clamp8(out.data[i * 4 + 1] + add); out.data[i * 4 + 2] = clamp8(out.data[i * 4 + 2] + add);
  }
  return out;
}

const sinc = (x: number) => (x === 0 ? 1 : Math.sin(Math.PI * x) / (Math.PI * x));
const lanczos = (x: number) => (Math.abs(x) >= 3 ? 0 : sinc(x) * sinc(x / 3));

function taps(srcLen: number, dstLen: number): { start: Int32Array; w: Float32Array[] } {
  const scale = srcLen / dstLen, f = Math.max(1, scale), support = 3 * f;
  const start = new Int32Array(dstLen), w: Float32Array[] = [];
  for (let x = 0; x < dstLen; x++) {
    const center = (x + 0.5) * scale - 0.5;
    const s = Math.floor(center - support) + 1, e = Math.floor(center + support);
    const arr = new Float32Array(e - s + 1);
    let sum = 0;
    for (let i = s; i <= e; i++) { const v = lanczos((i - center) / f); arr[i - s] = v; sum += v; }
    for (let i = 0; i < arr.length; i++) arr[i] /= sum || 1;
    start[x] = s; w.push(arr);
  }
  return { start, w };
}

/** Redimensiona com Lanczos-3 (alfa pré-multiplicado: bordas transparentes não "sangram" cor). */
export function resize(img: RawImage, W: number, H: number): RawImage {
  W = Math.max(1, Math.round(W)); H = Math.max(1, Math.round(H));
  if (W === img.width && H === img.height) return img;
  const { width: sw, height: sh } = img;
  const hx = taps(sw, W), vy = taps(sh, H);
  const tmp = new Float32Array(W * sh * 4);
  for (let y = 0; y < sh; y++) {
    for (let x = 0; x < W; x++) {
      const s = hx.start[x], wt = hx.w[x];
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < wt.length; k++) {
        const sx = Math.min(sw - 1, Math.max(0, s + k)), i = (y * sw + sx) * 4, al = img.data[i + 3] / 255, q = wt[k] * al;
        r += q * img.data[i]; g += q * img.data[i + 1]; b += q * img.data[i + 2]; a += wt[k] * al;
      }
      const o = (y * W + x) * 4;
      tmp[o] = r; tmp[o + 1] = g; tmp[o + 2] = b; tmp[o + 3] = a;
    }
  }
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < H; y++) {
    const s = vy.start[y], wt = vy.w[y];
    for (let x = 0; x < W; x++) {
      let r = 0, g = 0, b = 0, a = 0;
      for (let k = 0; k < wt.length; k++) {
        const sy = Math.min(sh - 1, Math.max(0, s + k)), i = (sy * W + x) * 4;
        r += wt[k] * tmp[i]; g += wt[k] * tmp[i + 1]; b += wt[k] * tmp[i + 2]; a += wt[k] * tmp[i + 3];
      }
      const o = (y * W + x) * 4, al = Math.min(1, Math.max(0, a));
      out[o + 3] = Math.round(al * 255);
      if (al > 1e-4) { out[o] = clamp8(r / a); out[o + 1] = clamp8(g / a); out[o + 2] = clamp8(b / a); }
    }
  }
  return { data: out, width: W, height: H };
}

const hexRgb = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

/**
 * Leva a imagem exatamente a `W`×`H`. `cover`: preenche o quadro e corta o excesso (foco `fx`,`fy`);
 * `contain`: cabe inteira e completa o resto com `background` (ou transparente).
 */
export function fitToSize(img: RawImage, W: number, H: number, mode: 'cover' | 'contain', fx = 0.5, fy = 0.5, background: string | null = null): RawImage {
  const { width: w, height: h } = img;
  if (mode === 'cover') {
    const s = Math.max(W / w, H / h);
    const cw = Math.min(w, Math.max(1, Math.round(W / s))), ch = Math.min(h, Math.max(1, Math.round(H / s)));
    const x0 = Math.round((w - cw) * Math.min(1, Math.max(0, fx))), y0 = Math.round((h - ch) * Math.min(1, Math.max(0, fy)));
    let src = img;
    if (cw !== w || ch !== h) {
      const d = new Uint8ClampedArray(cw * ch * 4);
      for (let y = 0; y < ch; y++) d.set(img.data.subarray(((y0 + y) * w + x0) * 4, ((y0 + y) * w + x0 + cw) * 4), y * cw * 4);
      src = { data: d, width: cw, height: ch };
    }
    return resize(src, W, H);
  }
  const s = Math.min(W / w, H / h);
  const r = resize(img, Math.max(1, Math.round(w * s)), Math.max(1, Math.round(h * s)));
  const out = new Uint8ClampedArray(W * H * 4);
  if (background) { const [br, bg, bb] = hexRgb(background); for (let i = 0; i < W * H; i++) { out[i * 4] = br; out[i * 4 + 1] = bg; out[i * 4 + 2] = bb; out[i * 4 + 3] = 255; } }
  const ox = Math.round((W - r.width) * Math.min(1, Math.max(0, fx))), oy = Math.round((H - r.height) * Math.min(1, Math.max(0, fy)));
  for (let y = 0; y < r.height; y++) for (let x = 0; x < r.width; x++) {
    const si = (y * r.width + x) * 4, di = ((oy + y) * W + ox + x) * 4, a = r.data[si + 3] / 255, da = out[di + 3] / 255;
    const oa = a + da * (1 - a);
    if (oa <= 0) continue;
    for (let c = 0; c < 3; c++) out[di + c] = clamp8((r.data[si + c] * a + out[di + c] * da * (1 - a)) / oa);
    out[di + 3] = Math.round(oa * 255);
  }
  return { data: out, width: W, height: H };
}

/** Forma do recorte com borda suavizada (1 px): retângulo arredondado ou elipse inscrita; cantos transparentes. */
export function applyShape(img: RawImage, shape: CropShape, radius = 0.15): RawImage {
  if (shape === 'rect') return img;
  const { width: w, height: h } = img, out = copy(img), cx = w / 2, cy = h / 2;
  const rr = Math.max(0, Math.min(0.5, radius)) * Math.min(w, h);
  const a = w / 2, b = h / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const px = x + 0.5 - cx, py = y + 0.5 - cy;
    let d: number; // distância com sinal ao contorno (negativa dentro)
    if (shape === 'rounded') {
      const qx = Math.max(Math.abs(px) - (a - rr), 0), qy = Math.max(Math.abs(py) - (b - rr), 0);
      d = Math.hypot(qx, qy) - rr + (qx === 0 && qy === 0 ? Math.min(0, Math.max(Math.abs(px) - (a - rr), Math.abs(py) - (b - rr))) : 0);
    } else {
      const g = (px * px) / (a * a) + (py * py) / (b * b), gx = (2 * px) / (a * a), gy = (2 * py) / (b * b);
      d = (g - 1) / Math.max(1e-9, Math.hypot(gx, gy));
    }
    const cov = Math.min(1, Math.max(0, 0.5 - d));
    if (cov < 1) out.data[(y * w + x) * 4 + 3] = Math.round(out.data[(y * w + x) * 4 + 3] * cov);
  }
  return out;
}

/** Cantos transparentes: círculo inscrito com borda suavizada (1 px). */
export function applyCircle(img: RawImage): RawImage {
  const { width: w, height: h } = img, out = copy(img), R = Math.min(w, h) / 2, cx = w / 2, cy = h / 2;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const d = Math.hypot(x + 0.5 - cx, y + 0.5 - cy), cov = Math.min(1, Math.max(0, R - d + 0.5));
    if (cov < 1) out.data[(y * w + x) * 4 + 3] = Math.round(out.data[(y * w + x) * 4 + 3] * cov);
  }
  return out;
}

/** Edições "de pixel e de camada" além dos ajustes: remoções da varinha, formas inseridas e a camada da imagem. */
export interface EditOps {
  removals: Removal[];
  overlays: Overlay[];
  baseOpacity: number; // opacidade da camada da imagem (0–1)
  baseVisible: boolean;
}
export const NO_EDIT: EditOps = { removals: [], overlays: [], baseOpacity: 1, baseVisible: true };

/**
 * Parte "pesada" da melhoria (a que não depende das formas): giro/recorte → remoções da varinha → substituir cores →
 * ruído → níveis/balanço → cor → matiz/filtro/colorir → ajuste ao tamanho → nitidez. Se a origem é > 2× a saída, antes
 * disso reduz uniformemente (os cliques da varinha são frações: valem em qualquer resolução).
 */
export function enhanceBase(src: RawImage, p: EnhanceParams, out?: OutputSpec, t?: Transform, edit?: EditOps): RawImage {
  let img = t ? prepare(src, t) : src;
  if (out && Math.max(img.width, img.height) > 2 * Math.max(out.width, out.height)) {
    const k = (2 * Math.max(out.width, out.height)) / Math.max(img.width, img.height);
    img = resize(img, img.width * k, img.height * k);
  }
  if (edit?.removals.length) img = applyRemovals(img, edit.removals);
  img = replaceColors(img, p.replaces ?? []);
  if (p.denoise > 0) img = denoise(img, p.denoise).image;
  if (p.auto) img = autoLevels(img);
  if (p.whiteBalance) img = grayWorld(img);
  img = adjust(img, p);
  img = hueShift(img, p.hue ?? 0);
  if (p.filter && p.filter !== 'none' && FILTERS.some((f) => f.id === p.filter)) img = applyFilter(img, p.filter, p.filterAmount ?? 100);
  img = tint(img, p.tint ?? null, p.tintAmount ?? 0);
  if (out) img = fitToSize(img, out.width, out.height, out.fit, out.fx, out.fy, out.background);
  if (p.sharpen > 0) img = unsharp(img, (p.sharpen / 100) * 1.4, Math.min(2.5, Math.max(0.5, (Math.max(img.width, img.height) / 1080) * 0.9)));
  return img;
}

/** Parte "leve": camada da imagem (visibilidade/opacidade), formas inseridas e forma do recorte (que vale para tudo). */
export function finalize(img: RawImage, edit?: EditOps, out?: OutputSpec): RawImage {
  let r = img;
  if (edit && (!edit.baseVisible || edit.baseOpacity < 1)) {
    const d = new Uint8ClampedArray(r.data), k = edit.baseVisible ? edit.baseOpacity : 0;
    for (let i = 3; i < d.length; i += 4) d[i] = Math.round(d[i] * k);
    r = { data: d, width: r.width, height: r.height };
  }
  if (edit?.overlays.length) r = drawOverlays(r, edit.overlays);
  const shape = out?.shape ?? (out?.circle ? 'ellipse' : 'rect');
  if (shape !== 'rect') r = applyShape(r, shape, out?.radius);
  return r;
}

/** Melhoria completa (base + formas + forma do recorte). */
export function enhance(src: RawImage, p: EnhanceParams, out?: OutputSpec, t?: Transform, edit?: EditOps): RawImage {
  return finalize(enhanceBase(src, p, out, t, edit), edit, out);
}
