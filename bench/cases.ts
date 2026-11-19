import { Resvg } from '@resvg/resvg-js';
import type { RawImage } from '../src/engine/types';

export interface BenchCase {
  id: string;
  preset: 'logo' | 'illustration' | 'photo' | 'cnc';
  svg: string; // fonte vetorial usada para gerar o raster "original" (com anti-aliasing)
}

const S = 512;
const wrap = (body: string, bg = '#ffffff') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${bg ? `<rect width="${S}" height="${S}" fill="${bg}"/>` : ''}${body}</svg>`;

export const CASES: BenchCase[] = [
  {
    id: 'logo', preset: 'logo',
    svg: wrap(`<circle cx="256" cy="215" r="154" fill="#2547d0"/>
      <polygon points="169,154 256,307 343,154 297,154 256,236 215,154" fill="#fff"/>
      <circle cx="380" cy="102" r="31" fill="#ff7a1a"/>
      <rect x="130" y="420" width="40" height="60" fill="#171a2b"/><rect x="190" y="420" width="40" height="60" rx="20" fill="#171a2b"/>
      <rect x="250" y="420" width="132" height="14" fill="#171a2b"/><rect x="250" y="466" width="132" height="14" fill="#171a2b"/>`),
  },
  {
    id: 'icon', preset: 'logo',
    svg: wrap(`<rect x="41" y="41" width="430" height="430" rx="102" fill="#6d5efc"/>
      <polygon fill="#ffd34d" points="256,106 295,205 401,211 319,278 345,381 256,324 167,381 193,278 111,211 217,205"/>`, ''),
  },
  {
    id: 'illustration', preset: 'illustration',
    svg: wrap(`<defs><linearGradient id="g" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#2b2f77"/><stop offset=".55" stop-color="#e5566d"/><stop offset="1" stop-color="#ffc371"/></linearGradient></defs>
      <rect width="512" height="512" fill="url(#g)"/><circle cx="338" cy="256" r="66" fill="#fff3c4"/>
      <path d="M0 384C102 282 205 410 307 338C410 282 461 358 512 328L512 512L0 512Z" fill="#3b2a5a"/>
      <path d="M0 451C154 379 307 492 512 420L512 512L0 512Z" fill="#1b1237"/>`, ''),
  },
  {
    id: 'photo', preset: 'photo',
    svg: wrap(`<defs>${[['a', '#ff5d73'], ['b', '#38d6c0'], ['c', '#ffd166'], ['d', '#7b61ff']].map(([i, c]) => `<radialGradient id="${i}"><stop offset="0" stop-color="${c}"/><stop offset="1" stop-color="${c}" stop-opacity="0"/></radialGradient>`).join('')}</defs>
      <circle cx="154" cy="179" r="205" fill="url(#a)"/><circle cx="358" cy="154" r="179" fill="url(#b)"/>
      <circle cx="282" cy="369" r="230" fill="url(#c)"/><circle cx="102" cy="410" r="154" fill="url(#d)"/>`, '#10243a'),
  },
  {
    id: 'lineart', preset: 'cnc',
    svg: wrap(`<g fill="none" stroke="#111" stroke-width="7" stroke-linecap="round"><circle cx="256" cy="256" r="170"/>
      <path d="M120 300C180 200 330 400 392 212"/><path d="M150 150L362 150L256 360Z"/></g>`),
  },
  {
    id: 'stripes', preset: 'logo',
    svg: wrap(`<rect width="170" height="512" fill="#1f9d55"/><rect x="170" width="172" height="512" fill="#fff"/><rect x="342" width="170" height="512" fill="#d62839"/>
      <polygon points="0,512 512,0 512,60 60,512" fill="#ffd100" opacity="1"/>`),
  },
];

export function rasterize(svg: string, width = S): RawImage {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } }).render();
  return { data: new Uint8ClampedArray(r.pixels), width: r.width, height: r.height };
}
