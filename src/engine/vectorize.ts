import { hex, rgbToLab } from './color';
import { loopArea, traceField } from './contour';
import { denoise } from './denoise';
import { resolveTransitions } from './edges';
import { fitLoop } from './fit';
import { analyzeGradients } from './gradient';
import { paintShapes } from './shapepaint';
import { quantize } from './quantize';
import { regularizeLabels, removeSpeckles } from './segment';
import type { Gradient, Layer, Options, Pt, ProgressFn, RawImage, VDoc, VPath } from './types';

/**
 * Raio hidráulico (tinta/perímetro ≈ meia largura) POR ESTRUTURA para cada laço: o contorno externo e seus furos
 * compartilham o valor. Uma grade ou moldura de 1 px é um único laço enorme com muitos furos — vista laço a laço
 * pareceria larga e seria ajustada com curvas/suavização.
 */
function structureHydraulic(raw: Pt[][]): { hyd: number[]; owner: number[] } {
  const n = raw.length;
  const out = new Array<number>(n).fill(Infinity);
  const ownerOf = raw.map((_, i) => i); // forma a que cada laço pertence (furo → seu contorno externo)
  if (!n) return { hyd: out, owner: ownerOf };
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
    if (owner >= 0) { ownerOf[i] = owner; holes[owner].push(i); ink[owner] -= Math.abs(area[i]); perim[owner] += per[i]; }
  });
  raw.forEach((_, i) => {
    if (Math.sign(area[i]) !== outerSign || perim[i] <= 0) return;
    const hyd = ink[i] / perim[i];
    out[i] = hyd;
    for (const hIdx of holes[i]) out[hIdx] = hyd;
  });
  return { hyd: out, owner: ownerOf };
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
  const palLab = palette.map((c) => rgbToLab(...c));
  regularizeLabels(labels, w, h, palLab);
  removeSpeckles(labels, w, h, o.speckle, palLab);

  // áreas e fundo (cor dominante nas bordas)
  let area = new Float64Array(palette.length);
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

  // gradientes: bandas vizinhas de transição suave são agrupadas e ajustadas; cada grupo recebe rótulos próprios
  // (as mesmas cores podem existir em outro lugar da imagem como regiões sólidas)
  const groupLabels: number[][] = [], groupGrad: Gradient[] = [];
  if (o.gradients && o.drawStyle === 'fill' && palette.length > 1) {
    progress(0.22, 'Detectando gradientes');
    const skip = new Uint8Array(labels.length);
    for (const i of tr.idx) skip[i] = 1;
    const an = analyzeGradients(img.data, labels, palette, skip, w, h, bg);
    if (an.groups.length) {
      const before = labels.slice();
      const compGroup = new Int32Array(an.compLabel.length).fill(-1);
      const fresh: Map<number, number>[] = [];
      an.groups.forEach((g, gi) => { fresh.push(new Map()); for (const c of g.comps) compGroup[c] = gi; });
      for (let i = 0; i < labels.length; i++) {
        const c = an.comp[i];
        if (c < 0 || compGroup[c] < 0) continue;
        const gi = compGroup[c], old = before[i], m = fresh[gi];
        let nl = m.get(old);
        if (nl === undefined) { nl = palette.length; palette.push([...palette[old]] as [number, number, number]); m.set(old, nl); }
        labels[i] = nl;
      }
      an.groups.forEach((g, gi) => { groupLabels.push([...fresh[gi].values()]); groupGrad.push(g.gradient); });
      // extremos das transições: passam a apontar para os rótulos novos vizinhos
      const touched = new Set<number>();
      for (const m of fresh) for (const old of m.keys()) touched.add(old);
      const remap = (i: number, lab: number): number => {
        if (!touched.has(lab)) return lab;
        const x = i % w, y = (i / w) | 0;
        let bestD = Infinity, out = lab;
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const j = yy * w + xx, d = dx * dx + dy * dy;
          if (before[j] === lab && d < bestD) { bestD = d; out = labels[j]; }
        }
        return out;
      };
      for (let k = 0; k < tr.idx.length; k++) { const i = tr.idx[k]; tr.a[k] = remap(i, tr.a[k]); tr.b[k] = remap(i, tr.b[k]); }
      area = new Float64Array(palette.length);
      for (let i = 0; i < labels.length; i++) if (labels[i] >= 0) area[labels[i]]++;
    }
  }

  // unidades de desenho: rótulos soltos ou grupos de gradiente; maiores primeiro (fundo → frente)
  interface Unit { labels: number[]; area: number; grad?: Gradient }
  const inGroup = new Set(groupLabels.flat());
  const units: Unit[] = [];
  palette.forEach((_, c) => { if (area[c] > 0 && c !== bg && !inGroup.has(c)) units.push({ labels: [c], area: area[c] }); });
  groupLabels.forEach((ls, gi) => { const a = ls.reduce((s2, l) => s2 + area[l], 0); if (a > 0) units.push({ labels: ls.filter((l) => area[l] > 0), area: a, grad: groupGrad[gi] }); });
  units.sort((a, b) => b.area - a.area);
  const layers: Layer[] = [];
  let nodes = 0, paths = 0, rawPoints = 0, lines = 0, arcs = 0, ellipses = 0, curves = 0, gradients = 0;
  const minLoop = Math.max(1, o.speckle / 6);
  let nextSid = 0;
  const ownOf = new Map<Layer, Set<number>>(); // rótulos PRÓPRIOS de cada camada (sem os das camadas à frente, em "empilhado")

  interface Traced { paths: VPath[]; nodes: number; raw: number; lines: number; arcs: number; ellipses: number; curves: number }
  const trace = (set: Set<number>): Traced => {
    const mask = new Uint8Array(w * h);
    for (let i = 0; i < mask.length; i++) if (set.has(labels[i])) mask[i] = 1;
    // cobertura subpixel dos pixels de transição para as cores desta camada
    const cover = new Map<number, number>();
    for (let k = 0; k < tr.idx.length; k++) {
      const i = tr.idx[k], a = tr.a[k], b = tr.b[k];
      if (labels[i] !== a && labels[i] !== b) continue;
      const v = (set.has(a) ? 1 - tr.t[k] : 0) + (set.has(b) ? tr.t[k] : 0);
      cover.set(i, v);
    }
    const raw: Pt[][] = [];
    for (const loop of traceField(mask, w, h, o.contourBlur, cover)) {
      if (Math.abs(loopArea(loop)) < minLoop) continue;
      raw.push(loop);
    }
    const { hyd, owner } = structureHydraulic(raw);
    const sids = new Map<number, number>();
    const r: Traced = { paths: [], nodes: 0, raw: 0, lines: 0, arcs: 0, ellipses: 0, curves: 0 };
    raw.forEach((loop, k) => {
      const path = fitLoop(loop, { tolerance: o.lineFitTolerance, cornerThreshold: o.cornerThreshold, smooth: o.smooth, arcs: o.arcs, ellipses: o.ellipses, merge: internal.merge, hydraulic: hyd[k] });
      r.raw += loop.length;
      r.nodes += path.segs.length;
      for (const sg of path.segs) { if (sg.t === 'L') r.lines++; else if (sg.t === 'A') r.arcs++; else if (sg.t === 'E') r.ellipses++; else r.curves++; }
      path.sid = sids.get(owner[k]) ?? (sids.set(owner[k], nextSid), nextSid++);
      r.paths.push(path);
    });
    return r;
  };
  const commit = (t: Traced) => { nodes += t.nodes; rawPoints += t.raw; lines += t.lines; arcs += t.arcs; ellipses += t.ellipses; curves += t.curves; paths += t.paths.length; };
  const stacked = o.stacking === 'stacked';

  units.forEach((u, rank) => {
    progress(0.25 + (0.7 * rank) / Math.max(1, units.length), `Traçando cor ${rank + 1}/${units.length}`);
    const after = stacked ? units.slice(rank + 1).flatMap((v) => v.labels) : [];
    if (!u.grad) {
      const t = trace(new Set([...u.labels, ...after]));
      const layer: Layer = { color: hex(...palette[u.labels[0]]), paths: t.paths };
      commit(t);
      if (layer.paths.length) { layers.push(layer); ownOf.set(layer, new Set(u.labels)); }
      return;
    }
    // grupo de gradiente: região única com gradiente × bandas sólidas; a guarda exige não ter mais nós
    const bandOrder = [...u.labels].sort((a, b) => area[b] - area[a]);
    const bands = bandOrder.map((l, j) => ({ l, t: trace(new Set(stacked ? [...bandOrder.slice(j), ...after] : [l])) }));
    const bandLayers: Layer[] = bands.map((b) => ({ color: hex(...palette[b.l]), paths: b.t.paths })).filter((l) => l.paths.length);
    const gt = trace(new Set([...u.labels, ...after]));
    const bandNodes = bands.reduce((s2, b) => s2 + b.t.nodes, 0);
    if (gt.paths.length && gt.nodes <= bandNodes) {
      let sr = 0, sg = 0, sb = 0, sa = 0;
      for (const l of u.labels) { sr += palette[l][0] * area[l]; sg += palette[l][1] * area[l]; sb += palette[l][2] * area[l]; sa += area[l]; }
      const gl: Layer = { color: hex(sr / sa, sg / sa, sb / sa), paths: gt.paths, gradient: u.grad, fallback: bandLayers };
      layers.push(gl);
      ownOf.set(gl, new Set(u.labels));
      commit(gt);
      gradients++;
    } else {
      for (const b of bands) commit(b.t);
      bands.forEach((b, j) => { const bl = bandLayers.find((l) => l.paths === b.t.paths); if (bl) ownOf.set(bl, new Set([b.l])); void j; });
      layers.push(...bandLayers);
    }
  });

  let outLayers = layers;
  if (o.shapeColors && o.drawStyle === 'fill') {
    progress(0.96, 'Medindo a cor de cada forma');
    const skip = new Uint8Array(labels.length);
    for (const i of tr.idx) skip[i] = 1;
    outLayers = paintShapes(layers, ownOf, img.data, labels, skip, w, h, o.gradients, dn.applied ? 3 : 1.2);
  }
  const shapeIds = new Set<number>();
  for (const l of outLayers) for (const p of l.paths) if (p.sid !== undefined) shapeIds.add(p.sid);
  gradients = outLayers.filter((l) => l.gradient).length;

  progress(1, 'Pronto');
  let transparent = false;
  for (let i = 0; i < labels.length && !transparent; i++) if (labels[i] < 0) transparent = true;
  return { width: w, height: h, layers: outLayers, openBoundary: transparent || bg >= 0, stacking: o.stacking, stats: { nodes, paths, colors: outLayers.length, ms: performance.now() - t0, rawPoints, lines, arcs, ellipses, curves, recolored, noise: dn.noise.sigma, denoised: dn.applied, gradients, shapes: shapeIds.size } };
}
