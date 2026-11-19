import { Resvg } from '@resvg/resvg-js';
import type { RawImage } from '../src/engine/types';
import { unpremultiply } from './pixels';

export interface BenchCase {
  id: string;
  preset: 'logo' | 'illustration' | 'photo' | 'cnc';
  options?: Partial<import('../src/engine/types').Options>; // ajustes específicos do caso
  svg: string; // fonte vetorial usada para gerar o raster "original" (com anti-aliasing)
}

const S = 512;
const wrap = (body: string, bg = '#ffffff') =>
  `<svg xmlns="http://www.w3.org/2000/svg" width="${S}" height="${S}" viewBox="0 0 ${S} ${S}">${bg ? `<rect width="${S}" height="${S}" fill="${bg}"/>` : ''}${body}</svg>`;


/** Glifos desenhados à mão (traços arredondados ≈ texto pequeno de ~28 px); independentes de fontes do sistema. */
const GLYPH: Record<string, string> = {
  O: '<ellipse cx="10" cy="14" rx="8" ry="12"/>',
  S: '<path d="M17 5C15 1 4 1 4 7C4 13 17 13 17 20C17 27 4 28 2 23"/>',
  R: '<path d="M3 27V2H11C19 2 19 14 11 14H3M10 14L18 27"/>',
  e: '<path d="M3 15H17C17 5 3 5 3 15C3 25 14 27 17 21"/>',
  a: '<ellipse cx="9" cy="17" rx="6" ry="7"/><path d="M15 10V27"/>',
  t: '<path d="M9 3V22C9 27 13 27 15 26M3 10H15"/>',
  n: '<path d="M3 27V10M3 14C5 8 16 8 16 16V27"/>',
  i: '<path d="M10 11V27"/><circle cx="10" cy="4" r="1.6"/>',
  o: '<ellipse cx="10" cy="18" rx="7" ry="8"/>',
  s: '<path d="M16 12C14 8 5 8 5 13C5 18 16 17 16 23C16 28 6 28 4 24"/>',
};
const textLine = (txt: string, x: number, y: number, pitch = 26) =>
  [...txt].map((ch, i) => (GLYPH[ch] ? `<g transform="translate(${x + i * pitch} ${y})">${GLYPH[ch]}</g>` : '')).join('');

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
    id: 'lineart', preset: 'logo',
    svg: wrap(`<g fill="none" stroke="#111" stroke-width="7" stroke-linecap="round"><circle cx="256" cy="256" r="170"/>
      <path d="M120 300C180 200 330 400 392 212"/><path d="M150 150L362 150L256 360Z"/></g>`),
  },
  {
    id: 'text', preset: 'logo',
    svg: wrap(`<g fill="none" stroke="#151515" stroke-width="4.5" stroke-linecap="round" stroke-linejoin="round">
      ${textLine('Resonates', 30, 40)}${textLine('Origin tens', 30, 120)}${textLine('Rotas Soninos', 30, 200, 24)}${textLine('Seis notas', 30, 280)}${textLine('onesti ose', 30, 360)}</g>`),
  },
  {
    id: 'ellipses', preset: 'logo',
    svg: wrap(`<ellipse cx="170" cy="170" rx="120" ry="60" transform="rotate(-30 170 170)" fill="#d62839"/>
      <ellipse cx="340" cy="330" rx="130" ry="52" transform="rotate(35 340 330)" fill="none" stroke="#1f6feb" stroke-width="26"/>
      <ellipse cx="120" cy="400" rx="70" ry="38" fill="#2a9d8f"/><rect x="300" y="60" width="150" height="100" rx="46" fill="#ffb703"/>
      <circle cx="420" cy="440" r="22" fill="#6d5efc"/>`),
  },
  {
    id: 'details', preset: 'logo', options: { maxColors: 12 },
    svg: wrap(`<g fill="none" stroke="#111" stroke-linecap="butt">
        <path d="M20 30L240 70" stroke-width="1.2"/><path d="M20 60L240 60" stroke-width="2"/><path d="M30 90V230" stroke-width="3"/><path d="M60 90V230" stroke-width="1.5"/>
        <path d="M90 100C130 80 170 140 230 110" stroke-width="2"/><path d="M90 130C130 110 170 170 230 140" stroke-width="1.2"/></g>
      <g fill="#111"><circle cx="270" cy="40" r="2.5"/><circle cx="290" cy="40" r="3.5"/><circle cx="315" cy="40" r="5"/>
        <rect x="340" y="34" width="6" height="6"/><rect x="360" y="34" width="12" height="12"/><rect x="390" y="30" width="10" height="10" transform="rotate(35 395 35)"/></g>
      <g fill="#c0392b"><polygon points="270,120 330,128 270,136"/><polygon points="270,160 380,164 270,168"/><polygon points="400,100 408,190 416,100"/></g>
      <g fill="#111" stroke="none"><g transform="translate(270 200) scale(.6)">${textLine('Resonates', 0, 0, 24)}</g><g transform="translate(270 230) scale(.5)">${textLine('Origin tens', 0, 0, 24)}</g></g>
      <g transform="translate(20 300)"><rect width="10" height="10" fill="#e74c3c"/><rect x="10" width="10" height="10" fill="#2980b9"/><rect x="20" width="10" height="10" fill="#27ae60"/><rect x="30" width="10" height="10" fill="#f1c40f"/>
        <rect y="10" width="10" height="10" fill="#2980b9"/><rect x="10" y="10" width="10" height="10" fill="#e74c3c"/><rect x="20" y="10" width="10" height="10" fill="#f1c40f"/><rect x="30" y="10" width="10" height="10" fill="#27ae60"/></g>
      <g fill="#111" transform="translate(120 300)"><polygon points="0,40 20,0 40,40"/><polygon points="60,40 80,4 100,40 90,40 80,20 70,40"/><path d="M130 40Q150 -10 170 40Z"/><circle cx="200" cy="20" r="14"/><circle cx="200" cy="20" r="7" fill="#fff"/></g>
      <g stroke="#111" stroke-width="1" fill="none"><path d="M20 380H240M20 400H240M20 420H240M20 440H240"/><path d="M20 380V440M60 380V440M100 380V440M140 380V440M180 380V440M220 380V440"/></g>`),
  },
  {
    id: 'stripes', preset: 'logo',
    svg: wrap(`<rect width="170" height="512" fill="#1f9d55"/><rect x="170" width="172" height="512" fill="#fff"/><rect x="342" width="170" height="512" fill="#d62839"/>
      <polygon points="0,512 512,0 512,60 60,512" fill="#ffd100" opacity="1"/>`),
  },
];

export function rasterize(svg: string, width = S): RawImage {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: width }, font: { loadSystemFonts: false } }).render();
  return { data: unpremultiply(r.pixels), width: r.width, height: r.height };
}
