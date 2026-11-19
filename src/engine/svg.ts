import { groupLayers, paintMode } from '../export/groups';
import { suggestCurrentColor } from './palette';
import type { Options, Pt, VDoc, VPath } from './types';

const num = (n: number) => String(Math.round(n * 100) / 100);
const pt = (p: Pt) => `${num(p.x)} ${num(p.y)}`;

export function pathData(p: VPath): string {
  let d = `M${pt(p.start)}`;
  for (const s of p.segs) {
    if (s.t === 'L') d += `L${pt(s.p)}`;
    else if (s.t === 'A') d += `A${num(s.r)} ${num(s.r)} 0 ${s.large} ${s.sweep} ${pt(s.p)}`;
    else if (s.t === 'E') d += `A${num(s.rx)} ${num(s.ry)} ${num(s.rot)} ${s.large} ${s.sweep} ${pt(s.p)}`;
    else d += `C${pt(s.c1)} ${pt(s.c2)} ${pt(s.p)}`;
  }
  return d + 'Z';
}

export interface SvgSize {
  width?: number;
  height?: number;
  unit?: 'px' | 'mm' | 'cm';
}

/**
 * Como as cores entram no SVG:
 *  - `hex` (padrão): `fill="#rrggbb"`;
 *  - `currentColor`: a cor escolhida vira `currentColor` (o ícone herda a cor do texto/CSS da página);
 *  - `classes`: um `<style>` com `.c0{fill:#…}` e cada forma usa `class="c0"` — cores editáveis num só lugar.
 */
export interface SvgColors {
  mode: 'hex' | 'currentColor' | 'classes';
  /** cor (hex) que vira `currentColor`; omitida = a mais representativa do documento */
  currentColor?: string;
}

export const HEX_COLORS: SvgColors = { mode: 'hex' };

/** Atributos de cor para uma cor, conforme o modo. `kind`: preenchimento ou traço. */
function colorAttrs(colors: SvgColors, doc: VDoc, cc: string | undefined) {
  const order = [...new Set(doc.layers.map((l) => l.color))];
  return (color: string, kind: 'fill' | 'stroke'): string => {
    if (colors.mode === 'currentColor' && color === cc) return `${kind}="currentColor"`;
    if (colors.mode === 'classes') return `class="${kind === 'fill' ? 'c' : 's'}${order.indexOf(color)}"`;
    return `${kind}="${color}"`;
  };
}

/** Elementos internos do SVG (sem a tag `<svg>`): usados por `toSVG` e pela composição de ícones. */
export function svgBody(doc: VDoc, o: Options, colors: SvgColors = HEX_COLORS): string[] {
  const { fill, gap } = paintMode(o);
  const layered = o.groupBy === 'layer';
  const cc = colors.mode === 'currentColor' ? colors.currentColor ?? suggestCurrentColor(doc) : undefined;
  const attr = colorAttrs(colors, doc, cc);
  const parts: string[] = [];
  if (colors.mode === 'classes') {
    const order = [...new Set(doc.layers.map((l) => l.color))];
    parts.push(`<style>${order.map((c, i) => `.c${i}{fill:${c}}.s${i}{stroke:${c}}`).join('')}</style>`);
  }
  const dOf = new Map(doc.layers.map((l) => [l, l.paths.map(pathData).join('')]));
  if (gap) {
    const clip = doc.openBoundary;
    if (clip) parts.push(`<defs><clipPath id="uniao"><path d="${doc.layers.map((l) => dOf.get(l)).join('')}"/></clipPath></defs>`);
    const attrs = `id="fendas"${layered ? ' inkscape:groupmode="layer" inkscape:label="Preenchimento de fendas"' : ''} fill="none" stroke-width="${num(o.gapStrokeWidth)}" stroke-linejoin="round"${clip ? ' clip-path="url(#uniao)"' : ''}`;
    parts.push(`<g ${attrs}>`);
    for (const layer of doc.layers) {
      const d = layer.paths.filter((p) => !p.thin).map(pathData).join('');
      if (d) parts.push(`<path ${attr(layer.color, 'stroke')} d="${d}"/>`);
    }
    parts.push('</g>');
  }
  for (const g of groupLayers(doc, o)) {
    if (g.name) {
      const id = g.name.replace(/\s+/g, '-').toLowerCase();
      parts.push(layered ? `<g id="${id}" inkscape:groupmode="layer" inkscape:label="${g.name}">` : `<g id="${id}">`);
    }
    for (const layer of g.layers) {
      const attrs = fill ? `${attr(layer.color, 'fill')} fill-rule="nonzero"` : `fill="none" ${attr(layer.color, 'stroke')} stroke-width="1" vector-effect="non-scaling-stroke"`;
      parts.push(`<path ${attrs} d="${dOf.get(layer)}"/>`);
    }
    if (g.name) parts.push('</g>');
  }
  return parts;
}

/**
 * Gera o SVG a partir do modelo vetorial (viewBox no espaço de processamento).
 * Preenchimento de fendas: traços da mesma cor numa camada ABAIXO de todos os preenchimentos
 * (só aparecem onde há fenda real; não engrossam formas) e, com bordas abertas (transparência /
 * fundo removido), recortados pela união das regiões para não crescer a silhueta.
 */
export function toSVG(doc: VDoc, o: Options, size: SvgSize = {}, colors: SvgColors = HEX_COLORS): string {
  const w = size.width ?? doc.width, h = size.height ?? doc.height, u = size.unit ?? 'px';
  const layered = o.groupBy === 'layer';
  const ns = layered ? ' xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"' : '';
  return [
    `<svg xmlns="http://www.w3.org/2000/svg"${ns} version="1.1" width="${num(w)}${u}" height="${num(h)}${u}" viewBox="0 0 ${doc.width} ${doc.height}">`,
    ...svgBody(doc, o, colors),
    '</svg>',
  ].join('\n');
}
