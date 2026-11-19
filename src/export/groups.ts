import type { Layer, Options, VDoc } from '../engine/types';

export interface Group {
  /** Nome legível (camada PDF, layer DXF, id SVG); null = sem agrupamento. */
  name: string | null;
  layers: Layer[];
}

const slug = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '').toUpperCase();

/** Agrupamento por cor, por camada (ordem de empilhamento) ou nenhum. */
export function groupLayers(doc: VDoc, o: Options): Group[] {
  if (o.groupBy === 'none') return [{ name: null, layers: doc.layers }];
  if (o.groupBy === 'layer') return doc.layers.map((l, i) => ({ name: `Camada ${i + 1}`, layers: [l] }));
  const byColor = new Map<string, Layer[]>();
  for (const l of doc.layers) byColor.set(l.color, [...(byColor.get(l.color) ?? []), l]);
  return [...byColor].map(([c, layers]) => ({ name: `Cor ${slug(c)}`, layers }));
}

export interface Paint {
  fill: boolean;
  gap: boolean; // preenchimento de fendas (traço da mesma cor)
}

export function paintMode(o: Options): Paint {
  const fill = o.drawStyle === 'fill';
  return { fill, gap: fill && o.gapFiller && o.stacking === 'cutouts' };
}

export function rgbOf(hex: string): [number, number, number] {
  return [parseInt(hex.slice(1, 3), 16), parseInt(hex.slice(3, 5), 16), parseInt(hex.slice(5, 7), 16)];
}
