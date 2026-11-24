import { toCubicPath } from './geom';
import type { Pt, VPath } from './types';

/**
 * Edição de pontos (nós) de um contorno. O caminho vira uma lista CÍCLICA de nós com alças opcionais; a aresta
 * i → i+1 é reta se nenhum dos dois lados tem alça, senão Bézier cúbica. Arcos são convertidos em Béziers ao editar.
 */
export interface Node {
  p: Pt;
  hIn?: Pt; // alça de entrada (c2 da aresta anterior)
  hOut?: Pt; // alça de saída (c1 da aresta seguinte)
}

const eq = (a: Pt, b: Pt) => Math.hypot(a.x - b.x, a.y - b.y) < 0.01; // arcos convertidos fecham com erro numérico: não duplicar o nó
const add = (a: Pt, d: Pt): Pt => ({ x: a.x + d.x, y: a.y + d.y });
const sub = (a: Pt, b: Pt): Pt => ({ x: a.x - b.x, y: a.y - b.y });
const lerp = (a: Pt, b: Pt, t: number): Pt => ({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });

export function toNodes(path: VPath): Node[] {
  const c = toCubicPath(path);
  const nodes: Node[] = [{ p: c.start }];
  c.segs.forEach((s, j) => {
    const prev = nodes[nodes.length - 1];
    if (s.t === 'C') prev.hOut = s.c1;
    const last = j === c.segs.length - 1;
    if (last && eq(s.p, c.start)) { if (s.t === 'C') nodes[0].hIn = s.c2; return; } // fecha no início: não duplica o nó
    nodes.push(s.t === 'C' ? { p: s.p, hIn: s.c2 } : { p: s.p });
  });
  return nodes;
}

export function fromNodes(nodes: Node[], like?: VPath): VPath {
  const segs: VPath['segs'] = [];
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i], b = nodes[(i + 1) % nodes.length];
    if (a.hOut || b.hIn) segs.push({ t: 'C', c1: a.hOut ?? a.p, c2: b.hIn ?? b.p, p: b.p });
    else segs.push({ t: 'L', p: b.p });
  }
  const out: VPath = { start: nodes[0].p, segs };
  if (like?.sid !== undefined) out.sid = like.sid;
  if (like?.thin) out.thin = true;
  return out;
}

export function moveNode(nodes: Node[], i: number, to: Pt): Node[] {
  const d = sub(to, nodes[i].p);
  return nodes.map((n, k) => (k === i ? { p: to, hIn: n.hIn && add(n.hIn, d), hOut: n.hOut && add(n.hOut, d) } : n));
}

export function moveHandle(nodes: Node[], i: number, which: 'in' | 'out', to: Pt): Node[] {
  return nodes.map((n, k) => (k === i ? (which === 'in' ? { ...n, hIn: to } : { ...n, hOut: to }) : n));
}

/** remove o nó (mínimo de 3 nós: abaixo disso o contorno some — use excluir contorno) */
export function removeNode(nodes: Node[], i: number): Node[] {
  return nodes.length <= 3 ? nodes : nodes.filter((_, k) => k !== i);
}

function edgeCubic(a: Node, b: Node): [Pt, Pt, Pt, Pt] {
  return [a.p, a.hOut ?? a.p, b.hIn ?? b.p, b.p];
}

const cubicAt = (q: [Pt, Pt, Pt, Pt], t: number): Pt => {
  const u = 1 - t;
  return { x: u * u * u * q[0].x + 3 * u * u * t * q[1].x + 3 * u * t * t * q[2].x + t * t * t * q[3].x, y: u * u * u * q[0].y + 3 * u * u * t * q[1].y + 3 * u * t * t * q[2].y + t * t * t * q[3].y };
};

/** aresta mais próxima de `pt`: { edge: i (de i para i+1), t, dist } */
export function nearestOnPath(nodes: Node[], pt: Pt): { edge: number; t: number; dist: number } {
  let best = { edge: 0, t: 0, dist: Infinity };
  for (let i = 0; i < nodes.length; i++) {
    const q = edgeCubic(nodes[i], nodes[(i + 1) % nodes.length]);
    const N = 40;
    for (let k = 0; k <= N; k++) {
      const t = k / N, p = cubicAt(q, t), d = Math.hypot(p.x - pt.x, p.y - pt.y);
      if (d < best.dist) best = { edge: i, t, dist: d };
    }
  }
  return best;
}

/** insere um nó na aresta `edge` no parâmetro `t` (de Casteljau: o contorno não muda de forma) */
export function insertNode(nodes: Node[], edge: number, t: number): Node[] {
  const n = nodes.length, a = nodes[edge], b = nodes[(edge + 1) % n];
  const t0 = Math.min(0.98, Math.max(0.02, t));
  let mid: Node;
  let na: Node = a, nb: Node = b;
  if (!a.hOut && !b.hIn) mid = { p: lerp(a.p, b.p, t0) };
  else {
    const [p0, p1, p2, p3] = edgeCubic(a, b);
    const q0 = lerp(p0, p1, t0), q1 = lerp(p1, p2, t0), q2 = lerp(p2, p3, t0);
    const r0 = lerp(q0, q1, t0), r1 = lerp(q1, q2, t0), m = lerp(r0, r1, t0);
    mid = { p: m, hIn: r0, hOut: r1 };
    na = { ...a, hOut: q0 };
    nb = { ...b, hIn: q2 };
  }
  const out = nodes.map((x, k) => (k === edge ? na : k === (edge + 1) % n ? nb : x));
  out.splice(edge + 1, 0, mid);
  return out;
}

/** alterna a aresta que sai do nó `i` entre reta e curva */
export function toggleEdge(nodes: Node[], i: number): Node[] {
  const n = nodes.length, a = nodes[i], b = nodes[(i + 1) % n];
  const curved = !!(a.hOut || b.hIn);
  return nodes.map((x, k) => {
    if (k === i) return curved ? { p: x.p, hIn: x.hIn } : { ...x, hOut: lerp(a.p, b.p, 1 / 3) };
    if (k === (i + 1) % n) return curved ? { p: x.p, hOut: x.hOut } : { ...x, hIn: lerp(b.p, a.p, 1 / 3) };
    return x;
  });
}
