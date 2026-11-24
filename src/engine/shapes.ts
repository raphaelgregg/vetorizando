import { deltaE, recount } from './palette';
import { flattenPath } from './geom';
import { retarget } from './gradedit';
import { unionShapes } from './union';
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

/** Acrescenta âncora/área a uma edição (necessário para sobreviver a um reprocessamento). */
export function withAnchor(doc: VDoc, id: number, e: ShapeEdit): ShapeEdit {
  const s = listShapes(doc).find((x) => x.id === id);
  return s ? { ...e, at: interiorPoint(s.paths), area: s.area } : e;
}

export function editShapes(doc: VDoc, edits: ShapeEdits, ids: number[], patch: ShapeEdit | null): ShapeEdits {
  const out = { ...edits };
  const all = new Map(listShapes(doc).map((s) => [s.id, s]));
  for (const id of ids) {
    const s = all.get(id);
    if (!s) continue;
    if (patch === null) { delete out[id]; continue; }
    const cur = { ...out[id], ...patch };
    if (patch.color !== undefined) delete cur.gradient;
    if (patch.gradient !== undefined) delete cur.color;
    if (!cur.hidden) delete cur.hidden;
    if (!cur.hidden && cur.color === undefined && cur.absorbed === undefined && !cur.gradient && !cur.geom) { delete out[id]; continue; }
    out[id] = { ...cur, at: interiorPoint(s.paths), area: s.area };
  }
  return out;
}

/**
 * Aplica as edições e devolve um NOVO documento. Formas recoloridas/fundidas saem para camadas próprias na mesma
 * posição da ordem de desenho (o empilhamento é preservado); camadas de gradiente editadas perdem as bandas de
 * reserva (PDF/EPS/DXF usam a cor média nelas).
 */
export function applyShapeEdits(doc: VDoc, edits: ShapeEdits): VDoc {
  if (!hasShapeEdits(edits)) return doc;
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
      for (const p of pathsOut) {
        if (e.hidden) { changed = true; hidden = true; continue; }
        const paint: { color: string; gradient?: Gradient } | null = e.gradient ? { color: e.color ?? meanStops(e.gradient), gradient: e.gradient } : e.color ? { color: e.color } : null;
        if (!paint) { if (e.geom) changed = true; keep.push(p); continue; }
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
  const out: VDoc = { ...doc, layers, openBoundary: doc.openBoundary || (hidden && doc.stacking === 'cutouts') };
  out.stats = { ...recount(out), shapes: new Set(layers.flatMap((l) => l.paths.map((p) => p.sid))).size };
  return out;
}

/**
 * Funde as formas `ids` (do vetor exibido) numa só: a maior é o destino e recebe a UNIÃO geométrica dos contornos
 * (um contorno único, sem costuras); as outras somem. Mantém a tinta do destino.
 */
export function mergeShapes(base: VDoc, doc: VDoc, edits: ShapeEdits, ids: number[]): ShapeEdits {
  const sel = listShapes(doc).filter((s) => ids.includes(s.id));
  if (sel.length < 2) return edits;
  const main = sel.reduce((a, c) => (c.area > a.area ? c : a));
  const baseShapes = new Map(listShapes(base).map((s) => [s.id, s]));
  const anchor = (id: number): ShapeEdit => { const b = baseShapes.get(id); return b ? { at: interiorPoint(b.paths), area: b.area } : {}; };
  const out: ShapeEdits = { ...edits };
  for (const [k, e] of Object.entries(out)) if (e.absorbed !== undefined && e.absorbed !== main.id && sel.some((s) => s.id === e.absorbed)) out[Number(k)] = { ...e, absorbed: main.id }; // fusões anteriores passam ao novo destino
  for (const s of sel) if (s.id !== main.id) out[s.id] = { absorbed: main.id, ...anchor(s.id) };
  out[main.id] = { ...out[main.id], geom: unionShapes(sel.map((s) => s.paths)).map((p) => ({ ...p, sid: main.id })), ...anchor(main.id) };
  return out;
}

/**
 * Reaplica as edições (feitas sobre um vetor antigo) a um vetor reprocessado, pelas âncoras: a forma nova é a que
 * contém o ponto e tem a área mais próxima da antiga (razão entre 0,5× e 2×). Edições sem correspondência caem.
 */
export function remapShapeEdits(newDoc: VDoc, edits: ShapeEdits): { edits: ShapeEdits; dropped: number } {
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
  const targets = new Set(Object.values(edits).filter((e) => e.absorbed !== undefined).map((e) => e.absorbed!));
  const out: ShapeEdits = {};
  let dropped = 0;
  for (const [k, e] of Object.entries(edits)) {
    const nid = map.get(Number(k));
    if (nid === undefined) { dropped++; continue; }
    const s = shapes.find((x) => x.id === nid)!;
    const next: ShapeEdit = { ...e, at: interiorPoint(s.paths), area: s.area };
    if (e.absorbed !== undefined) { const t = map.get(e.absorbed); if (t === undefined) { dropped++; continue; } next.absorbed = t; }
    if (next.geom && !targets.has(Number(k))) { delete next.geom; dropped++; if (!next.hidden && next.color === undefined && next.absorbed === undefined && !next.gradient) continue; } // geometria à mão não é remapeável
    out[nid] = next;
  }
  // fusões: a união é recalculada sobre as formas novas (sobrevive a reprocessar)
  const byTarget = new Map<number, number[]>();
  for (const [k, e] of Object.entries(out)) if (e.absorbed !== undefined) byTarget.set(e.absorbed, [...(byTarget.get(e.absorbed) ?? []), Number(k)]);
  for (const [t, srcs] of byTarget) {
    const parts = [t, ...srcs].map((id) => shapes.find((x) => x.id === id)).filter((x): x is Shape => !!x);
    out[t] = { ...out[t], geom: unionShapes(parts.map((x) => x.paths)).map((p) => ({ ...p, sid: t })) };
  }
  return { edits: out, dropped };
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
