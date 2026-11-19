import { PNG } from 'pngjs';
import type { RawImage } from '../src/engine/types';
import { deltaEMap, flatten } from './metrics';
import type { Row } from './suite';

export interface Tile { x: number; y: number; w: number; h: number; share: number; mean: number }

/** Onde está o erro: os `n` blocos de `size`×`size` px com maior soma de ΔE (e a fatia do erro total que cada um concentra). */
export function worstTiles(map: Float32Array, w: number, h: number, size = 64, n = 5): Tile[] {
  const cols = Math.ceil(w / size), rows = Math.ceil(h / size);
  const sum = new Float64Array(cols * rows), cnt = new Float64Array(cols * rows);
  let total = 0;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const t = Math.floor(y / size) * cols + Math.floor(x / size);
    sum[t] += map[y * w + x]; cnt[t]++; total += map[y * w + x];
  }
  return [...sum.keys()]
    .sort((a, b) => sum[b] - sum[a])
    .slice(0, n)
    .map((t) => ({ x: (t % cols) * size, y: Math.floor(t / cols) * size, w: Math.min(size, w - (t % cols) * size), h: Math.min(size, h - Math.floor(t / cols) * size), share: total ? sum[t] / total : 0, mean: cnt[t] ? sum[t] / cnt[t] : 0 }));
}

/** PNG lado a lado: original | nosso SVG | mapa de erro (vermelho = ΔE alto) [| referência]. Reduz cada painel a ≤ `maxW` px. */
export function comparePng(r: Row, maxW = 560): Buffer {
  const orig = r.original!;
  const panels: RawImage[] = [orig, r.rendered];
  const map = deltaEMap(orig, r.rendered);
  const heat = new Uint8ClampedArray(orig.width * orig.height * 4);
  const base = flatten(orig);
  for (let i = 0; i < map.length; i++) {
    const g = (0.299 * base[i * 3] + 0.587 * base[i * 3 + 1] + 0.114 * base[i * 3 + 2]) * 0.35 + 255 * 0.45;
    const e = Math.min(1, map[i] / 30);
    heat[i * 4] = g + (255 - g) * e; heat[i * 4 + 1] = g * (1 - e); heat[i * 4 + 2] = g * (1 - e); heat[i * 4 + 3] = 255;
  }
  panels.push({ data: heat, width: orig.width, height: orig.height });
  if (r.refRendered) panels.push(r.refRendered);
  const k = Math.min(1, maxW / orig.width);
  const pw = Math.max(1, Math.round(orig.width * k)), ph = Math.max(1, Math.round(orig.height * k)), gap = 6;
  const png = new PNG({ width: panels.length * pw + (panels.length - 1) * gap, height: ph });
  png.data.fill(255);
  panels.forEach((im, p) => {
    for (let y = 0; y < ph; y++) for (let x = 0; x < pw; x++) {
      const sx = Math.min(im.width - 1, Math.floor(x / k)), sy = Math.min(im.height - 1, Math.floor(y / k));
      const si = (sy * im.width + sx) * 4, a = im.data[si + 3] / 255, di = (y * png.width + p * (pw + gap) + x) * 4;
      for (let c = 0; c < 3; c++) png.data[di + c] = im.data[si + c] * a + 255 * (1 - a);
      png.data[di + 3] = 255;
    }
  });
  return PNG.sync.write(png);
}

const pct = (v: number) => `${Math.round(v * 100)}%`;
/** "nosso X vs ref Y (melhor/pior/igual)" */
const vs = (name: string, ours: number, ref: number, higherBetter: boolean, d: number) => {
  const diff = higherBetter ? ours - ref : ref - ours;
  const tag = Math.abs(diff) < 0.5 * 10 ** -d ? 'igual' : diff > 0 ? 'melhor' : 'pior';
  return `${name} ${ours.toFixed(d)} vs ${ref.toFixed(d)} (${tag})`;
};

/** Diagnóstico por par e dois rankings de “margem de ganho” (com referência: distância até ela; sem: 1 − SSIM). */
export function formatReport(rows: Row[]): string {
  const out: string[] = [];
  const withRef: { id: string; gap: number; why: string }[] = [], noRef: { id: string; gap: number }[] = [];
  for (const r of rows) {
    const m = r.ours.metrics, mp = (r.width * r.height) / 1e6;
    out.push(`\n== ${r.id} (${r.preset}, ${r.width}×${r.height})`);
    out.push(`  erro: ${pct(m.errEdgeShare)} geométrico (bordas) · ${pct(1 - m.errEdgeShare)} cor (áreas planas) → foco: ${m.errEdgeShare >= 0.6 ? 'GEOMETRIA' : m.errEdgeShare <= 0.35 ? 'COR' : 'geometria e cor'}`);
    const hints: string[] = [];
    if (r.ref) {
      const q = r.ref.metrics;
      out.push(`  nós: ${r.ours.nodes} (ref ${r.ref.nodes}, ${(r.ours.nodes / Math.max(1, r.ref.nodes)).toFixed(1)}×)`);
      out.push('  nosso vs ref: ' + [vs('SSIM', m.ssim, q.ssim, true, 4), vs('ΔE', m.deltaE, q.deltaE, false, 3), vs('ΔEborda', m.deltaEEdge, q.deltaEEdge, false, 2), vs('ΔEplano', m.deltaEFlat, q.deltaEFlat, false, 2)].join(' · '));
      const gap = Math.max(0, q.ssim - m.ssim) + Math.max(0, m.deltaE - q.deltaE) * 0.01;
      withRef.push({ id: r.id, gap, why: gap > 0 ? `perde (SSIM ${m.ssim.toFixed(4)} vs ${q.ssim.toFixed(4)}; ΔE ${m.deltaE.toFixed(2)} vs ${q.deltaE.toFixed(2)})` : 'iguala/supera a referência' });
      if (r.ours.nodes > 5 * r.ref.nodes) hints.push(`${(r.ours.nodes / Math.max(1, r.ref.nodes)).toFixed(0)}× mais nós que a referência: contorno ruidoso (artefatos JPEG/ruído?) ou tolerância baixa demais`);
      if (m.deltaEEdge > q.deltaEEdge * 1.15) hints.push('borda pior que a referência: posição/espessura de contornos (reveja lineFitTolerance/smooth/edgeDelta)');
      if (m.deltaEFlat > q.deltaEFlat * 1.15 + 0.05) hints.push('cor pior que a referência: aumente maxColors ou reduza mergeDeltaE');
    } else {
      out.push(`  nós: ${r.ours.nodes} (${Math.round(r.ours.nodes / mp)} por Mpx) · SSIM ${m.ssim.toFixed(4)} · ΔE ${m.deltaE.toFixed(2)} (borda ${m.deltaEEdge.toFixed(2)}, plano ${m.deltaEFlat.toFixed(2)})`);
      noRef.push({ id: r.id, gap: 1 - m.ssim });
    }
    if (r.ours.nodes / mp > 2500) hints.push(`${Math.round(r.ours.nodes / mp)} nós/Mpx: contornos muito fragmentados (ruído/JPEG?) — candidato a pré-filtro`);
    if (m.deltaEFlat > 1.5) hints.push(`ΔEplano ${m.deltaEFlat.toFixed(2)}: erro de cor (quantização) — mais cores ou preset de ilustração/foto`);
    if (m.hd95 > 5 && m.hd95 < 100) hints.push(`HD95 ${m.hd95.toFixed(1)} px: bordas deslocadas`);
    const tiles = worstTiles(deltaEMap(r.original!, r.rendered), r.width, r.height);
    out.push('  maiores erros: ' + tiles.map((t) => `(${t.x},${t.y}) ${t.w}×${t.h} = ${pct(t.share)} do erro`).join(' · '));
    for (const h of hints) out.push('  → ' + h);
    for (const w of r.warnings) out.push('  ⚠ ' + w);
  }
  if (withRef.length) {
    out.push('\nMargem de ganho — pares COM referência (maior distância primeiro):');
    withRef.sort((a, b) => b.gap - a.gap).forEach((x, i) => out.push(`  ${i + 1}. ${x.id} — ${x.why}`));
  }
  if (noRef.length) {
    out.push('\nPares SEM referência (pior SSIM primeiro; sem ref.svg não dá para saber o que é alcançável):');
    noRef.sort((a, b) => b.gap - a.gap).forEach((x, i) => out.push(`  ${i + 1}. ${x.id} — 1 − SSIM = ${x.gap.toFixed(4)}`));
  }
  return out.join('\n');
}
