import jpeg from 'jpeg-js';
import { PRESETS } from '../src/engine/presets';
import { toSVG } from '../src/engine/svg';
import type { RawImage } from '../src/engine/types';
import { vectorize } from '../src/engine/vectorize';
import { CASES, rasterize } from './cases';
import { renderSvg } from './io';
import { compare } from './metrics';

/**
 * Teste de ESTRESSE: degrada os casos embutidos como imagens de produção são degradadas (JPEG, ruído, suavização)
 * e mede o motor de duas formas:
 *  - contra a imagem DEGRADADA (o que o usuário enviou);
 *  - contra a imagem LIMPA original (a verdade): mostra o quanto o ruído é "copiado" para o vetor.
 * Também compara os nós com a execução sem degradação.
 */
export interface Degradation { id: string; label: string; apply: (img: RawImage) => RawImage }

function rng(seed: number) { let s = seed >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

const jpegQ = (q: number): Degradation => ({
  id: `jpeg${q}`, label: `JPEG qualidade ${q}`,
  apply: (img) => {
    const flat = new Uint8ClampedArray(img.data); // JPEG não tem alfa: compõe sobre branco
    for (let i = 0; i < flat.length; i += 4) { const a = flat[i + 3] / 255; for (let c = 0; c < 3; c++) flat[i + c] = flat[i + c] * a + 255 * (1 - a); flat[i + 3] = 255; }
    const enc = jpeg.encode({ data: Buffer.from(flat), width: img.width, height: img.height }, q);
    const dec = jpeg.decode(enc.data, { useTArray: true });
    return { data: new Uint8ClampedArray(dec.data), width: dec.width, height: dec.height };
  },
});

const noise = (sigma: number): Degradation => ({
  id: `ruido${sigma}`, label: `ruído gaussiano σ=${sigma}`,
  apply: (img) => {
    const r = rng(7), d = new Uint8ClampedArray(img.data);
    for (let i = 0; i < d.length; i += 4) { const g = Math.sqrt(-2 * Math.log(r() || 1e-9)) * Math.cos(2 * Math.PI * r()) * sigma; for (let c = 0; c < 3; c++) d[i + c] += g; }
    return { data: d, width: img.width, height: img.height };
  },
});

const soft: Degradation = {
  id: 'suave', label: 'suavizada (blur 3×3 ×2: ampliação/redimensionamento)',
  apply: (img) => {
    let cur = img;
    for (let p = 0; p < 2; p++) {
      const d = new Uint8ClampedArray(cur.data.length), { width: w, height: h } = cur;
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        // blur PRÉ-MULTIPLICADO (como editores/navegadores fazem): a cor dos pixels transparentes não vaza para a borda
        let sr = 0, sg = 0, sb = 0, sa = 0, n = 0;
        for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx, yy = y + dy;
          if (xx < 0 || yy < 0 || xx >= w || yy >= h) continue;
          const i = (yy * w + xx) * 4, a = cur.data[i + 3];
          sr += cur.data[i] * a; sg += cur.data[i + 1] * a; sb += cur.data[i + 2] * a; sa += a; n++;
        }
        const o = (y * w + x) * 4;
        d[o + 3] = sa / n;
        if (sa > 0) { d[o] = sr / sa; d[o + 1] = sg / sa; d[o + 2] = sb / sa; }
      }
      cur = { data: d, width: w, height: h };
    }
    return cur;
  },
};

export const DEGRADATIONS: Degradation[] = [jpegQ(95), jpegQ(85), jpegQ(70), jpegQ(50), noise(4), noise(10), soft];
export const STRESS_CASES = ['logo', 'icon', 'lineart', 'text', 'illustration'];

export interface StressRow {
  caseId: string; degradation: string; nodes: number; cleanNodes: number;
  ssimVsInput: number; ssimVsTruth: number; deltaEVsTruth: number; edgeVsTruth: number; flatVsTruth: number; noise: number; ms: number;
}

export function runStress(cases = STRESS_CASES, degs = DEGRADATIONS, over: { denoise?: number } = {}): StressRow[] {
  const rows: StressRow[] = [];
  for (const id of cases) {
    const c = CASES.find((x) => x.id === id)!;
    const o = { ...PRESETS.find((p) => p.id === c.preset)!.options, ...c.options, ...(over.denoise !== undefined ? { denoise: over.denoise } : {}) };
    const clean = rasterize(c.svg);
    const cleanNodes = vectorize(clean, o).stats.nodes;
    for (const d of degs) {
      const input = d.apply(clean);
      const t0 = performance.now();
      const doc = vectorize(input, o);
      const ms = performance.now() - t0;
      const out = renderSvg(toSVG(doc, o), input.width);
      const vsInput = compare(input, out), vsTruth = compare(clean, out);
      rows.push({ caseId: id, degradation: d.id, nodes: doc.stats.nodes, cleanNodes, ssimVsInput: vsInput.ssim, ssimVsTruth: vsTruth.ssim, deltaEVsTruth: vsTruth.deltaE, edgeVsTruth: vsTruth.deltaEEdge, flatVsTruth: vsTruth.deltaEFlat, noise: doc.stats.noise, ms });
    }
  }
  return rows;
}

export function formatStress(rows: StressRow[]): string {
  const h = ['caso', 'degradação', 'nós (limpo)', 'SSIM×entrada', 'SSIM×verdade', 'ΔE×verdade', 'ΔEborda×verdade', 'ΔEplano×verdade', 'nós/limpo', 'ruído σ̂', 'ms'];
  const lines = [h.join('\t')];
  for (const r of rows) lines.push([r.caseId, r.degradation, `${r.nodes} (${r.cleanNodes})`, r.ssimVsInput.toFixed(4), r.ssimVsTruth.toFixed(4), r.deltaEVsTruth.toFixed(2), r.edgeVsTruth.toFixed(2), r.flatVsTruth.toFixed(2), `${(r.nodes / Math.max(1, r.cleanNodes)).toFixed(1)}×`, r.noise ? r.noise.toFixed(1) : '—', Math.round(r.ms)].join('\t'));
  return lines.join('\n');
}

/** A/B: pré-filtro desligado (antes) × ligado (depois), com variação de cada métrica contra a VERDADE limpa. */
export function formatAB(off: StressRow[], on: StressRow[]): string {
  const h = ['caso', 'degradação', 'nós antes→depois', 'SSIM×verdade', 'ΔE×verdade', 'ΔEborda×verdade', 'ΔEplano×verdade', 'σ̂', 'ms antes→depois'];
  const lines = [h.join('\t')];
  const f = (a: number, b: number, d: number) => `${a.toFixed(d)}→${b.toFixed(d)}`;
  off.forEach((a, i) => {
    const b = on[i];
    lines.push([a.caseId, a.degradation, `${a.nodes}→${b.nodes}`, f(a.ssimVsTruth, b.ssimVsTruth, 4), f(a.deltaEVsTruth, b.deltaEVsTruth, 2), f(a.edgeVsTruth, b.edgeVsTruth, 2), f(a.flatVsTruth, b.flatVsTruth, 2), b.noise ? b.noise.toFixed(1) : '—', `${Math.round(a.ms)}→${Math.round(b.ms)}`].join('\t'));
  });
  return lines.join('\n');
}

if (process.argv[1]?.endsWith('stress.ts')) {
  const arg = (n: string) => (process.argv.includes(n) ? process.argv[process.argv.indexOf(n) + 1] : undefined);
  const only = arg('--cases')?.split(',') ?? STRESS_CASES;
  const degs = arg('--degs')?.split(',');
  const sel = degs ? DEGRADATIONS.filter((d) => degs.includes(d.id)) : DEGRADATIONS;
  if (process.argv.includes('--ab')) console.log(formatAB(runStress(only, sel, { denoise: 0 }), runStress(only, sel, { denoise: Number(arg('--denoise') ?? 1) })));
  else console.log(formatStress(runStress(only, sel, arg('--denoise') !== undefined ? { denoise: Number(arg('--denoise')) } : {})));
}
