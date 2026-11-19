import { hex } from './color';
import { fitLoop } from './fit';
import { quantize } from './quantize';
import { removeSpeckles } from './segment';
import { loopArea, traceMask } from './trace';
import type { Layer, Options, ProgressFn, RawImage, VDoc } from './types';

/** Pipeline principal: quantização → segmentação → contornos → curvas → camadas. */
export function vectorize(img: RawImage, o: Options, progress: ProgressFn = () => {}): VDoc {
  const t0 = performance.now();
  const { width: w, height: h } = img;
  progress(0.02, 'Quantizando cores');
  const { labels, palette } = quantize(img, o.maxColors, o.mergeDeltaE);
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
  let nodes = 0, paths = 0;
  const minLoop = Math.max(2, o.speckle / 4);

  order.forEach((c, rank) => {
    progress(0.25 + (0.7 * rank) / Math.max(1, order.length), `Traçando cor ${rank + 1}/${order.length}`);
    const mask = new Uint8Array(w * h);
    if (o.stacking === 'stacked') {
      const set = new Set(order.slice(rank));
      for (let i = 0; i < mask.length; i++) if (set.has(labels[i])) mask[i] = 1;
    } else {
      for (let i = 0; i < mask.length; i++) if (labels[i] === c) mask[i] = 1;
    }
    const layer: Layer = { color: hex(...palette[c]), paths: [] };
    for (const loop of traceMask(mask, w, h)) {
      if (Math.abs(loopArea(loop)) < minLoop) continue;
      const path = fitLoop(loop, { tolerance: o.lineFitTolerance, cornerThreshold: o.cornerThreshold, smooth: o.smooth });
      nodes += path.segs.length;
      paths++;
      layer.paths.push(path);
    }
    if (layer.paths.length) layers.push(layer);
  });

  progress(1, 'Pronto');
  return { width: w, height: h, layers, stats: { nodes, paths, colors: layers.length, ms: performance.now() - t0 } };
}
