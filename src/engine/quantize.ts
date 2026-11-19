import { Lab, dist2, rgbToLab } from './color';
import type { RawImage } from './types';

export interface Quantized {
  labels: Int16Array; // -1 = transparente
  palette: [number, number, number][]; // RGB médio por índice
}

function rng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

export function quantize(img: RawImage, k: number, mergeDE: number): Quantized {
  const { data, width: w, height: h } = img;
  const n = w * h;
  const opaque: number[] = [];
  for (let i = 0; i < n; i++) if (data[i * 4 + 3] >= 128) opaque.push(i);
  const labels = new Int16Array(n).fill(-1);
  if (opaque.length === 0) return { labels, palette: [] };

  // amostra (para k-means) – determinística
  const step = Math.max(1, Math.floor(opaque.length / 30000));
  const samples: Lab[] = [];
  for (let i = 0; i < opaque.length; i += step) {
    const p = opaque[i] * 4;
    samples.push(rgbToLab(data[p], data[p + 1], data[p + 2]));
  }

  // k-means++
  const rand = rng(12345);
  const kk = Math.min(k, samples.length);
  const centers: Lab[] = [samples[Math.floor(rand() * samples.length)]];
  const d2 = new Float64Array(samples.length).fill(Infinity);
  while (centers.length < kk) {
    const last = centers[centers.length - 1];
    let total = 0;
    for (let i = 0; i < samples.length; i++) {
      d2[i] = Math.min(d2[i], dist2(samples[i], last));
      total += d2[i];
    }
    if (total === 0) break;
    let r = rand() * total;
    let pick = 0;
    for (let i = 0; i < samples.length; i++) {
      r -= d2[i];
      if (r <= 0) { pick = i; break; }
    }
    centers.push(samples[pick]);
  }

  const counts = new Float64Array(centers.length);
  for (let it = 0; it < 10; it++) {
    const sum = centers.map(() => [0, 0, 0]);
    counts.fill(0);
    for (const s of samples) {
      let best = 0, bd = Infinity;
      for (let c = 0; c < centers.length; c++) {
        const d = dist2(s, centers[c]);
        if (d < bd) { bd = d; best = c; }
      }
      sum[best][0] += s[0]; sum[best][1] += s[1]; sum[best][2] += s[2];
      counts[best]++;
    }
    for (let c = 0; c < centers.length; c++) {
      if (counts[c] > 0) centers[c] = [sum[c][0] / counts[c], sum[c][1] / counts[c], sum[c][2] / counts[c]];
    }
  }

  // mescla de tons próximos
  const cw = Array.from(counts);
  let merged = true;
  while (merged && centers.length > 1) {
    merged = false;
    outer: for (let a = 0; a < centers.length; a++) {
      for (let b = a + 1; b < centers.length; b++) {
        if (Math.sqrt(dist2(centers[a], centers[b])) < mergeDE) {
          const wa = cw[a] || 1, wb = cw[b] || 1, t = wa + wb;
          centers[a] = [0, 1, 2].map((i) => (centers[a][i] * wa + centers[b][i] * wb) / t) as Lab;
          cw[a] = t;
          centers.splice(b, 1);
          cw.splice(b, 1);
          merged = true;
          break outer;
        }
      }
    }
  }

  // atribuição de todos os pixels (cache por cor RGB 6 bits)
  const cache = new Map<number, number>();
  const sumRGB = centers.map(() => [0, 0, 0, 0]);
  for (const i of opaque) {
    const p = i * 4;
    const r = data[p], g = data[p + 1], b = data[p + 2];
    const key = ((r >> 2) << 12) | ((g >> 2) << 6) | (b >> 2);
    let best = cache.get(key);
    if (best === undefined) {
      const lab = rgbToLab(r, g, b);
      let bd = Infinity;
      best = 0;
      for (let c = 0; c < centers.length; c++) {
        const d = dist2(lab, centers[c]);
        if (d < bd) { bd = d; best = c; }
      }
      cache.set(key, best);
    }
    labels[i] = best;
    sumRGB[best][0] += r; sumRGB[best][1] += g; sumRGB[best][2] += b; sumRGB[best][3]++;
  }
  const palette = sumRGB.map((s) => (s[3] ? [s[0] / s[3], s[1] / s[3], s[2] / s[3]] : [0, 0, 0]) as [number, number, number]);
  return { labels, palette };
}
