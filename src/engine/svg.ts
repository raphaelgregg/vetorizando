import { groupLayers, paintMode } from '../export/groups';
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
 * Gera o SVG a partir do modelo vetorial (viewBox no espaço de processamento).
 * Preenchimento de fendas: traços da mesma cor numa camada ABAIXO de todos os preenchimentos
 * (só aparecem onde há fenda real; não engrossam formas) e, com bordas abertas (transparência /
 * fundo removido), recortados pela união das regiões para não crescer a silhueta.
 */
export function toSVG(doc: VDoc, o: Options, size: SvgSize = {}): string {
  const w = size.width ?? doc.width, h = size.height ?? doc.height, u = size.unit ?? 'px';
  const { fill, gap } = paintMode(o);
  const layered = o.groupBy === 'layer';
  const ns = layered ? ' xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"' : '';
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg"${ns} version="1.1" width="${num(w)}${u}" height="${num(h)}${u}" viewBox="0 0 ${doc.width} ${doc.height}">`,
  ];
  const dOf = new Map(doc.layers.map((l) => [l, l.paths.map(pathData).join('')]));
  if (gap) {
    const clip = doc.openBoundary;
    if (clip) parts.push(`<defs><clipPath id="uniao"><path d="${doc.layers.map((l) => dOf.get(l)).join('')}"/></clipPath></defs>`);
    const attrs = `id="fendas"${layered ? ' inkscape:groupmode="layer" inkscape:label="Preenchimento de fendas"' : ''} fill="none" stroke-width="${num(o.gapStrokeWidth)}" stroke-linejoin="round"${clip ? ' clip-path="url(#uniao)"' : ''}`;
    parts.push(`<g ${attrs}>`);
    for (const layer of doc.layers) parts.push(`<path stroke="${layer.color}" d="${dOf.get(layer)}"/>`);
    parts.push('</g>');
  }
  for (const g of groupLayers(doc, o)) {
    if (g.name) {
      const id = g.name.replace(/\s+/g, '-').toLowerCase();
      parts.push(layered ? `<g id="${id}" inkscape:groupmode="layer" inkscape:label="${g.name}">` : `<g id="${id}">`);
    }
    for (const layer of g.layers) {
      const attrs = fill ? `fill="${layer.color}" fill-rule="nonzero"` : `fill="none" stroke="${layer.color}" stroke-width="1" vector-effect="non-scaling-stroke"`;
      parts.push(`<path ${attrs} d="${dOf.get(layer)}"/>`);
    }
    if (g.name) parts.push('</g>');
  }
  parts.push('</svg>');
  return parts.join('\n');
}
