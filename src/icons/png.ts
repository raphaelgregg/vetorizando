import { zlibSync } from 'fflate';

const TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

export function crc32(buf: Uint8Array, start = 0, end = buf.length): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

const u32 = (n: number) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  out.set(u32(data.length), 0);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  out.set(u32(crc32(out, 4, 8 + data.length)), 8 + data.length);
  return out;
}

export interface PngOptions {
  /** true (padrão): RGBA. false: RGB SEM canal alfa (iOS exige ícone opaco, sem alfa). */
  alpha?: boolean;
}

/** Codifica PNG 8 bits (RGBA ou RGB) a partir de pixels RGBA não pré-multiplicados. */
export function encodePng(width: number, height: number, rgba: Uint8ClampedArray | Uint8Array, opts: PngOptions = {}): Uint8Array {
  const alpha = opts.alpha !== false;
  const bpp = alpha ? 4 : 3;
  const raw = new Uint8Array((width * bpp + 1) * height);
  for (let y = 0; y < height; y++) {
    const o = y * (width * bpp + 1);
    raw[o] = 0; // filtro "None"
    for (let x = 0; x < width; x++) {
      const s = (y * width + x) * 4, d = o + 1 + x * bpp;
      raw[d] = rgba[s]; raw[d + 1] = rgba[s + 1]; raw[d + 2] = rgba[s + 2];
      if (alpha) raw[d + 3] = rgba[s + 3];
    }
  }
  const ihdr = new Uint8Array(13);
  ihdr.set(u32(width), 0); ihdr.set(u32(height), 4);
  ihdr[8] = 8; ihdr[9] = alpha ? 6 : 2; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const parts = [new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', zlibSync(raw, { level: 9 })), chunk('IEND', new Uint8Array(0))];
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}
