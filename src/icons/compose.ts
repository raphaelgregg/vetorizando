import { HEX_COLORS, SvgColors, svgBody } from '../engine/svg';
import type { Options, VDoc } from '../engine/types';

export type IconShape = 'square' | 'rounded' | 'circle';

export interface ComposeOptions {
  size: number; // lado em px do SVG/raster final
  padding: number; // fração do lado, 0–0,45
  background?: string | null; // #rrggbb; null = transparente
  shape?: IconShape;
  colors?: SvgColors;
}

const n = (v: number) => String(Math.round(v * 1000) / 1000);

/**
 * Compõe o ícone num quadrado: ajusta o vetor (contain, centralizado) dentro da margem, com fundo e máscara
 * opcionais. O resultado é um SVG `size`×`size`, que o rasterizador desenha exatamente nessa resolução.
 */
export function composeIconSvg(doc: VDoc, o: Options, c: ComposeOptions): string {
  const S = c.size;
  const pad = Math.min(0.45, Math.max(0, c.padding));
  const inner = S * (1 - 2 * pad);
  const k = Math.min(inner / doc.width, inner / doc.height);
  const w = doc.width * k, h = doc.height * k;
  const x = (S - w) / 2, y = (S - h) / 2;
  const shape = c.shape ?? 'square';
  const clip = shape === 'square' ? '' : `<defs><clipPath id="forma">${shape === 'circle' ? `<circle cx="${n(S / 2)}" cy="${n(S / 2)}" r="${n(S / 2)}"/>` : `<rect width="${S}" height="${S}" rx="${n(S * 0.2237)}"/>`}</clipPath></defs>`;
  const body = svgBody(doc, o, c.colors ?? HEX_COLORS).join('');
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">`,
    clip,
    shape === 'square' ? '<g>' : '<g clip-path="url(#forma)">',
    c.background ? `<rect width="${S}" height="${S}" fill="${c.background}"/>` : '',
    `<svg x="${n(x)}" y="${n(y)}" width="${n(w)}" height="${n(h)}" viewBox="0 0 ${doc.width} ${doc.height}">${body}</svg>`,
    '</g></svg>',
  ].join('');
}
