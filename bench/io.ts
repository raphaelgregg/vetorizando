import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { Resvg } from '@resvg/resvg-js';
import type { RawImage } from '../src/engine/types';
import { unpremultiply } from './pixels';

/** Decodifica PNG/JPG para RGBA. */
export function readRaster(path: string): RawImage {
  const buf = readFileSync(path);
  if (/\.png$/i.test(path)) {
    const p = PNG.sync.read(buf);
    return { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height };
  }
  if (/\.jpe?g$/i.test(path)) {
    const j = jpeg.decode(buf, { useTArray: true });
    return { data: new Uint8ClampedArray(j.data), width: j.width, height: j.height };
  }
  throw new Error(`formato não suportado: ${path} (use PNG ou JPG)`);
}

/** Renderiza um SVG qualquer na largura pedida, com transparência preservada. */
export function renderSvg(svg: string, width: number): RawImage {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render();
  return { data: unpremultiply(r.pixels), width: r.width, height: r.height };
}
