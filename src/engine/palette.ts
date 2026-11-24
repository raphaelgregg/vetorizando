import { Lab, dist2, rgbToLab } from './color';
import { flattenPath } from './geom';
import type { Layer, Seg, VDoc } from './types';

/**
 * Edição de paleta SOBRE o vetor gerado (sem reprocessar a imagem).
 * As edições são indexadas pela cor ORIGINAL da camada (hex), então sobrevivem a reprocessamentos.
 */
export interface PaletteEdit {
  color?: string; // nova cor (#rrggbb)
  hidden?: boolean; // transparente (a camada some)
}
export type PaletteEdits = Record<string, PaletteEdit>;

export interface PaletteEntry {
  original: string;
  color: string; // cor atual (após edições)
  hidden: boolean;
  edited: boolean;
  paths: number;
  nodes: number;
  area: number; // px² no espaço do documento
  gradient: boolean; // a camada é preenchida com gradiente (editar a cor a torna sólida)
}

/** `#abc`, `abc`, `#AABBCC` → `#aabbcc`; inválido → null */
export function normalizeHex(input: string): string | null {
  const m = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(input.trim());
  if (!m) return null;
  const h = m[1].toLowerCase();
  return '#' + (h.length === 3 ? [...h].map((c) => c + c).join('') : h);
}

const areaCache = new WeakMap<Layer, number>();

/** Área líquida da camada (furos descontados): o fundo é a de maior área. */
export function layerArea(layer: Layer): number {
  let a = areaCache.get(layer);
  if (a === undefined) {
    let s = 0;
    for (const p of layer.paths) {
      const f = flattenPath(p, 0.3);
      for (let i = 0; i < f.length; i++) { const q = f[(i + 1) % f.length]; s += f[i].x * q.y - q.x * f[i].y; }
    }
    a = Math.abs(s) / 2;
    areaCache.set(layer, a);
  }
  return a;
}

const lab = (hex: string): Lab => {
  const n = normalizeHex(hex) ?? '#000000';
  return rgbToLab(parseInt(n.slice(1, 3), 16), parseInt(n.slice(3, 5), 16), parseInt(n.slice(5, 7), 16));
};
export const deltaE = (a: string, b: string): number => Math.sqrt(dist2(lab(a), lab(b)));

export function paletteEntries(base: VDoc, edits: PaletteEdits = {}): PaletteEntry[] {
  return base.layers.map((l) => {
    const e = edits[l.color];
    return {
      original: l.color,
      color: e?.color ?? l.color,
      hidden: !!e?.hidden,
      edited: !!e && (e.color !== undefined && e.color !== l.color || !!e.hidden),
      paths: l.paths.length,
      nodes: l.paths.reduce((n, p) => n + p.segs.length, 0),
      area: layerArea(l),
      gradient: !!l.gradient && !(e?.color !== undefined && e.color !== l.color),
    };
  });
}

export function recount(doc: VDoc): VDoc['stats'] {
  let nodes = 0, paths = 0, lines = 0, arcs = 0, ellipses = 0, curves = 0;
  for (const l of doc.layers) for (const p of l.paths) {
    paths++;
    for (const s of p.segs as Seg[]) { nodes++; if (s.t === 'L') lines++; else if (s.t === 'A') arcs++; else if (s.t === 'E') ellipses++; else curves++; }
  }
  return { ...doc.stats, gradients: doc.layers.filter((l) => l.gradient).length, nodes, paths, colors: doc.layers.length, lines, arcs, ellipses, curves };
}

/**
 * Aplica as edições e devolve um NOVO documento (o original não é alterado):
 *  - camadas ocultas somem (e o documento passa a ter borda aberta → fendas recortadas pela união);
 *  - camadas que ficam com a MESMA cor são fundidas (em "recortes" os caminhos são concatenados; em
 *    "empilhado" a ordem das camadas é preservada, pois cada uma contém as seguintes).
 */
export function applyPaletteEdits(base: VDoc, edits: PaletteEdits = {}): VDoc {
  let hidden = false;
  const kept: Layer[] = [];
  for (const l of base.layers) {
    const e = edits[l.color];
    if (e?.hidden) { hidden = true; continue; }
    const color = normalizeHex(e?.color ?? l.color) ?? l.color;
    // gradiente: só some ao receber uma cor nova (vira sólido); sem edição de cor, é preservado
    if (l.gradient && !(e?.color !== undefined && e.color !== l.color)) kept.push({ ...l });
    else kept.push({ color, paths: l.paths });
  }
  let layers = kept;
  if (base.stacking === 'cutouts') {
    const by = new Map<string, Layer>();
    for (const l of kept) {
      if (l.gradient) { by.set(`${l.color}#g${by.size}`, l); continue; }
      const ex = by.get(l.color);
      if (ex) ex.paths = [...ex.paths, ...l.paths]; else by.set(l.color, { color: l.color, paths: [...l.paths] });
    }
    layers = [...by.values()];
  }
  const doc: VDoc = { ...base, layers, openBoundary: base.openBoundary || hidden };
  doc.stats = recount(doc);
  return doc;
}

export const hasEdits = (edits: PaletteEdits): boolean => Object.keys(edits).length > 0;

function setEdit(edits: PaletteEdits, original: string, patch: PaletteEdit): PaletteEdits {
  const cur = { ...edits[original], ...patch };
  if (cur.color === original) delete cur.color;
  if (!cur.hidden) delete cur.hidden;
  const out = { ...edits };
  if (Object.keys(cur).length) out[original] = cur; else delete out[original];
  return out;
}

export const setColor = (edits: PaletteEdits, original: string, color: string): PaletteEdits => {
  const n = normalizeHex(color);
  return n ? setEdit(edits, original, { color: n }) : edits;
};
export const setHidden = (edits: PaletteEdits, original: string, hidden: boolean): PaletteEdits => setEdit(edits, original, { hidden });
export const resetColor = (edits: PaletteEdits, original: string): PaletteEdits => {
  const out = { ...edits };
  delete out[original];
  return out;
};

/** Mescla as cores selecionadas numa só (padrão: a cor atual da primeira da lista). */
export function mergeColors(base: VDoc, edits: PaletteEdits, originals: string[], target?: string): PaletteEdits {
  const entries = paletteEntries(base, edits);
  const first = entries.find((e) => originals.includes(e.original));
  const to = normalizeHex(target ?? first?.color ?? '') ;
  if (!to) return edits;
  let out = edits;
  for (const o of originals) out = setEdit(out, o, { color: to, hidden: false });
  return out;
}

/**
 * Mescla cores semelhantes (ΔE CIE76 ≤ `threshold`, encadeadas): cada grupo adota a cor da camada de maior
 * área. Considera só camadas visíveis. Devolve as edições novas e quantas camadas foram mescladas.
 */
export function mergeSimilar(base: VDoc, edits: PaletteEdits, threshold: number): { edits: PaletteEdits; merged: number } {
  const gradColors = new Set(base.layers.filter((l) => l.gradient).map((l) => l.color));
  const entries = paletteEntries(base, edits).filter((e) => !e.hidden && !gradColors.has(e.original));
  const parent = entries.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < entries.length; i++) for (let j = i + 1; j < entries.length; j++) if (deltaE(entries[i].color, entries[j].color) <= threshold) parent[find(j)] = find(i);
  const groups = new Map<number, PaletteEntry[]>();
  entries.forEach((e, i) => groups.set(find(i), [...(groups.get(find(i)) ?? []), e]));
  let out = edits, merged = 0;
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const to = g.reduce((a, b) => (b.area > a.area ? b : a)).color;
    for (const e of g) if (e.color !== to) { out = setEdit(out, e.original, { color: to }); merged++; }
  }
  return { edits: out, merged };
}

/** Cor ORIGINAL da camada de fundo provável: a de maior área (em empilhado, a primeira). */
export function backgroundOriginal(base: VDoc): string | null {
  if (!base.layers.length) return null;
  if (base.stacking === 'stacked') return base.layers[0].color;
  return base.layers.reduce((a, b) => (layerArea(b) > layerArea(a) ? b : a)).color;
}

/** Em "empilhado" só a camada de baixo pode virar transparente sem revelar a de baixo dela. */
export function canHideWithoutReprocess(base: VDoc, original: string): boolean {
  return base.stacking !== 'stacked' || base.layers[0]?.color === original;
}

/** Cor mais representativa para `currentColor`: a maior área entre as escuras; senão a maior. */
export function suggestCurrentColor(doc: VDoc): string | undefined {
  if (!doc.layers.length) return undefined;
  const byArea = [...doc.layers].sort((a, b) => layerArea(b) - layerArea(a));
  return (byArea.find((l) => lab(l.color)[0] < 90) ?? byArea[0]).color;
}
