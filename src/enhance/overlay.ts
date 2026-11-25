import type { RawImage } from '../engine/types';

export type ShapeKind = 'rect' | 'rounded' | 'ellipse' | 'triangle' | 'polygon' | 'star' | 'heart' | 'cross' | 'line' | 'arrow';

/** Forma inserida na imagem. Coordenadas em FRAÇÕES da tela final (largura/altura da saída): vale em qualquer tamanho. */
export interface Overlay {
  id: number;
  name: string;
  kind: ShapeKind;
  x: number; // caixa (formas fechadas)
  y: number;
  w: number;
  h: number;
  rot: number; // graus (formas fechadas)
  x1: number; // extremos (linha e seta)
  y1: number;
  x2: number;
  y2: number;
  fill: string | null; // #rrggbb ou null = sem preenchimento
  stroke: string | null;
  strokeW: number; // % do menor lado da tela
  opacity: number; // 0–1
  radius: number; // arredondamento (0–0,5 do menor lado da caixa) — 'rounded'
  sides: number; // lados do polígono / pontas da estrela
  inner: number; // raio interno da estrela (0,15–0,9)
  visible: boolean;
}

export const SHAPE_KINDS: { id: ShapeKind; label: string }[] = [
  { id: 'rect', label: 'Retângulo' },
  { id: 'rounded', label: 'Retângulo arredondado' },
  { id: 'ellipse', label: 'Elipse / círculo' },
  { id: 'triangle', label: 'Triângulo' },
  { id: 'polygon', label: 'Polígono' },
  { id: 'star', label: 'Estrela' },
  { id: 'heart', label: 'Coração' },
  { id: 'cross', label: 'Cruz' },
  { id: 'line', label: 'Linha' },
  { id: 'arrow', label: 'Seta' },
];

export const isLine = (k: ShapeKind) => k === 'line' || k === 'arrow';

let nextId = 1;
/** nova forma centrada, com padrões sensatos (a cor de preenchimento vem do chamador) */
export function makeOverlay(kind: ShapeKind, fill = '#ff5a36', stroke: string | null = null): Overlay {
  const line = isLine(kind);
  return {
    id: nextId++, name: SHAPE_KINDS.find((s) => s.id === kind)!.label, kind,
    x: 0.3, y: 0.3, w: 0.4, h: kind === 'rect' || kind === 'rounded' ? 0.3 : 0.4, rot: 0,
    x1: 0.25, y1: 0.7, x2: 0.75, y2: 0.3,
    fill: line ? null : fill, stroke: line ? fill : stroke, strokeW: line ? 1.2 : 0.6, opacity: 1,
    radius: 0.2, sides: kind === 'star' ? 5 : 6, inner: 0.45, visible: true,
  };
}
/** garante que ids novos não colidam com os já usados (ao restaurar/duplicar) */
export function reserveIds(list: Overlay[]): void { for (const o of list) nextId = Math.max(nextId, o.id + 1); }
export const newId = () => nextId++;

type Pt = [number, number];

const rot = (p: Pt, c: Pt, deg: number): Pt => {
  if (!deg) return p;
  const a = (deg * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a), dx = p[0] - c[0], dy = p[1] - c[1];
  return [c[0] + dx * co - dy * si, c[1] + dx * si + dy * co];
};

/** Contorno fechado da forma em pixels (já girado). Linhas/setas devolvem null aqui. */
export function outline(o: Overlay, W: number, H: number): Pt[] | null {
  if (isLine(o.kind)) return null;
  const x = o.x * W, y = o.y * H, w = o.w * W, h = o.h * H, c: Pt = [x + w / 2, y + h / 2], rx = w / 2, ry = h / 2;
  let pts: Pt[] = [];
  switch (o.kind) {
    case 'rect': pts = [[x, y], [x + w, y], [x + w, y + h], [x, y + h]]; break;
    case 'rounded': {
      const r = Math.min(w, h) * Math.max(0, Math.min(0.5, o.radius)), n = 10;
      const corner = (cx: number, cy: number, a0: number) => { for (let i = 0; i <= n; i++) { const a = a0 + (i / n) * (Math.PI / 2); pts.push([cx + r * Math.cos(a), cy + r * Math.sin(a)]); } };
      corner(x + w - r, y + r, -Math.PI / 2); corner(x + w - r, y + h - r, 0); corner(x + r, y + h - r, Math.PI / 2); corner(x + r, y + r, Math.PI);
      break;
    }
    case 'ellipse': { const n = Math.max(48, Math.min(200, Math.round(Math.sqrt(rx + ry) * 8))); for (let i = 0; i < n; i++) { const a = (i / n) * Math.PI * 2; pts.push([c[0] + rx * Math.cos(a), c[1] + ry * Math.sin(a)]); } break; }
    case 'triangle': pts = [[c[0], y], [x + w, y + h], [x, y + h]]; break;
    case 'polygon': { const n = Math.max(3, Math.round(o.sides)); for (let i = 0; i < n; i++) { const a = -Math.PI / 2 + (i / n) * Math.PI * 2; pts.push([c[0] + rx * Math.cos(a), c[1] + ry * Math.sin(a)]); } break; }
    case 'star': { const n = Math.max(3, Math.round(o.sides)); for (let i = 0; i < n * 2; i++) { const a = -Math.PI / 2 + (i / (n * 2)) * Math.PI * 2, k = i % 2 ? Math.max(0.1, Math.min(0.95, o.inner)) : 1; pts.push([c[0] + rx * k * Math.cos(a), c[1] + ry * k * Math.sin(a)]); } break; }
    case 'heart': {
      // curva paramétrica clássica normalizada para a caixa
      const raw: Pt[] = [];
      for (let i = 0; i < 80; i++) { const t = (i / 80) * Math.PI * 2; raw.push([16 * Math.sin(t) ** 3, -(13 * Math.cos(t) - 5 * Math.cos(2 * t) - 2 * Math.cos(3 * t) - Math.cos(4 * t))]); }
      const xs = raw.map((p) => p[0]), ys = raw.map((p) => p[1]), x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
      pts = raw.map((p) => [x + ((p[0] - x0) / (x1 - x0)) * w, y + ((p[1] - y0) / (y1 - y0)) * h]);
      break;
    }
    case 'cross': {
      const t = 0.34, ax = x + w * t, bx = x + w * (1 - t), ay = y + h * t, by = y + h * (1 - t);
      pts = [[ax, y], [bx, y], [bx, ay], [x + w, ay], [x + w, by], [bx, by], [bx, y + h], [ax, y + h], [ax, by], [x, by], [x, ay], [ax, ay]];
      break;
    }
  }
  return pts.map((p) => rot(p, c, o.rot));
}

/** polígono da seta (haste + ponta) em pixels */
function arrowPolygon(o: Overlay, W: number, H: number): Pt[] {
  const p1: Pt = [o.x1 * W, o.y1 * H], p2: Pt = [o.x2 * W, o.y2 * H];
  const sw = Math.max(1, (o.strokeW / 100) * Math.min(W, H)), L = Math.hypot(p2[0] - p1[0], p2[1] - p1[1]) || 1;
  const ux = (p2[0] - p1[0]) / L, uy = (p2[1] - p1[1]) / L, nx = -uy, ny = ux;
  const head = Math.min(L * 0.5, sw * 4.5), half = sw * 2.2, bx = p2[0] - ux * head, by = p2[1] - uy * head;
  return [
    [p1[0] + nx * sw / 2, p1[1] + ny * sw / 2], [bx + nx * sw / 2, by + ny * sw / 2], [bx + nx * half, by + ny * half], p2,
    [bx - nx * half, by - ny * half], [bx - nx * sw / 2, by - ny * sw / 2], [p1[0] - nx * sw / 2, p1[1] - ny * sw / 2],
  ];
}

const hexRgb = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];

/** "over" sobre um pixel RGBA não pré-multiplicado */
function over(d: Uint8ClampedArray, i: number, c: [number, number, number], a: number): void {
  if (a <= 0) return;
  const da = d[i + 3] / 255, oa = a + da * (1 - a);
  for (let k = 0; k < 3; k++) d[i + k] = (c[k] * a + d[i + k] * da * (1 - a)) / oa;
  d[i + 3] = Math.round(oa * 255);
}

const clamp01 = (v: number) => (v < 0 ? 0 : v > 1 ? 1 : v);

/**
 * Preenche/contorna um polígono com antialiasing analítico: distância com sinal até as arestas só na faixa da borda;
 * o miolo (longe das arestas) é decidido por varredura par-ímpar.
 */
function paintPolygon(d: Uint8ClampedArray, W: number, H: number, pts: Pt[], closed: boolean, fill: string | null, stroke: string | null, sw: number, opacity: number): void {
  if (pts.length < 2) return;
  const pad = sw / 2 + 2;
  let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
  for (const p of pts) { x0 = Math.min(x0, p[0]); y0 = Math.min(y0, p[1]); x1 = Math.max(x1, p[0]); y1 = Math.max(y1, p[1]); }
  const bx0 = Math.max(0, Math.floor(x0 - pad)), by0 = Math.max(0, Math.floor(y0 - pad)), bx1 = Math.min(W - 1, Math.ceil(x1 + pad)), by1 = Math.min(H - 1, Math.ceil(y1 + pad));
  if (bx1 < bx0 || by1 < by0) return;
  const bw = bx1 - bx0 + 1, bh = by1 - by0 + 1;
  const dist = new Float32Array(bw * bh).fill(Infinity);
  const m = pts.length, edges = closed ? m : m - 1;
  for (let e = 0; e < edges; e++) {
    const a = pts[e], b = pts[(e + 1) % m];
    const ex0 = Math.max(bx0, Math.floor(Math.min(a[0], b[0]) - pad)), ex1 = Math.min(bx1, Math.ceil(Math.max(a[0], b[0]) + pad));
    const ey0 = Math.max(by0, Math.floor(Math.min(a[1], b[1]) - pad)), ey1 = Math.min(by1, Math.ceil(Math.max(a[1], b[1]) + pad));
    const dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
    for (let y = ey0; y <= ey1; y++) for (let x = ex0; x <= ex1; x++) {
      const px = x + 0.5, py = y + 0.5, t = clamp01(((px - a[0]) * dx + (py - a[1]) * dy) / l2);
      const dd = Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)), k = (y - by0) * bw + (x - bx0);
      if (dd < dist[k]) dist[k] = dd;
    }
  }
  // dentro/fora por varredura par-ímpar nos centros dos pixels
  const inside = new Uint8Array(bw * bh);
  if (closed) {
    for (let y = by0; y <= by1; y++) {
      const yc = y + 0.5, xs: number[] = [];
      for (let e = 0; e < m; e++) {
        const a = pts[e], b = pts[(e + 1) % m];
        if ((a[1] <= yc) !== (b[1] <= yc)) xs.push(a[0] + ((yc - a[1]) * (b[0] - a[0])) / (b[1] - a[1]));
      }
      xs.sort((p, q) => p - q);
      for (let i = 0; i + 1 < xs.length; i += 2) {
        const xa = Math.max(bx0, Math.ceil(xs[i] - 0.5)), xb = Math.min(bx1, Math.ceil(xs[i + 1] - 0.5) - 1);
        for (let x = xa; x <= xb; x++) inside[(y - by0) * bw + (x - bx0)] = 1;
      }
    }
  }
  const fc = fill ? hexRgb(fill) : null, sc = stroke ? hexRgb(stroke) : null;
  for (let y = by0; y <= by1; y++) for (let x = bx0; x <= bx1; x++) {
    const k = (y - by0) * bw + (x - bx0), dd = dist[k], i = (y * W + x) * 4;
    if (fc && closed) {
      const sd = inside[k] ? -dd : dd; // distância com sinal (negativa dentro)
      over(d, i, fc, clamp01(0.5 - (Number.isFinite(sd) ? sd : inside[k] ? -1e9 : 1e9)) * opacity);
    }
    if (sc && sw > 0 && Number.isFinite(dd)) over(d, i, sc, clamp01(0.5 - (dd - sw / 2)) * opacity);
  }
}

/** Compõe as formas visíveis (de baixo para cima) sobre a imagem; devolve uma cópia (ou a mesma se não há o que desenhar). */
export function drawOverlays(img: RawImage, layers: Overlay[]): RawImage {
  const list = layers.filter((o) => o.visible && o.opacity > 0);
  if (!list.length) return img;
  const { width: W, height: H } = img, out = new Uint8ClampedArray(img.data);
  for (const o of list) {
    const sw = (o.strokeW / 100) * Math.min(W, H);
    if (o.kind === 'line') paintPolygon(out, W, H, [[o.x1 * W, o.y1 * H], [o.x2 * W, o.y2 * H]], false, null, o.stroke ?? o.fill, Math.max(1, sw), o.opacity);
    else if (o.kind === 'arrow') paintPolygon(out, W, H, arrowPolygon(o, W, H), true, o.stroke ?? o.fill, null, 0, o.opacity);
    else { const pts = outline(o, W, H); if (pts) paintPolygon(out, W, H, pts, true, o.fill, o.stroke, o.stroke ? Math.max(0, sw) : 0, o.opacity); }
  }
  return { data: out, width: W, height: H };
}

/** forma sob o ponto (frações da tela), da mais à frente para a mais ao fundo */
export function hitOverlay(layers: Overlay[], fx: number, fy: number, W: number, H: number): Overlay | null {
  for (let i = layers.length - 1; i >= 0; i--) {
    const o = layers[i];
    if (!o.visible) continue;
    const px = fx * W, py = fy * H, tol = Math.max(6, (o.strokeW / 100) * Math.min(W, H));
    if (isLine(o.kind)) {
      const a: Pt = [o.x1 * W, o.y1 * H], b: Pt = [o.x2 * W, o.y2 * H], dx = b[0] - a[0], dy = b[1] - a[1], l2 = dx * dx + dy * dy || 1;
      const t = clamp01(((px - a[0]) * dx + (py - a[1]) * dy) / l2);
      if (Math.hypot(px - (a[0] + t * dx), py - (a[1] + t * dy)) <= tol) return o;
      continue;
    }
    const pts = outline(o, W, H)!;
    let inside = false;
    for (let a = 0, b = pts.length - 1; a < pts.length; b = a++) if (pts[a][1] > py !== pts[b][1] > py && px < ((pts[b][0] - pts[a][0]) * (py - pts[a][1])) / (pts[b][1] - pts[a][1]) + pts[a][0]) inside = !inside;
    if (inside) return o;
  }
  return null;
}
