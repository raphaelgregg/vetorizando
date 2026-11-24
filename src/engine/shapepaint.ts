import { hex, rgbToLab, dist2, Lab } from './color';
import { fitGroup, Samples } from './gradient';
import { flattenPath } from './geom';
import type { Layer, Pt, VPath } from './types';

/** Preenchimento por varredura (regra do enrolamento ≠ 0, como o SVG) → faixas [y, x0, x1] de pixels cujo centro está dentro. */
export function rasterSpans(paths: VPath[], w: number, h: number): Int32Array {
  const polys = paths.map((p) => flattenPath(p, 0.25));
  let y0 = Infinity, y1 = -Infinity;
  for (const poly of polys) for (const p of poly) { if (p.y < y0) y0 = p.y; if (p.y > y1) y1 = p.y; }
  const r0 = Math.max(0, Math.floor(y0 - 1)), r1 = Math.min(h - 1, Math.ceil(y1 + 1));
  if (!(r1 >= r0)) return new Int32Array(0);
  const rows: number[][] = Array.from({ length: r1 - r0 + 1 }, () => []);
  const edges: [number, number, number, number][] = [];
  for (const poly of polys) {
    for (let i = 0; i < poly.length; i++) {
      const a = poly[i], b: Pt = poly[(i + 1) % poly.length];
      if (a.y === b.y) continue;
      const k = edges.length;
      edges.push([a.x, a.y, b.x, b.y]);
      const lo = Math.max(r0, Math.ceil(Math.min(a.y, b.y) - 0.5)), hi = Math.min(r1, Math.ceil(Math.max(a.y, b.y) - 0.5) - 1);
      for (let r = lo; r <= hi; r++) rows[r - r0].push(k);
    }
  }
  const out: number[] = [];
  for (let r = r0; r <= r1; r++) {
    const yc = r + 0.5, xs: [number, number][] = [];
    for (const k of rows[r - r0]) {
      const [ax, ay, bx, by] = edges[k];
      xs.push([ax + ((yc - ay) * (bx - ax)) / (by - ay), by > ay ? 1 : -1]);
    }
    xs.sort((p, q) => p[0] - q[0]);
    let wind = 0;
    for (let i = 0; i < xs.length - 1; i++) {
      wind += xs[i][1];
      if (wind === 0) continue;
      const xa = Math.max(0, Math.ceil(xs[i][0] - 0.5)), xb = Math.min(w - 1, Math.ceil(xs[i + 1][0] - 0.5) - 1);
      if (xb >= xa) out.push(r, xa, xb);
    }
  }
  return Int32Array.from(out);
}

const MIN_PIXELS = 20; // abaixo disso a forma é detalhe minúsculo: fica com a cor da camada
const GRAD_MIN_PIXELS = 400;
const MAX_SAMPLES = 3000;

/**
 * Cor ORIGINAL de cada forma: média dos pixels "limpos" da imagem dentro dela (só rótulos próprios da camada).
 * Se for praticamente a cor da camada (ΔE < 1,2; 3 com ruído, onde a média filtrada é enviesada pelo corte em 0/255) mantém a da camada — imagens chapadas ficam idênticas.
 * Com `gradients`, tenta um gradiente linear/radial por forma; só vale se reduzir claramente o erro frente à cor
 * sólida (ganho ≥ max(0,8; 25 %) de ΔE76 médio) e passar nas guardas de degrau/amplitude.
 * Camadas divididas em formas de cores diferentes viram uma camada por cor (mesma posição na ordem de desenho).
 */
export function paintShapes(layers: Layer[], own: Map<Layer, Set<number>>, rgba: Uint8ClampedArray, labels: Int16Array, skip: Uint8Array, w: number, h: number, gradients: boolean, snap = 1.2): Layer[] {
  const out: Layer[] = [];
  for (const layer of layers) {
    const labs = own.get(layer);
    if (layer.gradient || !labs || !layer.paths.length || layer.paths.some((p) => p.sid === undefined)) { out.push(layer); continue; }
    const bySid = new Map<number, VPath[]>();
    for (const p of layer.paths) bySid.set(p.sid!, [...(bySid.get(p.sid!) ?? []), p]);
    const layerLab = ((): Lab => { const n = layer.color; return rgbToLab(parseInt(n.slice(1, 3), 16), parseInt(n.slice(3, 5), 16), parseInt(n.slice(5, 7), 16)); })();
    const paint = new Map<number, { color: string; gradient?: Layer['gradient'] }>();
    for (const [sid, ps] of bySid) {
      const spans = rasterSpans(ps, w, h);
      let total = 0;
      for (let k = 0; k < spans.length; k += 3) total += spans[k + 2] - spans[k + 1] + 1;
      if (total < MIN_PIXELS) { paint.set(sid, { color: layer.color }); continue; }
      const stride = Math.max(1, Math.ceil(total / MAX_SAMPLES));
      let n = 0, sr = 0, sg = 0, sb = 0, cnt = 0;
      const xs: number[] = [], ys: number[] = [], rgb: number[] = [];
      let bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
      for (let k = 0; k < spans.length; k += 3) {
        const y = spans[k];
        for (let x = spans[k + 1]; x <= spans[k + 2]; x++) {
          const i = y * w + x;
          if (skip[i] || !labs.has(labels[i])) continue;
          const r = rgba[i * 4], g = rgba[i * 4 + 1], b = rgba[i * 4 + 2];
          sr += r; sg += g; sb += b; cnt++;
          if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y;
          if (n++ % stride === 0) { xs.push(x + 0.5); ys.push(y + 0.5); rgb.push(r, g, b); }
        }
      }
      if (cnt < MIN_PIXELS) { paint.set(sid, { color: layer.color }); continue; }
      const mr = sr / cnt, mg = sg / cnt, mb = sb / cnt;
      const mLab = rgbToLab(mr, mg, mb);
      const solid = Math.sqrt(dist2(mLab, layerLab)) < snap ? layer.color : hex(mr, mg, mb);
      let entry: { color: string; gradient?: Layer['gradient'] } = { color: solid };
      if (gradients && cnt >= GRAD_MIN_PIXELS) {
        const labsS: Lab[] = [];
        for (let i = 0; i < xs.length; i++) labsS.push(rgbToLab(rgb[i * 3], rgb[i * 3 + 1], rgb[i * 3 + 2]));
        const s: Samples = { n: xs.length, x: Float32Array.from(xs), y: Float32Array.from(ys), rgb: Float32Array.from(rgb), lab: labsS, band: labsS.map(() => mLab) };
        const g = fitGroup(s, [bx0, by0, bx1 + 1, by1 + 1], 0.8, 0.25, 3);
        if (g) entry = { color: hex(mr, mg, mb), gradient: g };
      }
      paint.set(sid, entry);
    }
    // uma camada por tinta distinta, na posição da original; formas de mesma cor sólida ficam juntas
    const groups = new Map<string, Layer>();
    for (const p of layer.paths) {
      const e = paint.get(p.sid!)!;
      const key = e.gradient ? `g${p.sid}` : e.color;
      let g = groups.get(key);
      if (!g) { g = e.gradient ? { color: e.color, paths: [], gradient: e.gradient } : { color: e.color, paths: [] }; groups.set(key, g); }
      g.paths.push(p);
    }
    out.push(...groups.values());
  }
  return out;
}
