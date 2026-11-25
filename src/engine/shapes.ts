import { deltaE, recount } from './palette';
import { flattenPath } from './geom';
import { retarget, shiftGradient } from './gradedit';
import { booleanOp, splitByLine, unionShapes } from './union';
import type { Gradient, Layer, Pt, VDoc, VPath } from './types';

/**
 * Formas: a unidade de seleção e edição. Uma forma = contorno externo + seus furos (os caminhos com o mesmo `sid`).
 * As edições são aplicadas sobre o vetor gerado (como a paleta), sem reprocessar a imagem.
 */
export interface Shape {
  id: number;
  layer: number; // índice da camada (ordem de desenho: fundo → frente)
  color: string;
  gradient?: Gradient;
  paths: VPath[];
  area: number; // px² líquidos (furos descontados)
  nodes: number;
  bbox: [number, number, number, number];
}

export interface ShapeEdit {
  hidden?: boolean; // excluída (some; em "Recortes" fica transparente, em "Empilhado" aparece o que está atrás)
  color?: string; // nova cor sólida (#rrggbb): substitui cor/gradiente
  gradient?: Gradient; // gradiente definido/ajustado à mão (substitui cor/gradiente detectado)
  geom?: VPath[]; // contornos editados à mão (substituem os da forma; não sobrevivem a reprocessar)
  z?: number; // posição de desenho (camadas), no espaço de índices do vetor base; ausente = ordem natural
  dx?: number; // deslocamento (mover): aplicado à geometria e ao gradiente
  dy?: number;
  add?: { paths: VPath[]; like: number }; // forma NOVA (dividir/duplicar): entra logo depois da camada da forma `like`
  op?: 'union' | 'subtract' | 'intersect'; // como `geom` foi obtida a partir das formas absorvidas
  absorbed?: number; // foi fundida na forma de destino (id): some, e o destino guarda a união como `geom`
  /** âncora para reaplicar a edição depois de reprocessar: um ponto dentro da forma e sua área */
  at?: [number, number];
  area?: number;
}
export type ShapeEdits = Record<number, ShapeEdit>;

const polyCache = new WeakMap<VPath, Pt[]>();
const poly = (p: VPath): Pt[] => {
  let f = polyCache.get(p);
  if (!f) polyCache.set(p, (f = flattenPath(p, 0.3)));
  return f;
};

/** número de enrolamento (regra ≠ 0, como o SVG) do conjunto de caminhos no ponto */
function winding(paths: VPath[], x: number, y: number): number {
  let w = 0;
  for (const p of paths) {
    const f = poly(p);
    for (let i = 0, n = f.length; i < n; i++) {
      const a = f[i], b = f[(i + 1) % n];
      if (a.y <= y) { if (b.y > y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) > 0) w++; }
      else if (b.y <= y && (b.x - a.x) * (y - a.y) - (x - a.x) * (b.y - a.y) < 0) w--;
    }
  }
  return w;
}

function measure(paths: VPath[]): { area: number; nodes: number; bbox: Shape['bbox'] } {
  let s = 0, nodes = 0, x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of paths) {
    nodes += p.segs.length;
    const f = poly(p);
    for (let i = 0; i < f.length; i++) {
      const q = f[(i + 1) % f.length];
      s += f[i].x * q.y - q.x * f[i].y;
      if (f[i].x < x0) x0 = f[i].x; if (f[i].x > x1) x1 = f[i].x; if (f[i].y < y0) y0 = f[i].y; if (f[i].y > y1) y1 = f[i].y;
    }
  }
  return { area: Math.abs(s) / 2, nodes, bbox: [x0, y0, x1, y1] };
}

/** Formas do documento, na ordem de desenho. Caminhos sem `sid` (vetor antigo) viram formas individuais de id negativo. */
export function listShapes(doc: VDoc): Shape[] {
  const order: number[] = [];
  const acc = new Map<number, { layer: number; paths: VPath[] }>();
  let neg = -1;
  doc.layers.forEach((layer, li) => {
    for (const p of layer.paths) {
      const id = p.sid ?? neg--;
      let e = acc.get(id);
      if (!e) { acc.set(id, (e = { layer: li, paths: [] })); order.push(id); }
      e.paths.push(p); // formas fundidas podem ter caminhos em mais de uma camada
    }
  });
  return order.map((id) => {
    const e = acc.get(id)!, layer = doc.layers[e.layer];
    return { id, layer: e.layer, color: layer.color, gradient: layer.gradient, paths: e.paths, ...measure(e.paths) };
  });
}

/** ids das formas que contêm o ponto, da mais à frente para a mais ao fundo */
export function shapesAt(doc: VDoc, x: number, y: number): number[] {
  const all = new Map<number, VPath[]>(), lastLayer = new Map<number, number>();
  doc.layers.forEach((layer, li) => {
    for (const p of layer.paths) {
      const id = p.sid ?? -1 - li * 100000 - all.size;
      all.set(id, [...(all.get(id) ?? []), p]);
      lastLayer.set(id, li);
    }
  });
  // da mais à frente (última camada) para a mais ao fundo
  return [...all].filter(([, paths]) => winding(paths, x, y) !== 0).map(([id]) => id).sort((a, b) => (lastLayer.get(b) ?? 0) - (lastLayer.get(a) ?? 0));
}

/** formas cuja caixa fica toda dentro (ou, com `touch`, cruza) do retângulo */
export function shapesInRect(doc: VDoc, r: [number, number, number, number], touch = false): number[] {
  const [rx0, ry0, rx1, ry1] = [Math.min(r[0], r[2]), Math.min(r[1], r[3]), Math.max(r[0], r[2]), Math.max(r[1], r[3])];
  return listShapes(doc).filter((s) => {
    const [x0, y0, x1, y1] = s.bbox;
    return touch ? x1 >= rx0 && x0 <= rx1 && y1 >= ry0 && y0 <= ry1 : x0 >= rx0 && x1 <= rx1 && y0 >= ry0 && y1 <= ry1;
  }).map((s) => s.id);
}

/** formas de cor sólida semelhante (ΔE76 ≤ tol) à da forma `id` */
export function similarShapes(doc: VDoc, id: number, tol = 6): number[] {
  const all = listShapes(doc), me = all.find((s) => s.id === id);
  if (!me) return [];
  return all.filter((s) => s.id === id || (!s.gradient && !me.gradient && deltaE(s.color, me.color) <= tol)).map((s) => s.id);
}

/** um ponto garantidamente dentro da forma (âncora para reaplicar edições) */
export function interiorPoint(paths: VPath[]): [number, number] {
  const { bbox } = measure(paths);
  const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
  const cand: [number, number][] = [[cx, cy]];
  for (let i = 1; i <= 9; i++) for (let j = 1; j <= 9; j++) cand.push([bbox[0] + ((bbox[2] - bbox[0]) * i) / 10, bbox[1] + ((bbox[3] - bbox[1]) * j) / 10]);
  cand.sort((a, b) => Math.hypot(a[0] - cx, a[1] - cy) - Math.hypot(b[0] - cx, b[1] - cy));
  for (const c of cand) if (winding(paths, c[0], c[1]) !== 0) return c;
  // formas finas: ponto médio entre dois vértices do contorno
  const f = poly(paths[0]);
  for (let k = 0; k < f.length; k++) {
    const a = f[k], b = f[(k + Math.max(1, Math.floor(f.length / 2))) % f.length];
    const m: [number, number] = [(a.x + b.x) / 2, (a.y + b.y) / 2];
    if (winding(paths, m[0], m[1]) !== 0) return m;
  }
  return [paths[0].start.x, paths[0].start.y];
}

/** cor média das paradas (para a cor representativa de uma camada com gradiente) */
export function meanStops(g: Gradient): string {
  const c = [0, 0, 0];
  for (const s of g.stops) for (let k = 0; k < 3; k++) c[k] += parseInt(s.color.slice(1 + 2 * k, 3 + 2 * k), 16);
  return '#' + c.map((v) => Math.round(v / g.stops.length).toString(16).padStart(2, '0')).join('');
}

export const hasShapeEdits = (e: ShapeEdits): boolean => Object.keys(e).length > 0;

export function translatePath(p: VPath, dx: number, dy: number): VPath {
  const m = (q: Pt): Pt => ({ x: q.x + dx, y: q.y + dy });
  const out: VPath = { start: m(p.start), segs: p.segs.map((g) => (g.t === 'C' ? { ...g, c1: m(g.c1), c2: m(g.c2), p: m(g.p) } : { ...g, p: m(g.p) })) };
  if (p.sid !== undefined) out.sid = p.sid;
  if (p.thin) out.thin = true;
  return out;
}

/** Vetor base com as formas NOVAS (dividir/duplicar) já inseridas, cada uma numa camada própria logo depois da camada da forma `like`. */
export function injectAdded(doc: VDoc, edits: ShapeEdits): VDoc {
  const adds = Object.entries(edits).filter(([, e]) => e.add).map(([k, e]) => [Number(k), e.add!] as const).sort((a, b) => a[0] - b[0]);
  if (!adds.length) return doc;
  const layers = [...doc.layers];
  for (const [id, a] of adds) {
    let li = layers.findIndex((l) => l.paths.some((p) => p.sid === a.like));
    if (li < 0) li = layers.length - 1;
    layers.splice(li + 1, 0, { ...layers[li], paths: a.paths.map((p) => ({ ...p, sid: id })), fallback: undefined });
  }
  return { ...doc, layers };
}

const nextId = (edits: ShapeEdits) => Math.max(1_000_000, ...Object.keys(edits).map((k) => Number(k) + 1));
const emptyEdit = (c: ShapeEdit) => !c.hidden && c.color === undefined && c.absorbed === undefined && !c.gradient && !c.geom && c.z === undefined && !c.add && !c.dx && !c.dy;

/** Acrescenta âncora/área a uma edição (necessário para sobreviver a um reprocessamento). */
export function withAnchor(doc: VDoc, id: number, e: ShapeEdit): ShapeEdit {
  const s = listShapes(doc).find((x) => x.id === id);
  return s ? { ...e, at: interiorPoint(s.paths), area: s.area } : e;
}

export function editShapes(doc: VDoc, edits: ShapeEdits, ids: number[], patch: ShapeEdit | null): ShapeEdits {
  let out = { ...edits };
  const all = new Map(listShapes(injectAdded(doc, edits)).map((s) => [s.id, s]));
  for (const id of ids) {
    const s = all.get(id);
    if (!s) continue;
    if (patch === null) { delete out[id]; continue; }
    if (patch.geom !== undefined) { out = setShapeGeom(doc, out, id, patch.geom, undefined); continue; }
    const prev = out[id] ?? {};
    const cur: ShapeEdit = { ...prev, ...patch };
    // o gradiente chega no espaço EXIBIDO (já com o deslocamento); é guardado no espaço base
    if (patch.gradient !== undefined) cur.gradient = shiftGradient(patch.gradient, -(prev.dx ?? 0), -(prev.dy ?? 0));
    if (patch.color !== undefined) delete cur.gradient;
    if (patch.gradient !== undefined) delete cur.color;
    if (!cur.hidden) delete cur.hidden;
    if (emptyEdit(cur)) { delete out[id]; continue; }
    out[id] = { ...cur, at: interiorPoint(s.paths), area: s.area };
  }
  return out;
}

/**
 * Define os contornos da forma (no espaço EXIBIDO): o deslocamento atual é incorporado à geometria (dx = dy = 0) e o
 * gradiente exibido passa a ser explícito para não "andar" junto.
 */
export function setShapeGeom(base: VDoc, edits: ShapeEdits, id: number, geom: VPath[], displayGradient?: Gradient): ShapeEdits {
  const prev = edits[id] ?? {};
  const dx = prev.dx ?? 0, dy = prev.dy ?? 0;
  const s = listShapes(injectAdded(base, edits)).find((x) => x.id === id);
  const cur: ShapeEdit = { ...prev, geom: geom.map((g) => ({ ...g, sid: id })) };
  delete cur.dx; delete cur.dy;
  if (displayGradient) { cur.gradient = displayGradient; delete cur.color; } else if (prev.gradient && (dx || dy)) cur.gradient = shiftGradient(prev.gradient, dx, dy);
  return { ...edits, [id]: s ? { ...cur, at: interiorPoint(s.paths), area: s.area } : cur };
}

/** Move as formas: soma (dx, dy) ao deslocamento atual de cada uma. */
export function translateShapes(base: VDoc, edits: ShapeEdits, ids: number[], dx: number, dy: number): ShapeEdits {
  let out = edits;
  for (const id of ids) out = editShapes(base, out, [id], { dx: (out[id]?.dx ?? 0) + dx, dy: (out[id]?.dy ?? 0) + dy });
  return out;
}

/**
 * Aplica as edições e devolve um NOVO documento. Formas recoloridas/fundidas saem para camadas próprias na mesma
 * posição da ordem de desenho (o empilhamento é preservado); camadas de gradiente editadas perdem as bandas de
 * reserva (PDF/EPS/DXF usam a cor média nelas).
 */
export function applyShapeEdits(doc: VDoc, edits: ShapeEdits): VDoc {
  if (!hasShapeEdits(edits)) return doc;
  doc = injectAdded(doc, edits);
  const byId = new Map(listShapes(doc).map((s) => [s.id, s]));
  let hidden = false;
  const emitted = new Set<number>();
  const layers: Layer[] = [];
  doc.layers.forEach((layer) => {
    const keep: VPath[] = [];
    const groups = new Map<string, Layer>();
    let changed = false;
    for (const src of layer.paths) {
      if (src.sid === undefined) { keep.push(src); continue; }
      const e = edits[src.sid];
      if (e?.absorbed !== undefined && byId.has(e.absorbed)) { changed = true; continue; } // fundida: a união está no destino
      if (!e) { keep.push(src); continue; }
      // contornos editados à mão (ou a união de formas fundidas) substituem TODOS os da forma, emitidos uma só vez
      let pathsOut: VPath[] = [src];
      if (e.geom) { if (emitted.has(src.sid)) continue; emitted.add(src.sid); pathsOut = e.geom.map((g) => ({ ...g, sid: src.sid })); }
      const mv: [number, number] | null = e.dx || e.dy ? [e.dx ?? 0, e.dy ?? 0] : null;
      for (const p0 of pathsOut) {
        const p = mv ? translatePath(p0, mv[0], mv[1]) : p0;
        if (e.hidden) { changed = true; hidden = true; continue; }
        let paint: { color: string; gradient?: Gradient } | null = null;
        if (e.gradient) paint = { color: e.color ?? meanStops(e.gradient), gradient: mv ? shiftGradient(e.gradient, mv[0], mv[1]) : e.gradient };
        else if (e.color) paint = { color: e.color };
        else if (mv && layer.gradient) paint = { color: layer.color, gradient: shiftGradient(layer.gradient, mv[0], mv[1]) };
        if (!paint) { if (e.geom || mv) changed = true; keep.push(p); continue; }
        changed = true;
        const key = paint.gradient ? `g${src.sid}` : paint.color;
        let g = groups.get(key);
        if (!g) groups.set(key, (g = paint.gradient ? { color: paint.color, paths: [], gradient: paint.gradient } : { color: paint.color, paths: [] }));
        g.paths.push(p);
      }
    }
    if (!changed) { layers.push(layer); return; }
    if (keep.length) layers.push({ ...layer, paths: keep, fallback: undefined });
    layers.push(...groups.values());
  });
  const baseIdx = new Map([...byId.keys()].map((id, i) => [id, i]));
  const reordered = Object.values(edits).some((e) => e.z !== undefined);
  const out: VDoc = { ...doc, layers: reordered ? reorderLayers(layers, edits, baseIdx) : layers, openBoundary: doc.openBoundary || (hidden && doc.stacking === 'cutouts') };
  if (reordered) out.ordered = true;
  out.stats = { ...recount(out), shapes: new Set(out.layers.flatMap((l) => l.paths.map((p) => p.sid))).size };
  return out;
}

/** Reordena as formas pelas posições `z` (camadas), reagrupando formas consecutivas da mesma camada de origem. */
function reorderLayers(layers: Layer[], edits: ShapeEdits, baseIdx: Map<number, number>): Layer[] {
  interface Entry { key: number; pos: number; src: Layer; paths: VPath[] }
  const entries: Entry[] = [];
  let pos = 0;
  for (const L of layers) {
    const by = new Map<number, Entry>();
    for (const p of L.paths) {
      const k = p.sid ?? -1 - pos;
      let e = by.get(k);
      if (!e) { e = { key: p.sid !== undefined && baseIdx.has(p.sid) ? (edits[p.sid]?.z ?? baseIdx.get(p.sid)!) : pos, pos: pos++, src: L, paths: [] }; by.set(k, e); entries.push(e); }
      e.paths.push(p);
    }
  }
  entries.sort((a, b) => a.key - b.key || a.pos - b.pos);
  const out: Layer[] = [];
  let last: Entry | null = null;
  for (const e of entries) {
    if (last && last.src === e.src) out[out.length - 1].paths.push(...e.paths);
    else out.push({ ...e.src, paths: [...e.paths] });
    last = e;
  }
  for (const l of out) if (l.fallback && l.paths.length !== layers.find((x) => x.fallback === l.fallback)!.paths.length) l.fallback = undefined; // bandas só valem para a camada inteira
  return out;
}

/** fusões anteriores que apontavam para alguma das formas `froms` passam a apontar para `to` */
function repoint(edits: ShapeEdits, froms: number[], to: number): void {
  for (const [k, e] of Object.entries(edits)) if (e.absorbed !== undefined && froms.includes(e.absorbed) && e.absorbed !== to) edits[Number(k)] = { ...e, absorbed: to };
}

/** âncora (ponto interior + área) da forma NO VETOR BASE, para reaplicar a edição depois de reprocessar */
function anchorOf(base: VDoc, edits: ShapeEdits, id: number): ShapeEdit {
  const b = listShapes(injectAdded(base, edits)).find((s) => s.id === id);
  return b ? { at: interiorPoint(b.paths), area: b.area } : {};
}

/**
 * Funde as formas `ids` (do vetor exibido) numa só: a maior é o destino e recebe a UNIÃO geométrica dos contornos
 * (um contorno único, sem costuras); as outras somem. Mantém a tinta do destino.
 */
export function mergeShapes(base: VDoc, doc: VDoc, edits: ShapeEdits, ids: number[]): ShapeEdits {
  const sel = listShapes(doc).filter((s) => ids.includes(s.id));
  if (sel.length < 2) return edits;
  const main = sel.reduce((a, c) => (c.area > a.area ? c : a));
  let out: ShapeEdits = { ...edits };
  repoint(out, sel.map((s) => s.id), main.id);
  for (const s of sel) if (s.id !== main.id) out[s.id] = { absorbed: main.id, ...anchorOf(base, out, s.id) };
  out = setShapeGeom(base, out, main.id, unionShapes(sel.map((s) => s.paths)), main.gradient);
  out[main.id] = { ...out[main.id], op: 'union' };
  return out;
}

/**
 * Recorta uma forma com outras: `subtract` tira da forma de TRÁS a parte coberta pelas da frente; `intersect` mantém só
 * a sobreposição. As formas da frente são consumidas. Devolve as edições e se o resultado ficou vazio.
 */
export function combineShapes(base: VDoc, doc: VDoc, edits: ShapeEdits, ids: number[], op: 'subtract' | 'intersect'): { edits: ShapeEdits; empty: boolean; target: number } | null {
  const order = effectiveOrder(base, edits);
  const sel = listShapes(doc).filter((s) => ids.includes(s.id)).sort((a, b) => order.indexOf(a.id) - order.indexOf(b.id));
  if (sel.length < 2) return null;
  const back = sel[0], fronts = sel.slice(1);
  const geom = booleanOp(back.paths, fronts.map((f) => f.paths), op);
  let out: ShapeEdits = { ...edits };
  repoint(out, fronts.map((f) => f.id), back.id);
  for (const f of fronts) out[f.id] = { absorbed: back.id, ...anchorOf(base, out, f.id) };
  if (!geom.length) { out[back.id] = { ...out[back.id], hidden: true, ...anchorOf(base, out, back.id) }; return { edits: out, empty: true, target: back.id }; }
  out = setShapeGeom(base, out, back.id, geom, back.gradient);
  out[back.id] = { ...out[back.id], op };
  return { edits: out, empty: false, target: back.id };
}

/** Insere uma forma nova (dividir/duplicar) logo à frente de `like` na ordem de desenho. */
function addShape(base: VDoc, edits: ShapeEdits, paths: VPath[], like: number, patch: ShapeEdit): { edits: ShapeEdits; id: number } {
  const before = effectiveOrder(base, edits);
  const id = nextId(edits);
  const out: ShapeEdits = { ...edits, [id]: { add: { paths: paths.map((p) => ({ ...p, sid: id })), like }, ...patch } };
  const order = [...before];
  const at = order.indexOf(like);
  order.splice(at >= 0 ? at + 1 : order.length, 0, id);
  return { edits: writeOrder(base, out, order), id };
}

/**
 * Faca: divide cada forma de `ids` pela reta que passa por p0 e p1. A metade esquerda fica com a forma original; a
 * direita vira uma forma NOVA (mesma tinta), logo à frente dela. Devolve também os ids de todas as metades.
 */
export function splitShapes(base: VDoc, doc: VDoc, edits: ShapeEdits, ids: number[], p0: Pt, p1: Pt): { edits: ShapeEdits; ids: number[] } {
  const all = new Map(listShapes(doc).map((s) => [s.id, s]));
  let out = edits;
  const made: number[] = [];
  for (const id of ids) {
    const s = all.get(id);
    const r = s && splitByLine(s.paths, p0, p1);
    if (!s || !r) continue;
    out = setShapeGeom(base, out, id, r[0], s.gradient);
    const ad = addShape(base, out, r[1], id, s.gradient ? { gradient: s.gradient } : { color: s.color });
    out = ad.edits;
    made.push(id, ad.id);
  }
  return { edits: out, ids: made };
}

/** Duplica as formas (cópia deslocada de `offset` px, logo à frente da original). */
export function duplicateShapes(base: VDoc, doc: VDoc, edits: ShapeEdits, ids: number[], offset = 12): { edits: ShapeEdits; ids: number[] } {
  const all = new Map(listShapes(doc).map((s) => [s.id, s]));
  let out = edits;
  const made: number[] = [];
  for (const id of ids) {
    const s = all.get(id);
    if (!s) continue;
    const ad = addShape(base, out, s.paths, id, { dx: offset, dy: offset, ...(s.gradient ? { gradient: s.gradient } : { color: s.color }) });
    out = ad.edits;
    made.push(ad.id);
  }
  return { edits: out, ids: made };
}

/**
 * Reaplica as edições (feitas sobre um vetor antigo) a um vetor reprocessado, pelas âncoras: a forma nova é a que
 * contém o ponto e tem a área mais próxima da antiga (razão entre 0,5× e 2×). Edições sem correspondência caem.
 */
export function remapShapeEdits(newDoc: VDoc, edits: ShapeEdits): { edits: ShapeEdits; dropped: number; orderLost: boolean } {
  const shapes = listShapes(newDoc);
  const map = new Map<number, number>();
  for (const [k, e] of Object.entries(edits)) {
    if (!e.at || !e.area) continue;
    const ids = new Set(shapesAt(newDoc, e.at[0], e.at[1]));
    let best = -1, bd = Infinity;
    for (const s of shapes) {
      if (!ids.has(s.id)) continue;
      const r = Math.abs(Math.log(Math.max(1, s.area) / Math.max(1, e.area)));
      if (r < bd) { bd = r; best = s.id; }
    }
    if (best >= 0 && bd <= Math.log(2)) map.set(Number(k), best);
  }
  // só a UNIÃO é recalculável sobre formas novas; recortes (subtrair/interseção) e formas novas (dividir/duplicar) não
  const targets = new Set(Object.values(edits).filter((e) => e.absorbed !== undefined && (edits[e.absorbed]?.op ?? 'union') === 'union').map((e) => e.absorbed!));
  const out: ShapeEdits = {};
  let dropped = 0, orderLost = false;
  for (const [k, e0] of Object.entries(edits)) {
    const e = { ...e0 };
    if (e.add) { dropped++; continue; }
    if (e.absorbed !== undefined && !targets.has(e.absorbed)) { dropped++; continue; }
    if (e.z !== undefined) { orderLost = true; delete e.z; } // a ordem de camadas é por posição: não é remapeável
    if (!e.hidden && e.color === undefined && e.absorbed === undefined && !e.gradient && !e.geom && !e.at && !e.dx && !e.dy) continue; // só tinha ordem
    const nid = map.get(Number(k));
    if (nid === undefined) { dropped++; continue; }
    const s = shapes.find((x) => x.id === nid)!;
    const next: ShapeEdit = { ...e, at: interiorPoint(s.paths), area: s.area };
    if (e.absorbed !== undefined) { const t = map.get(e.absorbed); if (t === undefined) { dropped++; continue; } next.absorbed = t; }
    if (next.geom && !targets.has(Number(k))) { delete next.geom; dropped++; if (!next.hidden && next.color === undefined && next.absorbed === undefined && !next.gradient && !next.dx && !next.dy) continue; } // geometria à mão não é remapeável
    out[nid] = next;
  }
  // fusões: a união é recalculada sobre as formas novas (sobrevive a reprocessar)
  const byTarget = new Map<number, number[]>();
  for (const [k, e] of Object.entries(out)) if (e.absorbed !== undefined) byTarget.set(e.absorbed, [...(byTarget.get(e.absorbed) ?? []), Number(k)]);
  for (const [t, srcs] of byTarget) {
    const parts = [t, ...srcs].map((id) => shapes.find((x) => x.id === id)).filter((x): x is Shape => !!x);
    out[t] = { ...out[t], geom: unionShapes(parts.map((x) => x.paths)).map((p) => ({ ...p, sid: t })) };
  }
  return { edits: out, dropped, orderLost };
}

/**
 * Copia a tinta (cor sólida ou gradiente, reescalado para a caixa de cada destino) da forma `sourceId` para as
 * formas `targetIds`. Usa o vetor exibido: copia exatamente o que se vê.
 */
export function copyPaint(base: VDoc, doc: VDoc, edits: ShapeEdits, sourceId: number, targetIds: number[]): ShapeEdits {
  const all = new Map(listShapes(doc).map((s) => [s.id, s]));
  const src = all.get(sourceId);
  if (!src) return edits;
  let out = edits;
  for (const id of targetIds) {
    const t = all.get(id);
    if (!t || id === sourceId) continue;
    out = editShapes(base, out, [id], src.gradient ? { gradient: retarget(src.gradient, src.bbox, t.bbox) } : { color: src.color });
  }
  return out;
}

/** Documento de "mapa de formas": cada forma com uma cor sólida distinta (para ver e escolher a segmentação). */
export function shapeMapDoc(doc: VDoc): VDoc {
  const layers: Layer[] = [];
  listShapes(doc).forEach((s, i) => {
    const hue = Math.round((i * 137.508) % 360), l = 48 + ((i * 7) % 18);
    layers.push({ color: hslHex(hue, 62, l), paths: s.paths });
  });
  return { ...doc, layers, openBoundary: false };
}

function hslHex(h: number, s: number, l: number): string {
  s /= 100; l /= 100;
  const k = (n: number) => (n + h / 30) % 12, a = s * Math.min(l, 1 - l);
  const f = (n: number) => Math.round(255 * (l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)))));
  return '#' + [f(0), f(8), f(4)].map((v) => v.toString(16).padStart(2, '0')).join('');
}

/** Ordem de desenho efetiva (fundo → frente) de TODAS as formas do vetor base, inclusive ocultas/fundidas. */
export function effectiveOrder(base: VDoc, edits: ShapeEdits): number[] {
  const ids = listShapes(injectAdded(base, edits)).map((s) => s.id);
  return ids.map((id, i) => ({ id, i, k: edits[id]?.z ?? i })).sort((a, b) => a.k - b.k || a.i - b.i).map((x) => x.id);
}

export type ReorderOp = 'front' | 'back' | 'forward' | 'backward' | { inFrontOf: number } | { behind: number };

/**
 * Muda a ordem de desenho das formas `ids`: para a frente/fundo, um passo (pulando as formas invisíveis) ou logo
 * à frente/atrás de outra (arrastar e soltar). Devolve as edições com as posições `z` das formas deslocadas.
 */
export function reorderShapes(base: VDoc, doc: VDoc, edits: ShapeEdits, ids: number[], op: ReorderOp): ShapeEdits {
  const order = effectiveOrder(base, edits);
  const sel = new Set(ids.filter((i) => order.includes(i)));
  if (!sel.size) return edits;
  const visible = new Set(listShapes(doc).map((s) => s.id));
  let a = [...order];
  const move = (from: number, to: number) => { const [x] = a.splice(from, 1); a.splice(to, 0, x); };
  if (op === 'front') a = [...a.filter((x) => !sel.has(x)), ...a.filter((x) => sel.has(x))];
  else if (op === 'back') a = [...a.filter((x) => sel.has(x)), ...a.filter((x) => !sel.has(x))];
  else if (op === 'forward') {
    for (let i = a.length - 1; i >= 0; i--) {
      if (!sel.has(a[i])) continue;
      let j = i + 1;
      while (j < a.length && !(visible.has(a[j]) && !sel.has(a[j]))) j++;
      if (j < a.length) move(i, j);
    }
  } else if (op === 'backward') {
    for (let i = 0; i < a.length; i++) {
      if (!sel.has(a[i])) continue;
      let j = i - 1;
      while (j >= 0 && !(visible.has(a[j]) && !sel.has(a[j]))) j--;
      if (j >= 0) { move(i, j); }
    }
  } else {
    const t = 'inFrontOf' in op ? op.inFrontOf : op.behind;
    if (sel.has(t)) return edits;
    const rest = a.filter((x) => !sel.has(x)), moved = a.filter((x) => sel.has(x));
    const at = rest.indexOf(t) + ('inFrontOf' in op ? 1 : 0);
    a = [...rest.slice(0, at), ...moved, ...rest.slice(at)];
  }
  return writeOrder(base, edits, a);
}

/** Grava a ordem de desenho `order`: só as formas fora da posição natural recebem `z`. */
function writeOrder(base: VDoc, edits: ShapeEdits, order: number[]): ShapeEdits {
  const natural = listShapes(injectAdded(base, edits)).map((s) => s.id);
  const out: ShapeEdits = { ...edits };
  order.forEach((id, idx) => {
    const cur = { ...out[id] };
    if (idx === natural.indexOf(id)) delete cur.z; else cur.z = idx;
    if (Object.keys(cur).length) out[id] = cur; else delete out[id];
  });
  return out;
}
