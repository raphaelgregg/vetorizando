import { strToU8, zipSync, type Zippable } from 'fflate';
import { AUTO_PARAMS, EnhanceParams, NEUTRAL, OutputSpec } from '../enhance/ops';
import { PLATFORMS, PROFILE_PACK, SOCIAL_PRESETS, SocialPreset, presetById } from '../enhance/social';
import type { RawImage } from '../engine/types';
import { encodePng } from '../icons/png';
import { EnhanceClient } from './enhanceClient';
import { Loaded, decodeFull } from './loader';
import type { Viewer } from './viewer';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Format = 'png' | 'jpeg' | 'webp';
const MIME: Record<Format, string> = { png: 'image/png', jpeg: 'image/jpeg', webp: 'image/webp' };
const EXT: Record<Format, string> = { png: 'png', jpeg: 'jpg', webp: 'webp' };

interface State {
  params: EnhanceParams;
  preset: string; // id de SOCIAL_PRESETS · 'original' · 'custom'
  cw: number;
  ch: number;
  fit: 'cover' | 'contain';
  fx: number;
  fy: number;
  bg: string;
  transparent: boolean;
  circle: boolean; // aplicar recorte circular na exportação
  guide: boolean; // mostrar guia circular na prévia
  format: Format;
  quality: number;
}

const slug = (s: string) => s.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');

function toBlob(img: RawImage, format: Format, quality: number): Promise<Blob> {
  if (format === 'png') return Promise.resolve(new Blob([encodePng(img.width, img.height, img.data) as BlobPart], { type: MIME.png }));
  const c = document.createElement('canvas');
  c.width = img.width; c.height = img.height;
  const g = c.getContext('2d')!;
  if (format === 'jpeg') { g.fillStyle = '#ffffff'; g.fillRect(0, 0, c.width, c.height); } // JPEG não tem transparência
  const tmp = document.createElement('canvas');
  tmp.width = img.width; tmp.height = img.height;
  tmp.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
  g.drawImage(tmp, 0, 0);
  return new Promise((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new Error('Formato não suportado neste navegador'))), MIME[format], quality));
}

const blobUrlOf = (img: RawImage): Promise<string> => toBlob(img, 'png', 1).then((b) => URL.createObjectURL(b));

/** Modo "Melhorar imagem": ajustes de cor/ruído/nitidez + tamanhos de redes sociais; exporta PNG (ou JPG/WebP) e pacote ZIP. */
export function initEnhance(viewer: Viewer, showMsg: (t: string) => void) {
  const st: State = { params: { ...AUTO_PARAMS }, preset: 'ig-profile', cw: 1080, ch: 1080, fit: 'cover', fx: 0.5, fy: 0.5, bg: '#ffffff', transparent: false, circle: false, guide: true, format: 'png', quality: 0.92 };
  let loaded: Loaded | null = null;
  let full: Promise<RawImage> | null = null;
  const preview = new EnhanceClient();
  const exporter = new EnhanceClient();
  let urls: string[] = [];
  let timer = 0;
  const pack = new Set(PROFILE_PACK);

  const setProg = (f: number, label: string) => { $('eprog').querySelector<HTMLElement>('i')!.style.width = `${Math.round(f * 100)}%`; $('eprog').querySelector('span')!.textContent = label; };

  /** dimensões de saída conforme o tamanho escolhido (null = manter o tamanho original) */
  function target(): { w: number; h: number; shape: SocialPreset['shape']; note: string } | null {
    if (st.preset === 'original') return null;
    if (st.preset === 'custom') return { w: Math.max(1, Math.round(st.cw)), h: Math.max(1, Math.round(st.ch)), shape: 'rect', note: 'Tamanho personalizado.' };
    const p = presetById(st.preset)!;
    return { w: p.width, h: p.height, shape: p.shape, note: p.note };
  }
  const specFor = (w: number, h: number, circle: boolean): OutputSpec => ({ width: w, height: h, fit: st.fit, fx: st.fx, fy: st.fy, background: st.transparent ? null : st.bg, circle });

  // ---------- prévia ----------
  async function refresh() {
    if (!loaded) return;
    const t = target(), src = loaded.image;
    let out: OutputSpec | undefined;
    if (t) { const k = Math.min(1, 1400 / Math.max(t.w, t.h)); out = specFor(Math.max(1, Math.round(t.w * k)), Math.max(1, Math.round(t.h * k)), st.circle); }
    setProg(0.3, 'Processando…');
    try {
      const r = await preview.run(src, st.params, out, true);
      const [a, b] = await Promise.all([blobUrlOf(r.before!), blobUrlOf(r.image)]);
      for (const u of urls) URL.revokeObjectURL(u);
      urls = [a, b];
      const w = r.image.width, h = r.image.height;
      const guide = t?.shape === 'circle' && st.guide && !st.circle
        ? `<path d="M0 0H${w}V${h}H0Z M${w / 2} ${h / 2 - Math.min(w, h) / 2}a${Math.min(w, h) / 2} ${Math.min(w, h) / 2} 0 1 0 0 ${Math.min(w, h)}a${Math.min(w, h) / 2} ${Math.min(w, h) / 2} 0 1 0 0 -${Math.min(w, h)}Z" fill="rgba(0,0,0,.45)" fill-rule="evenodd"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 2}" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="8 6" vector-effect="non-scaling-stroke"/>`
        : '';
      viewer.setContent(a, w, h, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><image href="${b}" width="${w}" height="${h}"/>${guide}</svg>`, null);
      const real = t ? `${t.w} × ${t.h}` : `${loaded.origWidth} × ${loaded.origHeight}`;
      $('estat').innerHTML = `<span class="chip">saída <b>${real}</b> px</span>${t?.shape === 'circle' ? '<span class="chip">aparece em círculo</span>' : ''}`;
      $('enote').textContent = t?.note ?? 'Mantém as dimensões da imagem original.';
      $('edl').textContent = `Baixar ${EXT[st.format].toUpperCase()} (${real})`;
      setProg(1, 'Pronto');
    } catch (e) {
      if (e instanceof Error && e.message === 'cancelled') return;
      setProg(0, 'Erro');
      showMsg('Não foi possível processar a imagem.');
    }
  }
  const schedule = () => { clearTimeout(timer); timer = window.setTimeout(refresh, 200); };

  // ---------- controles ----------
  function slider(host: HTMLElement, label: string, get: () => number, set: (v: number) => void, min: number, max: number, step: number, fmt = (v: number) => String(v)) {
    const lab = document.createElement('label');
    lab.className = 'rangeline';
    const out = document.createElement('output');
    out.textContent = fmt(get());
    const sp = document.createElement('span');
    sp.append(label + ' ', out);
    const inp = Object.assign(document.createElement('input'), { type: 'range', min: String(min), max: String(max), step: String(step), value: String(get()) });
    inp.addEventListener('input', () => { set(Number(inp.value)); out.textContent = fmt(Number(inp.value)); schedule(); });
    lab.append(sp, inp);
    host.append(lab);
    return inp;
  }
  function check(host: HTMLElement, label: string, get: () => boolean, set: (v: boolean) => void, after?: () => void) {
    const lab = document.createElement('label');
    lab.className = 'chk';
    const c = Object.assign(document.createElement('input'), { type: 'checkbox', checked: get() });
    c.addEventListener('change', () => { set(c.checked); after?.(); schedule(); });
    lab.append(c, label);
    host.append(lab);
  }
  const section = (title: string) => { const d = document.createElement('div'); d.className = 'esec'; d.innerHTML = `<h3>${title}</h3>`; return d; };

  function buildPanel() {
    const box = $('enhpanel');
    box.replaceChildren();
    // --- melhoria
    const s1 = section('Melhoria da imagem');
    const row = document.createElement('div');
    row.className = 'tools';
    const auto = Object.assign(document.createElement('button'), { className: 'primary', textContent: '✨ Melhorar automaticamente' });
    const reset = Object.assign(document.createElement('button'), { className: 'ghost', textContent: 'Sem melhorias' });
    auto.addEventListener('click', () => { st.params = { ...AUTO_PARAMS }; buildPanel(); schedule(); });
    reset.addEventListener('click', () => { st.params = { ...NEUTRAL }; buildPanel(); schedule(); });
    row.append(auto, reset);
    s1.append(row);
    const P = st.params;
    check(s1, 'Corrigir níveis (contraste automático)', () => P.auto, (v) => (P.auto = v));
    check(s1, 'Balanço de branco automático', () => P.whiteBalance, (v) => (P.whiteBalance = v));
    slider(s1, 'Brilho', () => P.brightness, (v) => (P.brightness = v), -100, 100, 1);
    slider(s1, 'Contraste', () => P.contrast, (v) => (P.contrast = v), -100, 100, 1);
    slider(s1, 'Saturação', () => P.saturation, (v) => (P.saturation = v), -100, 100, 1);
    slider(s1, 'Temperatura (frio ↔ quente)', () => P.temperature, (v) => (P.temperature = v), -100, 100, 1);
    slider(s1, 'Redução de ruído / artefatos JPEG', () => P.denoise, (v) => (P.denoise = v), 0, 3, 0.5, (v) => (v === 0 ? 'desligada' : v === 1 ? 'automática' : String(v)));
    slider(s1, 'Nitidez', () => P.sharpen, (v) => (P.sharpen = v), 0, 100, 1);
    box.append(s1);

    // --- tamanho
    const s2 = section('Tamanho (redes sociais)');
    const sel = document.createElement('select');
    sel.setAttribute('aria-label', 'Tamanho de saída');
    sel.add(new Option('Original (mantém o tamanho)', 'original'));
    for (const pl of PLATFORMS) {
      const g = document.createElement('optgroup');
      g.label = pl;
      for (const p of SOCIAL_PRESETS.filter((x) => x.platform === pl)) g.append(new Option(`${p.label} — ${p.width} × ${p.height}`, p.id));
      sel.append(g);
    }
    sel.add(new Option('Personalizado…', 'custom'));
    sel.value = st.preset;
    s2.append(sel);
    const custom = document.createElement('div');
    custom.className = 'tools';
    custom.hidden = st.preset !== 'custom';
    const cw = Object.assign(document.createElement('input'), { type: 'number', min: '16', max: '8000', value: String(st.cw), ariaLabel: 'Largura' });
    const ch = Object.assign(document.createElement('input'), { type: 'number', min: '16', max: '8000', value: String(st.ch), ariaLabel: 'Altura' });
    cw.addEventListener('input', () => { st.cw = Number(cw.value); schedule(); });
    ch.addEventListener('input', () => { st.ch = Number(ch.value); schedule(); });
    custom.append('Largura ', cw, ' Altura ', ch);
    s2.append(custom);
    sel.addEventListener('change', () => { st.preset = sel.value; custom.hidden = st.preset !== 'custom'; schedule(); });
    s2.append(Object.assign(document.createElement('p'), { id: 'enote', className: 'shapehint' }));
    const fit = document.createElement('select');
    fit.add(new Option('Preencher o quadro (corta o excesso)', 'cover'));
    fit.add(new Option('Caber inteira (com bordas)', 'contain'));
    fit.value = st.fit;
    const posBox = document.createElement('div');
    const bgBox = document.createElement('div');
    const syncFit = () => { posBox.hidden = false; bgBox.hidden = st.fit !== 'contain'; };
    fit.addEventListener('change', () => { st.fit = fit.value as State['fit']; syncFit(); schedule(); });
    s2.append(fit, posBox, bgBox);
    slider(posBox, 'Posição horizontal', () => Math.round(st.fx * 100), (v) => (st.fx = v / 100), 0, 100, 1, (v) => `${v}%`);
    slider(posBox, 'Posição vertical', () => Math.round(st.fy * 100), (v) => (st.fy = v / 100), 0, 100, 1, (v) => `${v}%`);
    const bgRow = document.createElement('div');
    bgRow.className = 'tools';
    const bg = Object.assign(document.createElement('input'), { type: 'color', value: st.bg, title: 'Cor das bordas' });
    bg.addEventListener('input', () => { st.bg = bg.value; schedule(); });
    bgRow.append('Cor das bordas ', bg);
    bgBox.append(bgRow);
    check(bgBox, 'Bordas transparentes (PNG/WebP)', () => st.transparent, (v) => (st.transparent = v));
    check(s2, 'Mostrar guia circular na prévia (perfis)', () => st.guide, (v) => (st.guide = v));
    check(s2, 'Aplicar recorte circular (cantos transparentes)', () => st.circle, (v) => (st.circle = v));
    syncFit();
    box.append(s2);

    // --- arquivo
    const s3 = section('Arquivo');
    const fmt = document.createElement('select');
    fmt.add(new Option('PNG (sem perdas, com transparência)', 'png'));
    fmt.add(new Option('JPG (menor, sem transparência)', 'jpeg'));
    fmt.add(new Option('WebP (menor, com transparência)', 'webp'));
    fmt.value = st.format;
    s3.append(fmt);
    const q = slider(s3, 'Qualidade (JPG/WebP)', () => Math.round(st.quality * 100), (v) => (st.quality = v / 100), 50, 100, 1, (v) => `${v}%`);
    q.parentElement!.hidden = st.format === 'png';
    fmt.addEventListener('change', () => { st.format = fmt.value as Format; q.parentElement!.hidden = st.format === 'png'; $('edl').textContent = $('edl').textContent!.replace(/^Baixar \w+/, `Baixar ${EXT[st.format].toUpperCase()}`); });
    box.append(s3);

    // --- pacote
    const det = document.createElement('details');
    det.className = 'esec';
    det.innerHTML = '<summary>Pacote para redes (ZIP com vários tamanhos)</summary>';
    const list = document.createElement('div');
    list.className = 'packlist';
    for (const p of SOCIAL_PRESETS) {
      const lab = document.createElement('label');
      lab.className = 'chk';
      const c = Object.assign(document.createElement('input'), { type: 'checkbox', checked: pack.has(p.id) });
      c.addEventListener('change', () => { if (c.checked) pack.add(p.id); else pack.delete(p.id); });
      lab.append(c, `${p.platform} · ${p.label} (${p.width}×${p.height})`);
      list.append(lab);
    }
    const zip = Object.assign(document.createElement('button'), { className: 'ghost wide', textContent: 'Baixar pacote (ZIP)' });
    zip.addEventListener('click', () => downloadPack());
    det.append(list, zip);
    box.append(det);
  }

  // ---------- exportação ----------
  const fullImage = () => (full ??= decodeFull(loaded!.file));

  async function render(w: number | null, h: number | null, circle: boolean): Promise<RawImage> {
    const src = await fullImage();
    const out = w && h ? specFor(w, h, circle) : undefined;
    return (await exporter.run(src, st.params, out)).image;
  }
  function save(name: string, blob: Blob) {
    const url = URL.createObjectURL(blob);
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.append(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }

  async function download() {
    if (!loaded) return;
    const t = target();
    setProg(0.2, 'Gerando arquivo em alta qualidade…');
    try {
      const img = await render(t?.w ?? null, t?.h ?? null, st.circle);
      const blob = await toBlob(img, st.format, st.quality);
      const p = st.preset === 'custom' || st.preset === 'original' ? '' : `-${slug(presetById(st.preset)!.platform)}-${slug(presetById(st.preset)!.label)}`;
      save(`${loaded.name}${p}-${img.width}x${img.height}.${EXT[st.format]}`, blob);
      setProg(1, `Arquivo gerado (${(blob.size / 1024).toFixed(0)} KB)`);
    } catch (e) {
      if (!(e instanceof Error && e.message === 'cancelled')) { setProg(0, 'Erro'); showMsg('Não foi possível gerar o arquivo.'); }
    }
  }

  async function downloadPack() {
    if (!loaded) return;
    const chosen = SOCIAL_PRESETS.filter((p) => pack.has(p.id));
    if (!chosen.length) { showMsg('Marque ao menos um tamanho no pacote.'); return; }
    const files: Zippable = {};
    try {
      for (let i = 0; i < chosen.length; i++) {
        const p = chosen[i];
        setProg(i / chosen.length, `Gerando ${p.platform} · ${p.label} (${i + 1}/${chosen.length})`);
        const img = await render(p.width, p.height, st.circle);
        const blob = await toBlob(img, st.format, st.quality);
        files[`${slug(p.platform)}/${slug(p.label)}-${p.width}x${p.height}.${EXT[st.format]}`] = [new Uint8Array(await blob.arrayBuffer()), { level: 0 }];
      }
      files['LEIA-ME.txt'] = strToU8(`Imagens geradas com Vetorizando a partir de "${loaded.name}".\nTamanhos: ${chosen.map((p) => `${p.platform} ${p.label} ${p.width}x${p.height}`).join('; ')}\n`);
      save(`${loaded.name}-redes-sociais.zip`, new Blob([zipSync(files) as BlobPart], { type: 'application/zip' }));
      setProg(1, `Pacote gerado (${chosen.length} imagens)`);
    } catch (e) {
      if (!(e instanceof Error && e.message === 'cancelled')) { setProg(0, 'Erro'); showMsg('Não foi possível gerar o pacote.'); }
    }
  }

  $('edl').addEventListener('click', download);
  buildPanel();

  return {
    setImage(l: Loaded) { loaded = l; full = null; refresh(); },
    refresh,
    /** o painel é reconstruído ao voltar para este modo para refletir o estado */
    stop() { preview.cancel(); exporter.cancel(); },
  };
}
