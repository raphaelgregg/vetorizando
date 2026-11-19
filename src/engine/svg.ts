import type { Options, Pt, VDoc, VPath } from './types';

const num = (n: number) => String(Math.round(n * 100) / 100);
const pt = (p: Pt) => `${num(p.x)} ${num(p.y)}`;

export function pathData(p: VPath): string {
  let d = `M${pt(p.start)}`;
  for (const s of p.segs) d += s.t === 'L' ? `L${pt(s.p)}` : `C${pt(s.c1)} ${pt(s.c2)} ${pt(s.p)}`;
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
  const fill = o.drawStyle === 'fill';
  const gap = fill && o.gapFiller && o.stacking === 'cutouts';
  const parts: string[] = [
    `<svg xmlns="http://www.w3.org/2000/svg" version="1.1" width="${num(w)}${u}" height="${num(h)}${u}" viewBox="0 0 ${doc.width} ${doc.height}">`,
  ];
  for (const layer of doc.layers) {
    const attrs = fill
      ? `fill="${layer.color}" fill-rule="nonzero"${gap ? ` stroke="${layer.color}" stroke-width="${num(o.gapStrokeWidth)}" stroke-linejoin="round" paint-order="stroke"` : ''}`
      : `fill="none" stroke="${layer.color}" stroke-width="1" vector-effect="non-scaling-stroke"`;
    const d = layer.paths.map(pathData).join('');
    if (o.groupBy === 'color') parts.push(`<g fill="${layer.color}"><path ${attrs} d="${d}"/></g>`);
    else parts.push(`<path ${attrs} d="${d}"/>`);
  }
  parts.push('</svg>');
  return parts.join('\n');
}
