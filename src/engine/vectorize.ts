import { hex, rgbToLab } from './color';
import { loopArea, traceField } from './contour';
import { resolveTransitions } from './edges';
import { fitLoop } from './fit';
import { quantize } from './quantize';
import { removeSpeckles } from './segment';
import type { Layer, Options, ProgressFn, RawImage, VDoc } from './types';

/** Pipeline principal: quantização → segmentação → contornos → curvas → camadas. */
export function vectorize(img: RawImage, o: Options, progress: ProgressFn = () => {}): VDoc {
  const t0 = performance.now();
  const { width: w, height: h } = img;
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
  progress(0.2, 'Limpando ruído');
  removeSpeckles(labels, w, h, o.speckle);

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
  const minLoop = Math.max(2, o.speckle / 4);

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
    for (const loop of traceField(mask, w, h, o.contourBlur, cover)) {
      if (Math.abs(loopArea(loop)) < minLoop) continue;
      const path = fitLoop(loop, { tolerance: o.lineFitTolerance, cornerThreshold: o.cornerThreshold, smooth: o.smooth, arcs: o.arcs, ellipses: o.ellipses });
      rawPoints += loop.length;
      nodes += path.segs.length;
      for (const sg of path.segs) { if (sg.t === 'L') lines++; else if (sg.t === 'A') arcs++; else if (sg.t === 'E') ellipses++; else curves++; }
      paths++;
      layer.paths.push(path);
    }
    if (layer.paths.length) layers.push(layer);
  });

  progress(1, 'Pronto');
  return { width: w, height: h, layers, stats: { nodes, paths, colors: layers.length, ms: performance.now() - t0, rawPoints, lines, arcs, ellipses, curves, recolored } };
}
