import { groupLayers, paintMode } from '../export/groups';
import type { Options, Pt, VDoc, VPath } from './types';

const num = (n: number) => String(Math.round(n * 100) / 100);
const pt = (p: Pt) => `${num(p.x)} ${num(p.y)}`;

export function pathData(p: VPath): string {
  let d = `M${pt(p.start)}`;
  for (const s of p.segs) {
    if (s.t === 'L') d += `L${pt(s.p)}`;
    else if (s.t === 'A') d += `A${num(s.r)} ${num(s.r)} 0 ${s.large} ${s.sweep} ${pt(s.p)}`;
    else d += `C${pt(s.c1)} ${pt(s.c2)} ${pt(s.p)}`;
  }
  return d + 'Z';
}

export interface SvgSize {
  width?: number;
  height?: number;
  unit?: 'px' | 'mm' | 'cm';
}

/** Gera o SVG a partir do modelo vetorial (viewBox no espaço de processamento). */
export function toSVG(doc: VDoc, o: Options, size: SvgSize = {}): string {
  const w = size.width ?? doc.width, h = size.height ?? doc.height, u = size.unit ?? 'px';
  const { fill, gap } = paintMode(o);
  const layered = o.groupBy === 'layer';
  const ns = layered ? ' xmlns:inkscape="http://www.inkscape.org/namespaces/inkscape"' : '';
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg"${ns} version="1.1" width="${num(w)}${u}" height="${num(h)}${u}" viewBox="0 0 ${doc.width} ${doc.height}">`,
  ];
  for (const g of groupLayers(doc, o)) {
    if (g.name) {
      const id = g.name.replace(/\s+/g, '-').toLowerCase();
      parts.push(layered ? `<g id="${id}" inkscape:groupmode="layer" inkscape:label="${g.name}">` : `<g id="${id}">`);
    }
    for (const layer of g.layers) {
      const attrs = fill
        ? `fill="${layer.color}" fill-rule="nonzero"${gap ? ` stroke="${layer.color}" stroke-width="${num(o.gapStrokeWidth)}" stroke-linejoin="round" paint-order="stroke"` : ''}`
        : `fill="none" stroke="${layer.color}" stroke-width="1" vector-effect="non-scaling-stroke"`;
      parts.push(`<path ${attrs} d="${layer.paths.map(pathData).join('')}"/>`);
    }
    if (g.name) parts.push('</g>');
  }
  parts.push('</svg>');
  return parts.join('\n');
}
