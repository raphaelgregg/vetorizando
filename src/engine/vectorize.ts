import { hex, rgbToLab } from './color';
import { loopArea, traceField } from './contour';
import { denoise } from './denoise';
import { resolveTransitions } from './edges';
import { fitLoop } from './fit';
import { quantize } from './quantize';
import { removeSpeckles } from './segment';
import type { Layer, Options, Pt, ProgressFn, RawImage, VDoc } from './types';

/**
 * Raio hidráulico (tinta/perímetro ≈ meia largura) POR ESTRUTURA para cada laço: o contorno externo e seus furos
 * compartilham o valor. Uma grade ou moldura de 1 px é um único laço enorme com muitos furos — vista laço a laço
 * pareceria larga e seria ajustada com curvas/suavização.
 */
function structureHydraulic(raw: Pt[][]): number[] {
  const n = raw.length;
  const out = new Array<number>(n).fill(Infinity);
  if (!n) return out;
  const area = raw.map((l) => loopArea(l));
  const per = raw.map((l) => { let s = 0; for (let i = 0; i < l.length; i++) { const q = l[(i + 1) % l.length]; s += Math.hypot(q.x - l[i].x, q.y - l[i].y); } return s; });
  let big = 0;
  for (let i = 1; i < n; i++) if (Math.abs(area[i]) > Math.abs(area[big])) big = i;
  const outerSign = Math.sign(area[big]);
  const bbox = raw.map((l) => { let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity; for (const p of l) { if (p.x < x0) x0 = p.x; if (p.x > x1) x1 = p.x; if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; } return [x0, y0, x1, y1]; });
  const inside = (pt: Pt, poly: Pt[]) => {
    let c = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      if (poly[i].y > pt.y !== poly[j].y > pt.y && pt.x < ((poly[j].x - poly[i].x) * (pt.y - poly[i].y)) / (poly[j].y - poly[i].y) + poly[i].x) c = !c;
    }
    return c;
  };
  const ink = area.map((a) => Math.abs(a)), perim = per.slice(), holes: number[][] = raw.map(() => []);
  raw.forEach((_, i) => {
    if (Math.sign(area[i]) === outerSign) return;
    let owner = -1; // furo: pertence ao MENOR contorno externo que o contém
    for (let o = 0; o < n; o++) {
      if (o === i || Math.sign(area[o]) !== outerSign || Math.abs(area[o]) <= Math.abs(area[i])) continue;
      const b = bbox[o], p = raw[i][0];
      if (p.x < b[0] || p.x > b[2] || p.y < b[1] || p.y > b[3] || !inside(p, raw[o])) continue;
      if (owner < 0 || Math.abs(area[o]) < Math.abs(area[owner])) owner = o;
    }
    if (owner >= 0) { holes[owner].push(i); ink[owner] -= Math.abs(area[i]); perim[owner] += per[i]; }
  });
  raw.forEach((_, i) => {
    if (Math.sign(area[i]) !== outerSign || perim[i] <= 0) return;
    const hyd = ink[i] / perim[i];
    out[i] = hyd;
    for (const hIdx of holes[i]) out[hIdx] = hyd;
  });
  return out;
}

/** Pipeline principal: quantização → segmentação → contornos → curvas → camadas. */
export function vectorize(img: RawImage, o: Options, progress: ProgressFn = () => {}, internal: { merge?: boolean } = {}): VDoc {
  const t0 = performance.now();
  const { width: w, height: h } = img;
  progress(0.01, 'Analisando ruído');
  const original = img; // pixels originais (a cor final da paleta sai deles)
  const dn = denoise(img, o.denoise);
  img = dn.image; // filtrado (ou o mesmo objeto, se a imagem é limpa)
  progress(0.02, 'Quantizando cores');
  const { labels, palette } = quantize(img, o.maxColors, o.mergeDeltaE);
  progress(0.12, 'Corrigindo bordas');
  const tr = resolveTransitions(img, labels, palette.map((c) => rgbToLab(...c)), palette, o.edgeDelta);
  const recolored = tr.idx.length;
  if (recolored) {
    // cor final da paleta: média dos pixels "limpos" (sem os de transição)
    const skip = new Uint8Array(labels.length);
    for (const i of tr.idx) skip[i] = 1;
    const acc = palette.map(() => [0, 0, 0, 0]);
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i];
      if (l >= 0 && !skip[i]) { acc[l][0] += img.data[i * 4]; acc[l][1] += img.data[i * 4 + 1]; acc[l][2] += img.data[i * 4 + 2]; acc[l][3]++; }
    }
    acc.forEach((a, c) => { if (a[3]) palette[c] = [a[0] / a[3], a[1] / a[3], a[2] / a[3]]; });
  }
  if (dn.applied) {
    // ruído é cortado em 0/255: a MÉDIA do cluster fica enviesada (branco → ~251); a MEDIANA por canal dos pixels
    // ORIGINAIS recupera a cor verdadeira. Só com ruído detectado: em imagens limpas a paleta não muda.
    const skip = new Uint8Array(labels.length);
    for (const i of tr.idx) skip[i] = 1;
    const hist = new Uint32Array(palette.length * 3 * 256), cnt = new Uint32Array(palette.length);
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i];
      if (l < 0 || skip[i]) continue;
      cnt[l]++;
      for (let c = 0; c < 3; c++) hist[(l * 3 + c) * 256 + original.data[i * 4 + c]]++;
    }
    palette.forEach((_, l) => {
      if (!cnt[l]) return;
      const m = [0, 1, 2].map((c) => { let acc = 0; for (let v = 0; v < 256; v++) { acc += hist[(l * 3 + c) * 256 + v]; if (acc * 2 >= cnt[l]) return v; } return 255; });
      palette[l] = [m[0], m[1], m[2]];
    });
  }
  progress(0.2, 'Limpando ruído');
  removeSpeckles(labels, w, h, o.speckle, palette.map((c) => rgbToLab(...c)));

  // áreas e fundo (cor dominante nas bordas)
  const area = new Float64Array(palette.length);
  for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) area[labels[i]]++;
  let bg = -1;
  if (o.removeBackground && palette.length > 1) {
    const votes = new Float64Array(palette.length);
    let edge = 0;
    const vote = (i: number) => { if (labels[i] >= 0) { votes[labels[i]]++; edge++; } };
    for (let x = 0; x < w; x++) { vote(x); vote((h - 1) * w + x); }
    for (let y = 1; y < h - 1; y++) { vote(y * w); vote(y * w + w - 1); }
    let best = 0;
    for (let c = 1; c < votes.length; c++) if (votes[c] > votes[best]) best = c;
    if (edge > 0 && votes[best] / edge > 0.5) bg = best;
  }

  // ordem de desenho: maiores primeiro (fundo → frente)
  const order = palette.map((_, i) => i).filter((c) => area[c] > 0 && c !== bg).sort((a, b) => area[b] - area[a]);
  const layers: Layer[] = [];
  let nodes = 0, paths = 0, rawPoints = 0, lines = 0, arcs = 0, ellipses = 0, curves = 0;
  const minLoop = Math.max(1, o.speckle / 6);

  order.forEach((c, rank) => {
    progress(0.25 + (0.7 * rank) / Math.max(1, order.length), `Traçando cor ${rank + 1}/${order.length}`);
    const mask = new Uint8Array(w * h);
    const set = o.stacking === 'stacked' ? new Set(order.slice(rank)) : new Set([c]);
    for (let i = 0; i < mask.length; i++) if (set.has(labels[i])) mask[i] = 1;
    // cobertura subpixel dos pixels de transição para as cores desta camada
    const cover = new Map<number, number>();
    for (let k = 0; k < tr.idx.length; k++) {
      const i = tr.idx[k], a = tr.a[k], b = tr.b[k];
      if (labels[i] !== a && labels[i] !== b) continue;
      const v = (set.has(a) ? 1 - tr.t[k] : 0) + (set.has(b) ? tr.t[k] : 0);
      cover.set(i, v);
    }
    const layer: Layer = { color: hex(...palette[c]), paths: [] };
    const raw: Pt[][] = [];
    for (const loop of traceField(mask, w, h, o.contourBlur, cover)) {
      if (Math.abs(loopArea(loop)) < minLoop) continue;
      raw.push(loop);
    }
    const hyd = structureHydraulic(raw);
    raw.forEach((loop, k) => {
      const path = fitLoop(loop, { tolerance: o.lineFitTolerance, cornerThreshold: o.cornerThreshold, smooth: o.smooth, arcs: o.arcs, ellipses: o.ellipses, merge: internal.merge, hydraulic: hyd[k] });
      rawPoints += loop.length;
      nodes += path.segs.length;
      for (const sg of path.segs) { if (sg.t === 'L') lines++; else if (sg.t === 'A') arcs++; else if (sg.t === 'E') ellipses++; else curves++; }
      paths++;
      layer.paths.push(path);
    });
    if (layer.paths.length) layers.push(layer);
  });

  progress(1, 'Pronto');
  let transparent = false;
  for (let i = 0; i < labels.length && !transparent; i++) if (labels[i] < 0) transparent = true;
  return { width: w, height: h, layers, openBoundary: transparent || bg >= 0, stacking: o.stacking, stats: { nodes, paths, colors: layers.length, ms: performance.now() - t0, rawPoints, lines, arcs, ellipses, curves, recolored, noise: dn.noise.sigma, denoised: dn.applied } };
}
