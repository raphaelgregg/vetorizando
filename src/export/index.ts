import { flattenGradients } from '../engine/gradient';
import { HEX_COLORS, SvgColors, toSVG } from '../engine/svg';
import type { Options, VDoc } from '../engine/types';
import { toDXF } from './dxf';
import { toEPS } from './eps';
import { toPDF } from './pdf';
import { SizeSpec, resolveSize } from './size';

export type Format = 'svg' | 'pdf' | 'eps' | 'dxf';

export interface Exported {
  data: string | Uint8Array;
  mime: string;
  ext: string;
  width: number;
  height: number;
  unit: string;
}

export const FORMATS: { id: Format; label: string; hint: string }[] = [
  { id: 'svg', label: 'SVG', hint: 'Vetor para web e editores' },
  { id: 'pdf', label: 'PDF', hint: 'Impressão; grupos viram camadas' },
  { id: 'eps', label: 'EPS', hint: 'PostScript (EPSF‑3.0)' },
  { id: 'dxf', label: 'DXF', hint: 'CAD/CNC: contornos, sem preenchimento' },
];

/** Exporta o documento no formato e tamanho pedidos (unidades px/mm/cm/% e DPI). */
export function exportDoc(format: Format, doc: VDoc, o: Options, spec: SizeSpec, origW: number, origH: number, svgColors: SvgColors = HEX_COLORS): Exported {
  // só o SVG tem gradientes: PDF/EPS/DXF usam as bandas sólidas equivalentes
  if (format !== 'svg') doc = flattenGradients(doc);
  const size = resolveSize(spec, origW, origH, doc.width, doc.height);
  const meta = { width: size.width, height: size.height, unit: size.unit };
  switch (format) {
    case 'svg': return { data: toSVG(doc, o, { width: size.width, height: size.height, unit: size.unit }, svgColors), mime: 'image/svg+xml', ext: 'svg', ...meta };
    case 'pdf': return { data: toPDF(doc, o, size), mime: 'application/pdf', ext: 'pdf', ...meta };
    case 'eps': return { data: toEPS(doc, o, size), mime: 'application/postscript', ext: 'eps', ...meta };
    case 'dxf': return { data: toDXF(doc, o, size), mime: 'application/dxf', ext: 'dxf', ...meta };
  }
}
