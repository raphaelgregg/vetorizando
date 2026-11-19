import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join, parse } from 'node:path';
import { PRESETS } from '../src/engine/presets';
import { toSVG } from '../src/engine/svg';
import { DEFAULT_OPTIONS, Options, RawImage } from '../src/engine/types';
import { vectorize } from '../src/engine/vectorize';
import { CASES, rasterize } from './cases';
import { readRasterInfo, renderSvg } from './io';
import { Metrics, compare, countSvgNodes } from './metrics';

export const MAX_DIM = 1400; // mesmo limite de processamento da UI

export interface Result { nodes: number; bytes: number; ms?: number; metrics: Metrics }
export interface Thresholds { ssim?: number; deltaE?: number; hd95?: number; nodes?: number; deltaEEdge?: number; deltaEFlat?: number }
export interface Issue { id: string; level: 'error' | 'warn'; message: string }

/** Chave dos limites em thresholds.json: casos embutidos = `id`; pares = `pair:id` (evita colidir com os embutidos). */
export const thresholdKey = (source: 'builtin' | 'pair', id: string) => (source === 'pair' ? `pair:${id}` : id);

export interface Row {
  id: string;
  key: string; // chave em thresholds.json
  hasLimits: boolean;
  warnings: string[];
  source: 'builtin' | 'pair';
  preset: string;
  width: number;
  height: number;
  ours: Result;
  ref?: Result; // resultado do SVG de referência (quando existir)
  refRendered?: RawImage;
  original?: RawImage; // raster (já reduzido) usado na comparação
  svg: string;
  rendered: RawImage;
  failures: string[];
}
export interface ThresholdFile { default: Thresholds; cases: Record<string, Thresholds> }

export function loadThresholds(path: string): ThresholdFile {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : { default: {}, cases: {} };
}

function downscale(img: RawImage, maxDim: number): RawImage {
  const k = Math.min(1, maxDim / Math.max(img.width, img.height));
  if (k === 1) return img;
  const w = Math.max(1, Math.round(img.width * k)), h = Math.max(1, Math.round(img.height * k));
  const out = new Uint8ClampedArray(w * h * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const x0 = Math.floor(x / k), x1 = Math.max(x0 + 1, Math.floor((x + 1) / k)), y0 = Math.floor(y / k), y1 = Math.max(y0 + 1, Math.floor((y + 1) / k));
      const acc = [0, 0, 0, 0]; let n = 0;
      for (let yy = y0; yy < Math.min(y1, img.height); yy++) for (let xx = x0; xx < Math.min(x1, img.width); xx++) { const p = (yy * img.width + xx) * 4; for (let c = 0; c < 4; c++) acc[c] += img.data[p + c]; n++; }
      for (let c = 0; c < 4; c++) out[(y * w + x) * 4 + c] = acc[c] / (n || 1);
    }
  }
  return { data: out, width: w, height: h };
}

export function check(r: Result, t: Thresholds = {}): string[] {
  const f: string[] = [];
  const m = r.metrics;
  if (t.ssim !== undefined && m.ssim < t.ssim) f.push(`SSIM ${m.ssim.toFixed(4)} < ${t.ssim}`);
  if (t.deltaE !== undefined && m.deltaE > t.deltaE) f.push(`ΔE ${m.deltaE.toFixed(2)} > ${t.deltaE}`);
  if (t.hd95 !== undefined && m.hd95 > t.hd95) f.push(`HD95 ${m.hd95.toFixed(2)} > ${t.hd95}`);
  if (t.deltaEEdge !== undefined && m.deltaEEdge > t.deltaEEdge) f.push(`ΔEborda ${m.deltaEEdge.toFixed(2)} > ${t.deltaEEdge}`);
  if (t.deltaEFlat !== undefined && m.deltaEFlat > t.deltaEFlat) f.push(`ΔEplano ${m.deltaEFlat.toFixed(2)} > ${t.deltaEFlat}`);
  if (t.nodes !== undefined && r.nodes > t.nodes) f.push(`nós ${r.nodes} > ${t.nodes}`);
  return f;
}

export function evaluate(id: string, source: Row['source'], raster: RawImage, options: Options, presetId: string, refSvg: string | undefined, th: ThresholdFile, warnings: string[] = []): Row {
  const img = downscale(raster, MAX_DIM);
  let doc;
  const t0 = performance.now();
  try {
    doc = vectorize(img, options);
  } catch (e) {
    throw new Error(`${id}: falha no motor: ${e instanceof Error ? e.message : e}`);
  }
  const ms = performance.now() - t0;
  const svg = toSVG(doc, options);
  const rendered = renderSvg(svg, img.width);
  const ours: Result = { nodes: doc.stats.nodes, bytes: svg.length, ms, metrics: compare(img, rendered) };
  const key = thresholdKey(source, id);
  const limits = { ...th.default, ...th.cases[key] };
  const row: Row = { original: img, id, key, hasLimits: Object.keys(limits).length > 0, warnings, source, preset: presetId, width: img.width, height: img.height, ours, svg, rendered, failures: [] };
  if (refSvg) {
    try {
      let refRender = renderSvg(refSvg, img.width);
      const dh = Math.abs(refRender.height - img.height);
      if (dh > 2) {
        warnings.push(`SVG de referência com proporção diferente da imagem (renderizado ${refRender.width}×${refRender.height}, imagem ${img.width}×${img.height}): ignorado. Exporte o ref com a mesma proporção.`);
      } else {
        if (dh > 0) refRender = fitHeight(refRender, img.height); // arredondamento de 1–2 px na altura
        row.ref = { nodes: countSvgNodes(refSvg), bytes: refSvg.length, metrics: compare(img, refRender) };
        row.refRendered = refRender;
      }
    } catch (e) {
      warnings.push(`SVG de referência inválido (${e instanceof Error ? e.message.split('\n')[0] : e}): comparação com a referência ignorada.`);
    }
  }
  row.failures = check(ours, limits);
  return row;
}

/** Corta/preenche (transparente) para a altura pedida — só para diferenças de 1–2 px por arredondamento. */
function fitHeight(img: RawImage, h: number): RawImage {
  const data = new Uint8ClampedArray(img.width * h * 4);
  data.set(img.data.subarray(0, Math.min(img.data.length, data.length)));
  return { data, width: img.width, height: h };
}

export function runBuiltin(th: ThresholdFile, only?: string[]): Row[] {
  return CASES.filter((c) => !only || only.includes(c.id)).map((c) =>
    evaluate(c.id, 'builtin', rasterize(c.svg), { ...PRESETS.find((p) => p.id === c.preset)!.options, ...c.options }, c.preset, undefined, th),
  );
}

/** Chaves aceitas em `nome.json` → options do motor. */
const OPTION_KEYS = new Set(Object.keys(DEFAULT_OPTIONS));

/**
 * Pares de referência: `<nome>.png|jpg` + opcional `<nome>.ref.svg` e `<nome>.json` ({preset, options}).
 * Um par com problema NÃO derruba os outros: o erro/aviso vai para `issues` e a execução continua.
 */
export function runPairs(dir: string, th: ThresholdFile, presetOverride?: string, issues: Issue[] = []): Row[] {
  if (!existsSync(dir)) return [];
  const rows: Row[] = [];
  const files = readdirSync(dir).sort();
  const images = new Set<string>();
  for (const f of files) if (/\.(png|jpe?g)$/i.test(f)) images.add(parse(f).name);
  for (const f of files) {
    if (f === 'README.md' || /\.(png|jpe?g)$/i.test(f)) continue;
    const ref = /^(.*)\.ref\.svg$/i.exec(f), cfg = /^(.*)\.json$/i.exec(f);
    const base = ref?.[1] ?? cfg?.[1];
    if (base !== undefined) { if (!images.has(base)) issues.push({ id: base, level: 'warn', message: `${f}: não há imagem ${base}.png/.jpg correspondente (arquivo ignorado)` }); }
    else issues.push({ id: f, level: 'warn', message: `${f}: tipo não suportado (use PNG ou JPG; WebP/AVIF/GIF devem ser convertidos)` });
  }
  for (const f of files) {
    if (!/\.(png|jpe?g)$/i.test(f)) continue;
    const { name } = parse(f);
    const warnings: string[] = [];
    try {
      const refPath = join(dir, `${name}.ref.svg`), cfgPath = join(dir, `${name}.json`);
      let cfg: { preset?: string; options?: Record<string, unknown> } = {};
      if (existsSync(cfgPath)) {
        try { cfg = JSON.parse(readFileSync(cfgPath, 'utf8')); } catch (e) { throw new Error(`${name}.json inválido: ${e instanceof Error ? e.message : e}`); }
      }
      const presetId = presetOverride ?? cfg.preset ?? 'logo';
      const preset = PRESETS.find((p) => p.id === presetId);
      if (!preset) throw new Error(`preset desconhecido "${presetId}" (use: ${PRESETS.map((p) => p.id).join(', ')})`);
      for (const k of Object.keys(cfg.options ?? {})) if (!OPTION_KEYS.has(k)) warnings.push(`${name}.json: opção desconhecida "${k}" (ignorada pelo motor)`);
      const options: Options = { ...DEFAULT_OPTIONS, ...preset.options, ...(cfg.options ?? {}) } as Options;
      let info;
      try { info = readRasterInfo(join(dir, f)); } catch (e) { throw new Error(`não foi possível ler a imagem: ${e instanceof Error ? e.message : e}`); }
      if (info.orientation > 1) warnings.push(`orientação EXIF ${info.orientation} aplicada (como a UI faz); o ref.svg deve estar na orientação exibida`);
      rows.push(evaluate(name, 'pair', info.image, options, preset.id, existsSync(refPath) ? readFileSync(refPath, 'utf8') : undefined, th, warnings));
    } catch (e) {
      issues.push({ id: name, level: 'error', message: e instanceof Error ? e.message : String(e) });
    }
    for (const w of warnings) issues.push({ id: name, level: 'warn', message: w });
  }
  return rows;
}

/**
 * Limites propostos a partir do resultado medido (com folga pequena e FIXA):
 * SSIM −0,002 · ΔE ×1,10 + 0,03 · ΔEborda ×1,10 + 0,15 · ΔEplano ×1,10 + 0,05 · nós ×1,12 + 2.
 * HD95 só entra em imagens de bordas duras (≤ 5 px): em degradês a quantização cria bandas que o original não tem.
 */
export function proposeThresholds(r: Row): Thresholds {
  const m = r.ours.metrics;
  const r2 = (v: number) => Math.round(v * 100) / 100;
  const t: Thresholds = {
    ssim: Math.floor((m.ssim - 0.002) * 1000) / 1000,
    deltaE: r2(m.deltaE * 1.1 + 0.03),
    deltaEEdge: r2(m.deltaEEdge * 1.1 + 0.15),
    deltaEFlat: r2(m.deltaEFlat * 1.1 + 0.05),
    nodes: Math.ceil(r.ours.nodes * 1.12) + 2,
  };
  if (m.hd95 <= 5) t.hd95 = Math.max(1.5, Math.round((m.hd95 + 0.5) * 10) / 10);
  return t;
}

/** Combina limites: fica o mais ESTRITO de cada métrica (SSIM maior; ΔE/HD95/nós menores), salvo `loosen`. */
export function mergeStricter(old: Thresholds | undefined, proposed: Thresholds, loosen = false): Thresholds {
  if (!old || loosen) return proposed;
  const out: Thresholds = { ...old };
  for (const k of Object.keys(proposed) as (keyof Thresholds)[]) {
    const a = old[k], b = proposed[k];
    if (b === undefined) continue;
    out[k] = a === undefined ? b : k === 'ssim' ? Math.max(a, b) : Math.min(a, b);
  }
  return out;
}

export function formatTable(rows: Row[]): string {
  const h = ['caso', 'preset', 'SSIM', 'ΔE', 'ΔE95', 'HD95', 'HDmax', 'nós', 'KB', 'ms', 'ΔEborda', 'ΔEplano', 'status'];
  const lines = [h.join('\t')];
  for (const r of rows) {
    const m = r.ours.metrics;
    lines.push([r.id, r.preset, m.ssim.toFixed(4), m.deltaE.toFixed(2), m.deltaEp95.toFixed(1), m.hd95.toFixed(2), m.hdMax.toFixed(1), r.ours.nodes, (r.ours.bytes / 1024).toFixed(1), Math.round(r.ours.ms ?? 0), m.deltaEEdge.toFixed(2), m.deltaEFlat.toFixed(2), r.failures.length ? 'FALHA: ' + r.failures.join('; ') : r.hasLimits ? 'ok' : 'ok (sem limites: rode --calibrate --write)'].join('\t'));
    if (r.ref) {
      const q = r.ref.metrics;
      lines.push([`  ↳ ref`, '', q.ssim.toFixed(4), q.deltaE.toFixed(2), q.deltaEp95.toFixed(1), q.hd95.toFixed(2), q.hdMax.toFixed(1), r.ref.nodes, (r.ref.bytes / 1024).toFixed(1), '', q.deltaEEdge.toFixed(2), q.deltaEFlat.toFixed(2), ''].join('\t'));
    }
  }
  const pass = rows.filter((r) => !r.failures.length).length;
  lines.push(`\nTaxa de sucesso: ${pass}/${rows.length} (${rows.length ? Math.round((100 * pass) / rows.length) : 0}%)`);
  return lines.join('\n');
}
