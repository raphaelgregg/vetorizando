import { readFileSync } from 'node:fs';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { Resvg } from '@resvg/resvg-js';
import type { RawImage } from '../src/engine/types';
import { unpremultiply } from './pixels';

/** Orientação EXIF (1–8) de um JPEG, ou 1 se não houver. */
export function exifOrientation(buf: Uint8Array): number {
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return 1;
  let i = 2;
  while (i + 4 < buf.length && buf[i] === 0xff) {
    const marker = buf[i + 1], len = (buf[i + 2] << 8) | buf[i + 3];
    if (marker === 0xe1 && buf[i + 4] === 0x45 && buf[i + 5] === 0x78 && buf[i + 6] === 0x69 && buf[i + 7] === 0x66) {
      const t = i + 10; // início do cabeçalho TIFF
      const le = buf[t] === 0x49;
      const u16 = (o: number) => (le ? buf[o] | (buf[o + 1] << 8) : (buf[o] << 8) | buf[o + 1]);
      const u32 = (o: number) => (le ? (buf[o] | (buf[o + 1] << 8) | (buf[o + 2] << 16) | (buf[o + 3] << 24)) >>> 0 : ((buf[o] << 24) | (buf[o + 1] << 16) | (buf[o + 2] << 8) | buf[o + 3]) >>> 0);
      const ifd = t + u32(t + 4), n = u16(ifd);
      for (let k = 0; k < n; k++) { const e = ifd + 2 + 12 * k; if (u16(e) === 0x0112) return u16(e + 8) || 1; }
      return 1;
    }
    if (marker === 0xda) break;
    i += 2 + len;
  }
  return 1;
}

/** Aplica a orientação EXIF (como o navegador faz ao abrir a imagem na UI). */
export function applyOrientation(img: RawImage, o: number): RawImage {
  if (o <= 1 || o > 8) return img;
  const { width: w, height: h } = img;
  const swap = o >= 5;
  const W = swap ? h : w, H = swap ? w : h;
  const out = new Uint8ClampedArray(W * H * 4);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx = x, ny = y;
      switch (o) {
        case 2: nx = w - 1 - x; break;
        case 3: nx = w - 1 - x; ny = h - 1 - y; break;
        case 4: ny = h - 1 - y; break;
        case 5: nx = y; ny = x; break;
        case 6: nx = h - 1 - y; ny = x; break;
        case 7: nx = h - 1 - y; ny = w - 1 - x; break;
        case 8: nx = y; ny = w - 1 - x; break;
      }
      out.set(img.data.subarray((y * w + x) * 4, (y * w + x) * 4 + 4), (ny * W + nx) * 4);
    }
  }
  return { data: out, width: W, height: H };
}

export interface RasterInfo { image: RawImage; orientation: number }

/** Decodifica PNG/JPG para RGBA (JPEG: aplica a orientação EXIF). */
export function readRasterInfo(path: string): RasterInfo {
  const buf = readFileSync(path);
  if (/\.png$/i.test(path)) {
    const p = PNG.sync.read(buf);
    return { image: { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height }, orientation: 1 };
  }
  if (/\.jpe?g$/i.test(path)) {
    const j = jpeg.decode(buf, { useTArray: true });
    const orientation = exifOrientation(buf);
    return { image: applyOrientation({ data: new Uint8ClampedArray(j.data), width: j.width, height: j.height }, orientation), orientation };
  }
  throw new Error(`formato não suportado: ${path} (use PNG ou JPG)`);
}

/** Decodifica PNG/JPG para RGBA. */
export function readRaster(path: string): RawImage {
  return readRasterInfo(path).image;
}

/** Renderiza um SVG qualquer na largura pedida, com transparência preservada. */
export function renderSvg(svg: string, width: number): RawImage {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render();
  return { data: unpremultiply(r.pixels), width: r.width, height: r.height };
}
