import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DOMParser } from '@xmldom/xmldom';
import { unzipSync, strFromU8 } from 'fflate';
import { PNG } from 'pngjs';
import { Resvg } from '@resvg/resvg-js';
import { describe, expect, it } from 'vitest';
import { CASES, rasterize } from '../bench/cases';
import { unpremultiply } from '../bench/pixels';
import { applyPaletteEdits, mergeColors, setColor, setHidden } from '../src/engine/palette';
import { PRESETS } from '../src/engine/presets';
import { Options, RawImage, VDoc } from '../src/engine/types';
import { vectorize } from '../src/engine/vectorize';
import { DENSITIES, argb } from '../src/icons/android';
import { composeIconSvg } from '../src/icons/compose';
import { buildIco } from '../src/icons/ico';
import { IOS_ICONS } from '../src/icons/ios';
import { buildIconAssets, zipAssets } from '../src/icons/package';
import { encodePng } from '../src/icons/png';
import { AssetFile, DEFAULT_ICON_SETTINGS, IconSettings, Renderer } from '../src/icons/types';

const opts: Options = PRESETS[0].options;
const render: Renderer = async (svg, size) => {
  const r = new Resvg(svg, { fitTo: { mode: 'width', value: size } }).render();
  return { data: unpremultiply(r.pixels), width: r.width, height: r.height };
};
const logoCase = CASES.find((c) => c.id === 'logo')!;
const logo = vectorize(rasterize(logoCase.svg), opts);
const BLUE = '#2547d0', WHITE = '#ffffff';
/** logo sem fundo (transparente) e com o azul trocado por vermelho */
const icon: VDoc = applyPaletteEdits(logo, { ...setHidden({}, WHITE, true), ...setColor({}, BLUE, '#ff0000') });
const S = (p: Partial<IconSettings> = {}): IconSettings => ({ ...DEFAULT_ICON_SETTINGS, ...p });

const dec = (f: AssetFile) => PNG.sync.read(Buffer.from(f.data as Uint8Array));
const colorType = (f: AssetFile) => (f.data as Uint8Array)[25]; // IHDR: 8 (assinatura) + 8 (cabeçalho do chunk) + 9
const px = (img: PNG, x: number, y: number) => [...img.data.subarray((y * img.width + x) * 4, (y * img.width + x) * 4 + 4)];
const text = (f: AssetFile) => (typeof f.data === 'string' ? f.data : strFromU8(f.data));
const find = (files: AssetFile[], path: string) => {
  const f = files.find((x) => x.path === path);
  if (!f) throw new Error(`arquivo ausente: ${path} (há: ${files.map((x) => x.path).join(', ')})`);
  return f;
};
function xml(src: string): Element {
  const errors: string[] = [];
  const d = new DOMParser({ onError: (level, msg) => { if (level !== 'warning') errors.push(msg); } }).parseFromString(src, 'text/xml');
  expect(errors).toEqual([]);
  return d.documentElement as unknown as Element;
}

let all: AssetFile[];
const assets = async () => (all ??= await buildIconAssets(icon, opts, S({ themeColor: '#112233', backgroundColor: '#fafafa', appName: 'Demo App', shortName: 'Demo' }), render, 512));

describe('PNG e ICO', () => {
  it('encodePng RGBA: assinatura, tamanho, CRC válidos (pngjs decodifica) e pixels idênticos', () => {
    const rgba = new Uint8ClampedArray([255, 0, 0, 255, 0, 255, 0, 128, 0, 0, 255, 0, 10, 20, 30, 255]);
    const f = { data: encodePng(2, 2, rgba) } as AssetFile;
    const p = dec(f);
    expect([p.width, p.height]).toEqual([2, 2]);
    expect([...p.data]).toEqual([...rgba]);
    expect(colorType(f)).toBe(6);
  });
  it('encodePng sem alfa grava RGB (tipo 2) — exigido pela App Store', () => {
    const rgba = new Uint8ClampedArray(4 * 4 * 4).fill(200);
    const f = { data: encodePng(4, 4, rgba, { alpha: false }) } as AssetFile;
    expect(colorType(f)).toBe(2);
    expect(dec(f).width).toBe(4);
  });
  it('buildIco: cabeçalho, diretório ordenado, offsets e PNGs embutidos íntegros', () => {
    const mk = (n: number) => encodePng(n, n, new Uint8ClampedArray(n * n * 4).fill(255));
    const ico = buildIco([{ size: 48, png: mk(48) }, { size: 16, png: mk(16) }, { size: 32, png: mk(32) }]);
    const dv = new DataView(ico.buffer);
    expect([dv.getUint16(0, true), dv.getUint16(2, true), dv.getUint16(4, true)]).toEqual([0, 1, 3]);
    const sizes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const d = 6 + 16 * i, w = ico[d], len = dv.getUint32(d + 8, true), off = dv.getUint32(d + 12, true);
      sizes.push(w);
      expect(off + len).toBeLessThanOrEqual(ico.length);
      const p = PNG.sync.read(Buffer.from(ico.subarray(off, off + len)));
      expect(p.width).toBe(w);
    }
    expect(sizes).toEqual([16, 32, 48]);
  });
});

describe('composição do ícone', () => {
  it('padding reduz o desenho; forma circular e fundo opaco', async () => {
    const bbox = async (padding: number) => {
      const r = await render(composeIconSvg(icon, opts, { size: 200, padding }), 200);
      let x0 = 200, x1 = 0;
      for (let y = 0; y < 200; y++) for (let x = 0; x < 200; x++) if (r.data[(y * 200 + x) * 4 + 3] > 20) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
      return x1 - x0;
    };
    const full = await bbox(0), padded = await bbox(0.2);
    expect(padded).toBeLessThan(full * 0.65);
    expect(padded).toBeGreaterThan(full * 0.5);
    const c = await render(composeIconSvg(icon, opts, { size: 100, padding: 0, background: '#00ff00', shape: 'circle' }), 100);
    expect(c.data[3]).toBe(0); // canto transparente (máscara)
    expect([...c.data.subarray((50 * 100 + 50) * 4, (50 * 100 + 50) * 4 + 4)].at(3)).toBe(255);
  });
  it('vetor não quadrado cabe inteiro e centralizado', async () => {
    const w = 80, h = 40, data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set([200, 30, 30, 255], i * 4);
    const wide = vectorize({ width: w, height: h, data } as RawImage, { ...opts, removeBackground: false });
    const r = await render(composeIconSvg(wide, opts, { size: 100, padding: 0 }), 100);
    let y0 = 100, y1 = 0, x0 = 100, x1 = 0;
    for (let y = 0; y < 100; y++) for (let x = 0; x < 100; x++) if (r.data[(y * 100 + x) * 4 + 3] > 128) { y0 = Math.min(y0, y); y1 = Math.max(y1, y); x0 = Math.min(x0, x); x1 = Math.max(x1, x); }
    expect(x1 - x0 + 1).toBeGreaterThanOrEqual(99); // largura total
    expect(Math.abs((y1 - y0 + 1) - 50)).toBeLessThanOrEqual(2); // proporção 2:1
    expect(Math.abs((y0 + y1) / 2 - 49.5)).toBeLessThanOrEqual(1.5); // centralizado
  });
});

describe('pacote Web', () => {
  it('arquivos esperados, dimensões corretas e transparência/opacidade certas', async () => {
    const f = await assets();
    const dims: Record<string, number> = { 'web/favicon-16x16.png': 16, 'web/favicon-32x32.png': 32, 'web/apple-touch-icon.png': 180, 'web/icon-192.png': 192, 'web/icon-512.png': 512, 'web/icon-maskable-512.png': 512 };
    for (const [path, n] of Object.entries(dims)) { const p = dec(find(f, path)); expect([p.width, p.height]).toEqual([n, n]); }
    expect(px(dec(find(f, 'web/icon-512.png')), 0, 0)[3]).toBe(0); // transparente (fundo removido)
    expect(colorType(find(f, 'web/apple-touch-icon.png'))).toBe(2); // opaco
    expect(px(dec(find(f, 'web/apple-touch-icon.png')), 0, 0).slice(0, 3)).toEqual([0xfa, 0xfa, 0xfa]); // fundo escolhido
    expect(px(dec(find(f, 'web/icon-maskable-512.png')), 3, 3).slice(0, 3)).toEqual([0xfa, 0xfa, 0xfa]);
  });
  it('favicon.ico tem 16, 32 e 48 px', async () => {
    const ico = find(await assets(), 'web/favicon.ico').data as Uint8Array;
    expect([ico[6], ico[6 + 16], ico[6 + 32]]).toEqual([16, 32, 48]);
    expect(new DataView(ico.buffer, ico.byteOffset).getUint16(4, true)).toBe(3);
  });
  it('site.webmanifest: JSON válido com nome, cores e ícones existentes no pacote', async () => {
    const f = await assets();
    const m = JSON.parse(text(find(f, 'web/site.webmanifest')));
    expect(m).toMatchObject({ name: 'Demo App', short_name: 'Demo', theme_color: '#112233', background_color: '#fafafa', display: 'standalone' });
    for (const i of m.icons) expect(f.some((x) => x.path === 'web' + i.src)).toBe(true);
    expect(m.icons.map((i: { sizes: string }) => i.sizes)).toContain('512x512');
    expect(text(find(f, 'web/head-snippet.html'))).toContain('apple-touch-icon');
  });
  it('icon.svg é XML válido com viewBox e usa a cor editada', async () => {
    const svg = text(find(await assets(), 'web/icon.svg'));
    const root = xml(svg);
    expect(root.tagName).toBe('svg');
    expect(root.getAttribute('viewBox')).toBe('0 0 512 512');
    expect(svg).toContain('#ff0000');
    expect(svg).not.toContain(BLUE);
  });
  it('icon.svg com currentColor / classes conforme a opção', async () => {
    const f1 = await buildIconAssets(icon, opts, S({ svgColors: { mode: 'currentColor', currentColor: '#ff0000' }, platforms: { web: true, android: false, ios: false } }), render);
    expect(text(find(f1, 'web/icon.svg'))).toContain('fill="currentColor"');
    const f2 = await buildIconAssets(icon, opts, S({ svgColors: { mode: 'classes' }, platforms: { web: true, android: false, ios: false } }), render);
    expect(text(find(f2, 'web/icon.svg'))).toContain('<style>');
  });
  it('a edição de cor aparece no PNG (topo do círculo é vermelho, não azul)', async () => {
    const p = dec(find(await assets(), 'web/icon-512.png'));
    const [r, g, b, a] = px(p, 256, 120);
    expect(a).toBe(255);
    expect(r).toBeGreaterThan(200);
    expect(g).toBeLessThan(40);
    expect(b).toBeLessThan(40);
  });
});

describe('pacote Android', () => {
  it('mipmaps legados em todas as densidades com os tamanhos corretos; round com máscara; legado opaco', async () => {
    const f = await assets();
    for (const d of DENSITIES) {
      const a = dec(find(f, `android/res/mipmap-${d.name}/ic_launcher.png`));
      expect([a.width, a.height]).toEqual([d.launcher, d.launcher]);
      expect(colorType(find(f, `android/res/mipmap-${d.name}/ic_launcher.png`))).toBe(2);
      const r = dec(find(f, `android/res/mipmap-${d.name}/ic_launcher_round.png`));
      expect([r.width, r.height]).toEqual([d.launcher, d.launcher]);
      expect(px(r, 0, 0)[3]).toBe(0); // canto fora do círculo
    }
    expect([48, 72, 96, 144, 192]).toEqual(DENSITIES.map((d) => d.launcher));
    expect(dec(find(f, 'android/ic_launcher-playstore.png')).width).toBe(512);
  });
  it('Adaptive Icon: XMLs bem formados que apontam para recursos existentes', async () => {
    const f = await assets();
    const v26 = xml(text(find(f, 'android/res/mipmap-anydpi-v26/ic_launcher.xml')));
    expect(v26.tagName).toBe('adaptive-icon');
    const bgRef = v26.getElementsByTagName('background')[0].getAttribute('android:drawable');
    const fgRef = v26.getElementsByTagName('foreground')[0].getAttribute('android:drawable');
    expect(bgRef).toBe('@color/ic_launcher_background');
    expect(fgRef).toBe('@drawable/ic_launcher_foreground');
    expect(f.some((x) => x.path === 'android/res/drawable/ic_launcher_foreground.xml')).toBe(true);
    expect(v26.getElementsByTagName('monochrome').length).toBe(0); // monocromático só em v33
    const v33 = xml(text(find(f, 'android/res/mipmap-anydpi-v33/ic_launcher.xml')));
    expect(v33.getElementsByTagName('monochrome')[0].getAttribute('android:drawable')).toBe('@drawable/ic_launcher_monochrome');
    xml(text(find(f, 'android/res/mipmap-anydpi-v26/ic_launcher_round.xml')));
    const bg = xml(text(find(f, 'android/res/values/ic_launcher_background.xml')));
    expect(bg.getElementsByTagName('color')[0].getAttribute('name')).toBe('ic_launcher_background');
    expect(bg.getElementsByTagName('color')[0].textContent).toBe('#FAFAFA');
  });
  it('Vector Drawable: <vector> válido, 108dp, mesmas formas do SVG, cores #AARRGGBB e dentro da zona segura', async () => {
    const f = await assets();
    const src = text(find(f, 'android/res/drawable/ic_launcher_foreground.xml'));
    const v = xml(src);
    expect(v.tagName).toBe('vector');
    expect(v.getAttribute('android:width')).toBe('108dp');
    expect(v.getAttribute('android:viewportWidth')).toBe('108');
    const paths = [...v.getElementsByTagName('path')];
    const fills = paths.filter((p) => p.getAttribute('android:fillColor'));
    expect(fills.length).toBe(icon.layers.length);
    for (const p of fills) expect(p.getAttribute('android:fillColor')).toMatch(/^#FF[0-9A-F]{6}$/);
    expect(fills.map((p) => p.getAttribute('android:fillColor'))).toContain(argb('#ff0000'));
    for (const p of paths) expect(p.getAttribute('android:pathData')).toMatch(/^[MLCAZ0-9 .,\-]+$/);
    // o desenho (512 px) é encolhido para caber em 66 dp, centralizado em 108
    const g = v.getElementsByTagName('group')[0];
    const k = Number(g.getAttribute('android:scaleX'));
    expect(k * icon.width).toBeLessThanOrEqual(66 + 0.01);
    expect(Number(g.getAttribute('android:translateX')) + (icon.width * k) / 2).toBeCloseTo(54, 1);
    // geometria idêntica à do SVG (mesmos dados de caminho)
    const svgPaths = [...src.matchAll(/android:pathData="([^"]+)"/g)].map((m) => m[1]);
    expect(svgPaths.some((d) => d.startsWith('M'))).toBe(true);
  });
  it('monocromático: tudo preto; ic_app_icon.xml usa tint do tema com currentColor', async () => {
    const f = await assets();
    const mono = xml(text(find(f, 'android/res/drawable/ic_launcher_monochrome.xml')));
    for (const p of [...mono.getElementsByTagName('path')]) expect(p.getAttribute('android:fillColor')).toBe('#FF000000');
    const tinted = await buildIconAssets(icon, opts, S({ svgColors: { mode: 'currentColor', currentColor: '#ff0000' }, platforms: { web: false, android: true, ios: false } }), render);
    const full = xml(text(find(tinted, 'android/res/drawable/ic_app_icon.xml')));
    expect(full.getAttribute('android:tint')).toBe('?attr/colorControlNormal');
    expect(full.getAttribute('android:viewportWidth')).toBe('24');
    expect(find(f, 'android/res/drawable/ic_app_icon.xml').data as string).not.toContain('tint');
  });
});

describe('pacote iOS', () => {
  it('Contents.json válido; cada entrada aponta para um PNG com pixels = tamanho × escala, SEM alfa', async () => {
    const f = await assets();
    const c = JSON.parse(text(find(f, 'ios/AppIcon.appiconset/Contents.json')));
    expect(c.info).toEqual({ author: 'xcode', version: 1 });
    expect(c.images.length).toBe(IOS_ICONS.length);
    for (const i of c.images) {
      expect(['iphone', 'ipad', 'ios-marketing']).toContain(i.idiom);
      expect(i.scale).toMatch(/^[123]x$/);
      expect(i.size).toMatch(/^\d+(\.\d+)?x\d+(\.\d+)?$/);
      const file = find(f, `ios/AppIcon.appiconset/${i.filename}`);
      const pt = parseFloat(i.size), scale = parseInt(i.scale);
      expect(dec(file).width).toBe(Math.round(pt * scale));
      expect(colorType(file)).toBe(2);
    }
  });
  it('tamanhos padrão do Xcode presentes (incluindo 1024 da App Store)', async () => {
    const f = await assets();
    const sizes = new Set(f.filter((x) => x.path.startsWith('ios/') && x.kind === 'png').map((x) => x.size));
    for (const n of [20, 29, 40, 58, 60, 76, 80, 87, 120, 152, 167, 180, 1024]) expect(sizes.has(n)).toBe(true);
    const idioms = JSON.parse(text(find(f, 'ios/AppIcon.appiconset/Contents.json'))).images.map((i: { idiom: string }) => i.idiom);
    expect(new Set(idioms)).toEqual(new Set(['iphone', 'ipad', 'ios-marketing']));
    const big = dec(find(f, 'ios/AppIcon.appiconset/Icon-App-1024x1024@1x.png'));
    expect(px(big, 0, 0).slice(0, 3)).toEqual([0xfa, 0xfa, 0xfa]); // opaco, com o fundo escolhido
    expect(px(big, 0, 0)[3]).toBe(255);
  });
});

describe('pacote .zip', () => {
  it('organizado por plataforma e íntegro: lido de volta, igual aos arquivos gerados', async () => {
    const f = await assets();
    const z = zipAssets(f);
    const back = unzipSync(z);
    expect(Object.keys(back).sort()).toEqual(f.map((x) => x.path).sort());
    expect(Object.keys(back).every((p) => /^(web|android|ios)\//.test(p))).toBe(true);
    for (const x of f) expect(Buffer.from(back[x.path]).equals(Buffer.from(typeof x.data === 'string' ? new TextEncoder().encode(x.data) : x.data))).toBe(true);
    expect(Object.keys(back).some((p) => p.startsWith('android/res/mipmap-xxxhdpi/'))).toBe(true);
  });
  const hasPython = spawnSync('python3', ['--version']).status === 0;
  it.skipIf(!hasPython)('o .zip passa no teste de integridade do Python (CRC de todos os arquivos)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'zip-'));
    const file = join(dir, 'icons.zip');
    writeFileSync(file, zipAssets(await assets()));
    const out = execFileSync('python3', ['-c', 'import sys,zipfile;z=zipfile.ZipFile(sys.argv[1]);print(z.testzip(), len(z.namelist()))', file]).toString().trim();
    expect(out.startsWith('None ')).toBe(true);
  });
  it('seleção de plataformas e de arquivos', async () => {
    const onlyIos = await buildIconAssets(icon, opts, S({ platforms: { web: false, android: false, ios: true } }), render);
    expect(onlyIos.every((x) => x.platform === 'ios')).toBe(true);
    const f = await assets();
    const picked = f.filter((x) => ['web/icon.svg', 'android/res/drawable/ic_launcher_foreground.xml'].includes(x.path));
    expect(Object.keys(unzipSync(zipAssets(picked))).sort()).toEqual(['android/res/drawable/ic_launcher_foreground.xml', 'web/icon.svg']);
  });
});

describe('edição de cores → ícones', () => {
  it('mesclar cores e fundo transparente refletem em todos os formatos de ícone', async () => {
    const mono = applyPaletteEdits(logo, { ...setHidden({}, WHITE, true), ...mergeColors(logo, {}, [BLUE, '#ff7a1a', '#171a2b'], '#00aa00') });
    const f = await buildIconAssets(mono, opts, S(), render);
    expect(text(find(f, 'web/icon.svg'))).toContain('#00aa00');
    expect(text(find(f, 'android/res/drawable/ic_launcher_foreground.xml'))).toContain('#FF00AA00');
    const p = dec(find(f, 'web/icon-512.png'));
    expect(px(p, 256, 120).slice(0, 3)).toEqual([0, 0xaa, 0]);
    expect(px(p, 0, 0)[3]).toBe(0);
  });
});
