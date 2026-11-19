import { rgbToLab } from '../src/engine/color';
import type { RawImage } from '../src/engine/types';

export interface Metrics {
  ssim: number; // 1 = idêntico
  deltaE: number; // média CIE76
  deltaEp95: number;
  hd95: number; // distância de Hausdorff (percentil 95) entre bordas, em px
  hdMax: number;
  chamfer: number; // distância média entre bordas, em px
  deltaEEdge: number; // ΔE médio só nos pixels de borda (≤ 2 px de um contraste) → erro GEOMÉTRICO
  deltaEFlat: number; // ΔE médio nas áreas planas → erro de COR (paleta/quantização)
  errEdgeShare: number; // fração da massa total de ΔE que está nas bordas (1 = erro todo geométrico; 0 = todo de cor)
}

/** Compõe sobre fundo branco e devolve RGB (3 canais). */
export function flatten(img: RawImage): Float32Array {
  const n = img.width * img.height;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const a = img.data[i * 4 + 3] / 255;
    for (let c = 0; c < 3; c++) out[i * 3 + c] = img.data[i * 4 + c] * a + 255 * (1 - a);
  }
  return out;
}

function toLab(rgb: Float32Array): Float32Array {
  const n = rgb.length / 3;
  const out = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    const l = rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]);
    out[i * 3] = l[0]; out[i * 3 + 1] = l[1]; out[i * 3 + 2] = l[2];
  }
  return out;
}

function percentile(sorted: Float32Array | number[], p: number): number {
  if (!sorted.length) return 0;
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

/** SSIM médio na luminância, janela uniforme 7×7 (integrais), C1/C2 padrão. */
export function ssim(a: Float32Array, b: Float32Array, w: number, h: number, win = 7): number {
  const lum = (rgb: Float32Array) => {
    const o = new Float64Array(w * h);
    for (let i = 0; i < w * h; i++) o[i] = 0.299 * rgb[i * 3] + 0.587 * rgb[i * 3 + 1] + 0.114 * rgb[i * 3 + 2];
    return o;
  };
  const x = lum(a), y = lum(b);
  const integ = (f: (i: number) => number) => {
    const I = new Float64Array((w + 1) * (h + 1));
    for (let j = 0; j < h; j++) {
      let row = 0;
      for (let i = 0; i < w; i++) { row += f(j * w + i); I[(j + 1) * (w + 1) + i + 1] = I[j * (w + 1) + i + 1] + row; }
    }
    return I;
  };
  const Sx = integ((i) => x[i]), Sy = integ((i) => y[i]), Sxx = integ((i) => x[i] * x[i]), Syy = integ((i) => y[i] * y[i]), Sxy = integ((i) => x[i] * y[i]);
  const box = (I: Float64Array, i: number, j: number) => I[(j + win) * (w + 1) + i + win] - I[j * (w + 1) + i + win] - I[(j + win) * (w + 1) + i] + I[j * (w + 1) + i];
  const N = win * win, C1 = (0.01 * 255) ** 2, C2 = (0.03 * 255) ** 2;
  let total = 0, count = 0;
  for (let j = 0; j + win <= h; j++) {
    for (let i = 0; i + win <= w; i++) {
      const mx = box(Sx, i, j) / N, my = box(Sy, i, j) / N;
      const vx = box(Sxx, i, j) / N - mx * mx, vy = box(Syy, i, j) / N - my * my, cxy = box(Sxy, i, j) / N - mx * my;
      total += ((2 * mx * my + C1) * (2 * cxy + C2)) / ((mx * mx + my * my + C1) * (vx + vy + C2));
      count++;
    }
  }
  return count ? total / count : 1;
}

/** Transformada de distância euclidiana exata (Felzenszwalb) — devolve distância (px). */
function edt(mask: Uint8Array, w: number, h: number): Float32Array {
  const INF = 1e12;
  const f = new Float64Array(Math.max(w, h)), d = new Float64Array(Math.max(w, h));
  const v = new Int32Array(Math.max(w, h)), z = new Float64Array(Math.max(w, h) + 1);
  const g = new Float64Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = mask[i] ? 0 : INF;
  const pass = (len: number, get: (k: number) => number, set: (k: number, val: number) => void) => {
    for (let k = 0; k < len; k++) f[k] = get(k);
    let kk = 0;
    v[0] = 0; z[0] = -INF; z[1] = INF;
    for (let q = 1; q < len; q++) {
      let s: number;
      for (;;) {
        const p = v[kk];
        s = (f[q] + q * q - (f[p] + p * p)) / (2 * q - 2 * p);
        if (s <= z[kk] && kk > 0) kk--; else break;
      }
      if (s <= z[kk]) { v[kk] = q; z[kk] = -INF; z[kk + 1] = INF; } else { kk++; v[kk] = q; z[kk] = s; z[kk + 1] = INF; }
    }
    kk = 0;
    for (let q = 0; q < len; q++) {
      while (z[kk + 1] < q) kk++;
      d[q] = (q - v[kk]) ** 2 + f[v[kk]];
    }
    for (let k = 0; k < len; k++) set(k, d[k]);
  };
  for (let x = 0; x < w; x++) pass(h, (k) => g[k * w + x], (k, val) => { g[k * w + x] = val; });
  for (let y = 0; y < h; y++) pass(w, (k) => g[y * w + k], (k, val) => { g[y * w + k] = val; });
  const out = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) out[i] = Math.sqrt(g[i]);
  return out;
}

/** Mapa de bordas fortes: pixels onde a cor muda ≥ thr (ΔE) para o vizinho à direita/abaixo (ignora degradês suaves). */
export function edgeMap(lab: Float32Array, w: number, h: number, thr = 25): Uint8Array {
  const m = new Uint8Array(w * h);
  const de = (i: number, j: number) => Math.hypot(lab[i * 3] - lab[j * 3], lab[i * 3 + 1] - lab[j * 3 + 1], lab[i * 3 + 2] - lab[j * 3 + 2]);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x;
      if (x + 1 < w && de(i, i + 1) >= thr) { m[i] = 1; m[i + 1] = 1; }
      if (y + 1 < h && de(i, i + w) >= thr) { m[i] = 1; m[i + w] = 1; }
    }
  }
  return m;
}

export function compare(orig: RawImage, rendered: RawImage): Metrics {
  if (orig.width !== rendered.width || orig.height !== rendered.height) throw new Error('imagens com tamanhos diferentes');
  const { width: w, height: h } = orig;
  const A = flatten(orig), B = flatten(rendered);
  const la = toLab(A), lb = toLab(B);
  const n = w * h;
  const de = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) {
    de[i] = Math.hypot(la[i * 3] - lb[i * 3], la[i * 3 + 1] - lb[i * 3 + 1], la[i * 3 + 2] - lb[i * 3 + 2]);
    sum += de[i];
  }
  const sorted = Float32Array.from(de).sort();
  const ea = edgeMap(la, w, h), eb = edgeMap(lb, w, h);
  const hasA = ea.some((v) => v), hasB = eb.some((v) => v);
  let hd95 = 0, hdMax = 0, chamfer = 0;
  if (hasA && hasB) {
    const da = edt(ea, w, h), db = edt(eb, w, h);
    const dists: number[] = [];
    let cn = 0;
    for (let i = 0; i < n; i++) {
      if (ea[i]) { const d = db[i]; dists.push(d); hdMax = Math.max(hdMax, d); chamfer += d; cn++; }
      if (eb[i]) { const d = da[i]; dists.push(d); hdMax = Math.max(hdMax, d); chamfer += d; cn++; }
    }
    dists.sort((x, y) => x - y);
    hd95 = percentile(dists, 0.95);
    chamfer = cn ? chamfer / cn : 0;
  } else if (hasA !== hasB) {
    hd95 = hdMax = chamfer = Math.hypot(w, h); // bordas de um lado só: pior caso (diagonal)
  }
  // regiões: borda = vizinhança (≤ 2 px) de qualquer contraste forte no original OU no render
  const near = new Uint8Array(n);
  for (const m of [ea, eb]) {
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        if (!m[y * w + x]) continue;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx >= 0 && yy >= 0 && xx < w && yy < h) near[yy * w + xx] = 1;
        }
      }
    }
  }
  let se = 0, ne = 0, sf = 0, nf = 0;
  for (let i = 0; i < n; i++) { if (near[i]) { se += de[i]; ne++; } else { sf += de[i]; nf++; } }
  return {
    ssim: ssim(A, B, w, h),
    deltaEEdge: ne ? se / ne : 0,
    deltaEFlat: nf ? sf / nf : 0,
    errEdgeShare: se + sf > 0 ? se / (se + sf) : 0,
    deltaE: sum / n,
    deltaEp95: percentile(sorted, 0.95),
    hd95,
    hdMax,
    chamfer,
  };
}

/** Conta nós (segmentos) de um SVG qualquer: comandos de path, polígonos e formas básicas. */
export function countSvgNodes(svg: string): number {
  let nodes = 0;
  const size: Record<string, number> = { m: 2, l: 2, t: 2, c: 6, s: 4, q: 4, a: 7, h: 1, v: 1 };
  for (const m of svg.matchAll(/<path\b[^>]*?\sd\s*=\s*"([^"]*)"/g)) {
    for (const seg of m[1].matchAll(/([a-zA-Z])([^a-zA-Z]*)/g)) {
      const cmd = seg[1].toLowerCase();
      if (cmd === 'z') continue;
      const nums = (seg[2].match(/-?\d*\.?\d+(?:e[-+]?\d+)?/gi) ?? []).length;
      nodes += Math.max(cmd === 'm' ? 1 : 0, Math.floor(nums / size[cmd]));
    }
  }
  for (const m of svg.matchAll(/<(?:polygon|polyline)\b[^>]*?\spoints\s*=\s*"([^"]*)"/g)) nodes += Math.floor((m[1].match(/-?\d*\.?\d+/g) ?? []).length / 2);
  nodes += (svg.match(/<(?:rect|circle|ellipse)\b/g) ?? []).length * 4;
  return nodes;
}

/** ΔE (CIE76) por pixel entre duas imagens do mesmo tamanho (compostas sobre branco). */
export function deltaEMap(orig: RawImage, rendered: RawImage): Float32Array {
  const la = toLab(flatten(orig)), lb = toLab(flatten(rendered));
  const n = orig.width * orig.height;
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.hypot(la[i * 3] - lb[i * 3], la[i * 3 + 1] - lb[i * 3 + 1], la[i * 3 + 2] - lb[i * 3 + 2]);
  return out;
}
