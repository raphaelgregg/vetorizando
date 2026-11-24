import { hex } from './color';
import type { Gradient, GradientStop } from './types';

const rgb = (c: string): [number, number, number] => [parseInt(c.slice(1, 3), 16), parseInt(c.slice(3, 5), 16), parseInt(c.slice(5, 7), 16)];
type BBox = [number, number, number, number];

const sorted = (stops: GradientStop[]): GradientStop[] => [...stops].sort((a, b) => a.offset - b.offset);

/** cor do gradiente no deslocamento `t` (0–1), interpolada entre as paradas */
export function colorAt(stops: GradientStop[], t: number): string {
  const s = sorted(stops);
  if (t <= s[0].offset) return s[0].color;
  if (t >= s[s.length - 1].offset) return s[s.length - 1].color;
  for (let i = 0; i < s.length - 1; i++) {
    if (t >= s[i].offset && t <= s[i + 1].offset) {
      const f = (t - s[i].offset) / Math.max(1e-9, s[i + 1].offset - s[i].offset), a = rgb(s[i].color), b = rgb(s[i + 1].color);
      return hex(a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1]), a[2] + f * (b[2] - a[2]));
    }
  }
  return s[0].color;
}

/** gradiente inicial para uma forma de cor sólida: da cor para uma versão mais escura, da esquerda para a direita */
export function defaultGradient(bbox: BBox, color: string): Gradient {
  const [r, g, b] = rgb(color), k = 0.65;
  const cy = (bbox[1] + bbox[3]) / 2;
  return { kind: 'linear', x1: bbox[0], y1: cy, x2: bbox[2], y2: cy, stops: [{ offset: 0, color }, { offset: 1, color: hex(r * k, g * k, b * k) }] };
}

/** troca linear ↔ radial mantendo as paradas; a geometria vem da caixa da forma */
export function convertKind(g: Gradient, kind: 'linear' | 'radial', bbox: BBox): Gradient {
  if (g.kind === kind) return g;
  const cx = (bbox[0] + bbox[2]) / 2, cy = (bbox[1] + bbox[3]) / 2;
  if (kind === 'radial') return { kind, cx, cy, r: Math.max(1, Math.hypot(bbox[2] - bbox[0], bbox[3] - bbox[1]) / 2), stops: g.stops };
  return { kind, x1: bbox[0], y1: cy, x2: bbox[2], y2: cy, stops: g.stops };
}

export function setStop(g: Gradient, i: number, patch: Partial<GradientStop>): Gradient {
  const stops = g.stops.map((s, k) => (k === i ? { ...s, ...patch, offset: Math.min(1, Math.max(0, patch.offset ?? s.offset)) } : s));
  return { ...g, stops };
}

/** nova parada no meio do maior intervalo, com a cor interpolada */
export function addStop(g: Gradient): Gradient {
  const s = sorted(g.stops);
  let at = 0, gap = -1;
  for (let i = 0; i < s.length - 1; i++) if (s[i + 1].offset - s[i].offset > gap) { gap = s[i + 1].offset - s[i].offset; at = i; }
  const off = (s[at].offset + s[at + 1].offset) / 2;
  return { ...g, stops: sorted([...s, { offset: Math.round(off * 1e4) / 1e4, color: colorAt(s, off) }]) };
}

export function removeStop(g: Gradient, i: number): Gradient {
  return g.stops.length <= 2 ? g : { ...g, stops: g.stops.filter((_, k) => k !== i) };
}

export function reverse(g: Gradient): Gradient {
  return { ...g, stops: sorted(g.stops.map((s) => ({ ...s, offset: Math.round((1 - s.offset) * 1e4) / 1e4 }))) };
}

/** alças arrastáveis: linear = início e fim; radial = centro e um ponto do raio (à direita do centro) */
export function handles(g: Gradient): [number, number][] {
  return g.kind === 'linear' ? [[g.x1, g.y1], [g.x2, g.y2]] : [[g.cx, g.cy], [g.cx + g.r, g.cy]];
}

export function moveHandle(g: Gradient, i: number, x: number, y: number): Gradient {
  if (g.kind === 'linear') return i === 0 ? { ...g, x1: x, y1: y } : { ...g, x2: x, y2: y };
  return i === 0 ? { ...g, cx: x, cy: y } : { ...g, r: Math.max(1, Math.hypot(x - g.cx, y - g.cy)) };
}

/** leva um gradiente de uma forma para outra: a geometria é reescalada da caixa de origem para a de destino */
export function retarget(g: Gradient, from: BBox, to: BBox): Gradient {
  const fw = Math.max(1e-6, from[2] - from[0]), fh = Math.max(1e-6, from[3] - from[1]);
  const sx = (to[2] - to[0]) / fw, sy = (to[3] - to[1]) / fh;
  const mx = (x: number) => to[0] + (x - from[0]) * sx, my = (y: number) => to[1] + (y - from[1]) * sy;
  if (g.kind === 'linear') return { ...g, x1: mx(g.x1), y1: my(g.y1), x2: mx(g.x2), y2: my(g.y2) };
  return { ...g, cx: mx(g.cx), cy: my(g.cy), r: Math.max(1, g.r * Math.sqrt(Math.abs(sx * sy))) };
}
