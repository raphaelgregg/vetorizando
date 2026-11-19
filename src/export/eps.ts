import { toCubicPath } from '../engine/geom';
import type { Options, VDoc, VPath } from '../engine/types';
import { groupLayers, paintMode, rgbOf } from './groups';
import { ResolvedSize, fmt } from './size';

function pathOps(p: VPath): string {
  const c = toCubicPath(p);
  let s = `${fmt(c.start.x)} ${fmt(c.start.y)} moveto\n`;
  for (const g of c.segs) s += g.t === 'L' ? `${fmt(g.p.x)} ${fmt(g.p.y)} lineto\n` : `${fmt(g.c1.x)} ${fmt(g.c1.y)} ${fmt(g.c2.x)} ${fmt(g.c2.y)} ${fmt(g.p.x)} ${fmt(g.p.y)} curveto\n`;
  return s + 'closepath\n';
}

/**
 * EPS (PostScript nível 3, EPSF-3.0). O PostScript puro não tem camadas: os grupos
 * (cor/camada) são registrados como comentários `%%Group:` para referência.
 */
export function toEPS(doc: VDoc, o: Options, size: ResolvedSize): string {
  const { fill, gap } = paintMode(o);
  const k = size.widthPt / doc.width;
  let s = '%!PS-Adobe-3.0 EPSF-3.0\n%%Creator: Vetorizando\n';
  s += `%%BoundingBox: 0 0 ${Math.ceil(size.widthPt)} ${Math.ceil(size.heightPt)}\n`;
  s += `%%HiResBoundingBox: 0 0 ${fmt(size.widthPt)} ${fmt(size.heightPt)}\n`;
  s += '%%LanguageLevel: 3\n%%Pages: 1\n%%EndComments\n%%Page: 1 1\n';
  s += `gsave\n0 ${fmt(size.heightPt)} translate\n${fmt(k, 6)} ${fmt(-k, 6)} scale\n1 setlinejoin 1 setlinecap\n`;
  for (const g of groupLayers(doc, o)) {
    if (g.name) s += `%%Group: ${g.name}\n`;
    for (const layer of g.layers) {
      const [r, gg, b] = rgbOf(layer.color).map((v) => fmt(v / 255, 4));
      s += `${r} ${gg} ${b} setrgbcolor\n`;
      s += fill ? (gap ? `${fmt(o.gapStrokeWidth, 4)} setlinewidth\n` : '') : `${fmt(0.75 / k, 5)} setlinewidth\n`;
      s += 'newpath\n';
      for (const p of layer.paths) s += pathOps(p);
      s += fill ? (gap ? 'gsave fill grestore stroke\n' : 'fill\n') : 'stroke\n';
    }
  }
  s += 'grestore\nshowpage\n%%EOF\n';
  return s;
}
