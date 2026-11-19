import type { Pt } from './types';

export function loopArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i].x * q.y - q.x * p[i].y;
  }
  return a / 2;
}

const RIDGE_MIN = 0.25; // tinta mínima para contar como linha (abaixo disso é ruído)
const PLATEAU_MIN = 0.4; // tinta mínima de cada pixel de um perfil de 2 px para ser tratado como linha
const RIDGE_SIDE = 0.15;
const RIDGE_ALONG = 0.2; // a tinta deve continuar ≥ isto nos dois vizinhos ao longo da linha // vizinhos transversais ≤ isto → crista isolada

type Edge = 'T' | 'R' | 'B' | 'L';
const MID: Record<Edge, [number, number]> = { T: [0.5, 0], R: [1, 0.5], B: [0.5, 1], L: [0, 0.5] };
const CORNER: [number, number][] = [[0, 0], [1, 0], [1, 1], [0, 1]]; // tl, tr, br, bl

/** Orienta o segmento a→b para que o "dentro" fique à direita (contorno externo em sentido horário). */
function orient(a: Edge, b: Edge, rep: number, repInside: boolean): [Edge, Edge] {
  const [ax, ay] = MID[a], [bx, by] = MID[b];
  const dx = bx - ax, dy = by - ay;
  const nx = -dy, ny = dx;
  const side = (CORNER[rep][0] - (ax + bx) / 2) * nx + (CORNER[rep][1] - (ay + by) / 2) * ny;
  return repInside === side > 0 ? [a, b] : [b, a];
}

/** Tabela marching squares: índice = bits(tl,tr,br,bl) + 16*centroDentro */
const TABLE: [Edge, Edge][][] = (() => {
  const t: [Edge, Edge][][] = [];
  for (let idx = 0; idx < 32; idx++) {
    const c = [idx & 1, (idx >> 1) & 1, (idx >> 2) & 1, (idx >> 3) & 1].map(Boolean);
    const centre = idx >= 16;
    const edges: Edge[] = [];
    if (c[0] !== c[1]) edges.push('T');
    if (c[1] !== c[2]) edges.push('R');
    if (c[3] !== c[2]) edges.push('B');
    if (c[0] !== c[3]) edges.push('L');
    const segs: [Edge, Edge][] = [];
    const inside = c.filter(Boolean).length;
    if (edges.length === 2) {
      let rep = c.findIndex((v) => v);
      if (inside === 1) rep = c.findIndex((v) => v);
      else if (inside === 3) rep = c.findIndex((v) => !v);
      segs.push(orient(edges[0], edges[1], rep, c[rep]));
    } else if (edges.length === 4) {
      // sela: centro dentro → separa cantos de fora; senão separa cantos de dentro
      for (let k = 0; k < 4; k++) {
        if (c[k] === centre) continue;
        const pair = (['TL', 'TR', 'RB', 'LB'] as const)[k];
        segs.push(orient(pair[0] as Edge, pair[1] as Edge, k, c[k]));
      }
    }
    t.push(segs);
  }
  return t;
})();

/**
 * Contornos subpixel de uma máscara binária: suaviza a máscara (gaussiana) e extrai a
 * isolinha 0.5 por marching squares. Elimina o serrilhado de degraus sem perder cantos
 * (a detecção de cantos acontece depois). Contornos externos = horário; furos = anti-horário.
 */
export function traceField(mask: Uint8Array, w: number, h: number, sigma: number, cover?: Map<number, number>): Pt[][] {
  let x0 = w, y0 = h, x1 = -1, y1 = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (mask[y * w + x]) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
    }
  }
  if (x1 < 0) return [];
  const R = sigma > 0 ? Math.max(1, Math.ceil(sigma * 2.5)) : 0;
  const pad = R + 2;
  const bx = x0 - pad, by = y0 - pad;
  const gw = x1 - x0 + 1 + 2 * pad, gh = y1 - y0 + 1 + 2 * pad;
  const src = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    const yy = Math.min(h - 1, Math.max(0, by + j));
    for (let i = 0; i < gw; i++) {
      const pi = yy * w + Math.min(w - 1, Math.max(0, bx + i));
      src[j * gw + i] = cover?.get(pi) ?? mask[pi];
    }
  }
  // crista de 1 pixel (máximo local estrito): a isolinha 0,5 de uma “tenda” de altura h tem largura 2(1−0,5/h),
  // subestimando a tinta (h); com h' = 0,5/(1−h/2) a largura vira exatamente h → conserva a espessura da linha fina
  if (cover) {
    const ridge: number[] = [];
    for (let j = 1; j < gh - 1; j++) {
      for (let i = 1; i < gw - 1; i++) {
        const q = j * gw + i, f = src[q];
        if (f < RIDGE_MIN || f >= 1) continue;
        // crista ISOLADA de uma LINHA: vizinhos transversais ≈ 0 e a tinta CONTINUA dos dois lados ao longo da linha.
        // Ponta de forma (um lado vazio) e ponto isolado (os dois vazios) não qualificam; ruído de foto também não.
        const lineX = src[q - 1] <= RIDGE_SIDE && src[q + 1] <= RIDGE_SIDE && src[q - gw] >= RIDGE_ALONG && src[q + gw] >= RIDGE_ALONG;
        const lineY = src[q - gw] <= RIDGE_SIDE && src[q + gw] <= RIDGE_SIDE && src[q - 1] >= RIDGE_ALONG && src[q + 1] >= RIDGE_ALONG;
        if (lineX || lineY) ridge.push(q);
      }
    }
    // perfil de 2 pixels isolado ([0, a, b, 0], ambos ≥ 0,3): um deles pode ficar logo abaixo de 0,5 (ex.: 0,4997 numa linha de
    // 1 px a cavalo entre duas fileiras) e a linha seria cortada; sobe para o limiar, o que dá largura ≥ 1 px
    const lift: number[] = [];
    for (let j = 2; j < gh - 2; j++) {
      for (let i = 2; i < gw - 2; i++) {
        const q = j * gw + i, f = src[q];
        if (f < PLATEAU_MIN || f >= 0.5) continue;
        for (const st of [1, gw]) {
          const along = st === 1 ? gw : 1; // direção da linha (perpendicular ao par)
          if (src[q - along] < RIDGE_ALONG || src[q + along] < RIDGE_ALONG) continue; // a tinta tem de continuar ao longo da linha
          let ok = false;
          for (const dir of [-1, 1]) {
            const fn = src[q + dir * st];
            // platô (valores parecidos), não rampa: |a − b| ≤ 0,2
            if (fn >= PLATEAU_MIN && Math.abs(fn - f) <= 0.2 && src[q - dir * st] <= RIDGE_SIDE && src[q + 2 * dir * st] <= RIDGE_SIDE) ok = true;
          }
          if (ok) { lift.push(q); break; }
        }
      }
    }
    for (const q of lift) src[q] = 0.5;
    for (const q of ridge) src[q] = Math.min(1, 0.5 / (1 - src[q] / 2));
  }
  const k: number[] = [];
  let ks = 0;
  if (R === 0) k.push(1), ks = 1;
  if (R > 0) for (let d = -R; d <= R; d++) { const v = Math.exp(-(d * d) / (2 * sigma * sigma)); k.push(v); ks += v; }
  for (let i = 0; i < k.length; i++) k[i] /= ks;
  const tmp = new Float32Array(gw * gh), G = new Float32Array(gw * gh);
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      let s = 0;
      for (let d = -R; d <= R; d++) s += k[d + R] * src[j * gw + Math.min(gw - 1, Math.max(0, i + d))];
      tmp[j * gw + i] = s;
    }
  }
  for (let j = 0; j < gh; j++) {
    for (let i = 0; i < gw; i++) {
      let s = 0;
      for (let d = -R; d <= R; d++) s += k[d + R] * tmp[Math.min(gh - 1, Math.max(0, j + d)) * gw + i];
      G[j * gw + i] = s;
    }
  }
  // anel externo vazio garante contornos fechados
  for (let i = 0; i < gw; i++) { G[i] = 0; G[(gh - 1) * gw + i] = 0; }
  for (let j = 0; j < gh; j++) { G[j * gw] = 0; G[j * gw + gw - 1] = 0; }

  const H = (i: number, j: number) => 2 * (j * gw + i);
  const V = (i: number, j: number) => 2 * (j * gw + i) + 1;
  const edgeId = (e: Edge, i: number, j: number) => (e === 'T' ? H(i, j) : e === 'B' ? H(i, j + 1) : e === 'L' ? V(i, j) : V(i + 1, j));
  const next = new Map<number, number>();
  for (let j = 0; j < gh - 1; j++) {
    for (let i = 0; i < gw - 1; i++) {
      const tl = G[j * gw + i] >= 0.5, tr = G[j * gw + i + 1] >= 0.5, br = G[(j + 1) * gw + i + 1] >= 0.5, bl = G[(j + 1) * gw + i] >= 0.5;
      const code = +tl | (+tr << 1) | (+br << 2) | (+bl << 3);
      if (code === 0 || code === 15) continue;
      let idx = code;
      if (code === 5 || code === 10) {
        const centre = (G[j * gw + i] + G[j * gw + i + 1] + G[(j + 1) * gw + i + 1] + G[(j + 1) * gw + i]) / 4 >= 0.5;
        if (centre) idx += 16;
      }
      for (const [a, b] of TABLE[idx]) next.set(edgeId(a, i, j), edgeId(b, i, j));
    }
  }
  const point = (id: number): Pt => {
    const vertical = id & 1;
    const cell = id >> 1;
    const i = cell % gw, j = (cell / gw) | 0;
    const clamp = (v: number, max: number) => Math.min(max, Math.max(0, v));
    if (!vertical) {
      const a = G[j * gw + i], b = G[j * gw + i + 1];
      const t = (0.5 - a) / (b - a);
      return { x: clamp(bx + 0.5 + i + t, w), y: clamp(by + 0.5 + j, h) };
    }
    const a = G[j * gw + i], b = G[(j + 1) * gw + i];
    const t = (0.5 - a) / (b - a);
    return { x: clamp(bx + 0.5 + i, w), y: clamp(by + 0.5 + j + t, h) };
  };
  const loops: Pt[][] = [];
  for (const start of [...next.keys()]) {
    if (!next.has(start)) continue;
    const loop: Pt[] = [];
    let cur = start;
    while (next.has(cur)) {
      const n = next.get(cur)!;
      next.delete(cur);
      loop.push(point(cur));
      cur = n;
      if (cur === start) break;
    }
    if (loop.length >= 4) loops.push(loop);
  }
  return loops;
}
