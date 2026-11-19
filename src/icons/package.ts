import { strToU8, zipSync, type Zippable } from 'fflate';
import { toSVG } from '../engine/svg';
import type { Options, VDoc } from '../engine/types';
import { DENSITIES, adaptiveIconXml, backgroundColorXml, vectorDrawable } from './android';
import { composeIconSvg } from './compose';
import { buildIco } from './ico';
import { IOS_ICONS, contentsJson } from './ios';
import { encodePng } from './png';
import type { AssetFile, IconSettings, Platform, Renderer } from './types';
import { headSnippet, webManifest } from './web';


interface Variant { size: number; padding: number; background: string | null; shape: 'square' | 'circle' | 'rounded'; alpha: boolean }

/** Gera todos os arquivos de ícone (Web, Android, iOS) a partir do vetor já editado. */
export async function buildIconAssets(doc: VDoc, o: Options, s: IconSettings, render: Renderer, origW = doc.width): Promise<AssetFile[]> {
  const files: AssetFile[] = [];
  const cache = new Map<string, Uint8Array>();

  const png = async (v: Variant): Promise<Uint8Array> => {
    const key = JSON.stringify(v);
    const hit = cache.get(key);
    if (hit) return hit;
    // os ícones raster usam cores fixas (hex), mesmo que o SVG use currentColor/classes
    const svg = composeIconSvg(doc, o, { size: v.size, padding: v.padding, background: v.background, shape: v.shape });
    const img = await render(svg, v.size);
    const out = encodePng(img.width, img.height, img.data, { alpha: v.alpha });
    cache.set(key, out);
    return out;
  };
  const add = (f: AssetFile) => files.push(f);
  const bg = s.backgroundColor;
  const T = (size: number, padding = s.padding): Variant => ({ size, padding, background: null, shape: 'square', alpha: true });
  const O = (size: number, padding = s.padding, shape: Variant['shape'] = 'square'): Variant => ({ size, padding, background: bg, shape, alpha: shape !== 'square' ? true : false });

  if (s.platforms.web) {
    const ico = [16, 32, 48];
    const icoPngs = await Promise.all(ico.map((n) => png(T(n, 0))));
    add({ path: 'web/favicon.ico', platform: 'web', kind: 'ico', data: buildIco(ico.map((size, i) => ({ size, png: icoPngs[i] }))), note: 'favicon.ico com 16, 32 e 48 px' });
    add({ path: 'web/icon.svg', platform: 'web', kind: 'svg', data: toSVG(doc, o, { width: origW }, s.svgColors), note: 'ícone vetorial (favicon moderno)' });
    add({ path: 'web/favicon-16x16.png', platform: 'web', kind: 'png', size: 16, data: await png(T(16, 0)), note: 'favicon 16×16' });
    add({ path: 'web/favicon-32x32.png', platform: 'web', kind: 'png', size: 32, data: await png(T(32, 0)), note: 'favicon 32×32' });
    add({ path: 'web/apple-touch-icon.png', platform: 'web', kind: 'png', size: 180, data: await png({ ...O(180), alpha: false }), note: 'apple-touch-icon 180×180 (opaco)' });
    add({ path: 'web/icon-192.png', platform: 'web', kind: 'png', size: 192, data: await png(T(192)), note: 'PWA / Android Chrome 192×192' });
    add({ path: 'web/icon-512.png', platform: 'web', kind: 'png', size: 512, data: await png(T(512)), note: 'PWA 512×512' });
    add({ path: 'web/icon-maskable-512.png', platform: 'web', kind: 'png', size: 512, data: await png({ ...O(512, Math.max(0.2, s.padding)), alpha: false }), note: 'PWA maskable 512×512 (zona segura 80%)' });
    add({ path: 'web/site.webmanifest', platform: 'web', kind: 'json', data: webManifest(s), note: 'base do manifest PWA' });
    add({ path: 'web/head-snippet.html', platform: 'web', kind: 'html', data: headSnippet(s), note: 'trecho para o <head>' });
  }

  if (s.platforms.android) {
    for (const d of DENSITIES) {
      add({ path: `android/res/mipmap-${d.name}/ic_launcher.png`, platform: 'android', kind: 'png', size: d.launcher, data: await png({ ...O(d.launcher), alpha: false }), note: `ícone legado ${d.name} (${d.launcher}px)` });
      add({ path: `android/res/mipmap-${d.name}/ic_launcher_round.png`, platform: 'android', kind: 'png', size: d.launcher, data: await png(O(d.launcher, s.padding, 'circle')), note: `ícone redondo ${d.name} (${d.launcher}px)` });
    }
    add({ path: 'android/res/mipmap-anydpi-v26/ic_launcher.xml', platform: 'android', kind: 'xml', data: adaptiveIconXml(false), note: 'Adaptive Icon (API 26+)' });
    add({ path: 'android/res/mipmap-anydpi-v26/ic_launcher_round.xml', platform: 'android', kind: 'xml', data: adaptiveIconXml(false), note: 'Adaptive Icon redondo (API 26+)' });
    add({ path: 'android/res/mipmap-anydpi-v33/ic_launcher.xml', platform: 'android', kind: 'xml', data: adaptiveIconXml(true), note: 'Adaptive Icon com camada monocromática (Android 13+)' });
    add({ path: 'android/res/values/ic_launcher_background.xml', platform: 'android', kind: 'xml', data: backgroundColorXml(bg), note: 'cor de fundo do Adaptive Icon' });
    // camada de primeiro plano de 108dp; o desenho cabe na zona segura de 66dp
    add({ path: 'android/res/drawable/ic_launcher_foreground.xml', platform: 'android', kind: 'xml', data: vectorDrawable(doc, o, { dp: 108, viewport: 108, box: 66 }), note: 'Vector Drawable (foreground do Adaptive Icon, 108dp)' });
    add({ path: 'android/res/drawable/ic_launcher_monochrome.xml', platform: 'android', kind: 'xml', data: vectorDrawable(doc, o, { dp: 108, viewport: 108, box: 66, forceColor: '#000000' }), note: 'Vector Drawable monocromático (ícone temático)' });
    add({ path: 'android/res/drawable/ic_app_icon.xml', platform: 'android', kind: 'xml', data: vectorDrawable(doc, o, { dp: 24, viewport: 24, colors: s.svgColors }), note: 'Vector Drawable do ícone inteiro (24dp, uso geral no app)' });
    add({ path: 'android/ic_launcher-playstore.png', platform: 'android', kind: 'png', size: 512, data: await png({ ...O(512), alpha: false }), note: 'Google Play 512×512' });
  }

  if (s.platforms.ios) {
    const seen = new Map<number, Uint8Array>();
    const written = new Set<string>(); // iPhone e iPad compartilham alguns arquivos (ex.: 20pt@2x): um PNG, duas entradas no Contents.json
    for (const i of IOS_ICONS) {
      if (written.has(i.filename)) continue;
      written.add(i.filename);
      let data = seen.get(i.pixels);
      if (!data) { data = await png({ ...O(i.pixels), alpha: false }); seen.set(i.pixels, data); }
      add({ path: `ios/AppIcon.appiconset/${i.filename}`, platform: 'ios', kind: 'png', size: i.pixels, data, note: `${i.idiom} ${i.size}pt @${i.scale}x (${i.pixels}px, sem alfa)` });
    }
    add({ path: 'ios/AppIcon.appiconset/Contents.json', platform: 'ios', kind: 'json', data: contentsJson(), note: 'catálogo do Xcode' });
  }

  for (const [platform, text] of [
    ['web', 'Copie os arquivos para a raiz do site e cole head-snippet.html no <head>.\n'],
    ['android', 'Copie a pasta res/ para app/src/main/res/ (mescle com a existente).\nNo AndroidManifest.xml: android:icon="@mipmap/ic_launcher" android:roundIcon="@mipmap/ic_launcher_round".\ndrawable/ic_app_icon.xml é o ícone completo para usar dentro do app.\n'],
    ['ios', 'Arraste AppIcon.appiconset para Assets.xcassets no Xcode (substitua o existente).\nOs PNGs não têm canal alfa, como a App Store exige.\n'],
  ] as [Platform, string][]) {
    if (s.platforms[platform]) add({ path: `${platform}/LEIAME.txt`, platform, kind: 'txt', data: text, note: 'instruções de uso' });
  }
  return files;
}

/** Empacota em .zip, organizado por plataforma (web/, android/, ios/). PNG/ICO já vêm comprimidos: sem recompressão. */
export function zipAssets(files: AssetFile[]): Uint8Array {
  const z: Zippable = {};
  for (const f of files) {
    const bytes = typeof f.data === 'string' ? strToU8(f.data) : f.data;
    z[f.path] = [bytes, { level: f.kind === 'png' || f.kind === 'ico' ? 0 : 6 }];
  }
  return zipSync(z);
}
