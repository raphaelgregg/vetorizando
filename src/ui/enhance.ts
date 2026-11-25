import { strToU8, zipSync, type Zippable } from 'fflate';
import { ASPECTS, CropRect, CropShape, IDENTITY, Transform, autoTrimRect, expandedSize, inscribedRect } from '../enhance/crop';
import { AUTO_PARAMS, EnhanceParams, NEUTRAL, OutputSpec } from '../enhance/ops';
import { PLATFORMS, PROFILE_PACK, SOCIAL_PRESETS, SocialPreset, presetById } from '../enhance/social';
import type { RawImage } from '../engine/types';
import { encodePng } from '../icons/png';
import { EnhanceClient } from './enhanceClient';
import { CropOverlay } from './crop';
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
  shape: CropShape; // forma do recorte aplicada à saída (cantos transparentes)
  radius: number; // arredondamento do retângulo arredondado (0–0,5)
  t: Transform; // giro/espelho/endireitar + recorte
  ratioId: string; // proporção do recorte (ASPECTS)
  swap: boolean; // inverte a orientação da proporção (ex.: 4:5 ↔ 5:4)
  cropMode: boolean; // ajustando o recorte sobre a imagem
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
  const st: State = { params: { ...AUTO_PARAMS }, preset: 'ig-profile', cw: 1080, ch: 1080, fit: 'cover', fx: 0.5, fy: 0.5, bg: '#ffffff', transparent: false, shape: 'rect', radius: 0.15, t: { ...IDENTITY }, ratioId: 'free', swap: false, cropMode: false, guide: true, format: 'png', quality: 0.92 };
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
  const specFor = (w: number, h: number): OutputSpec => ({ width: w, height: h, fit: st.fit, fx: st.fx, fy: st.fy, background: st.transparent ? null : st.bg, circle: st.shape === 'ellipse', shape: st.shape, radius: st.radius });

  // ---------- recorte e giro ----------
  const crop = new CropOverlay(viewer);
  const cropClient = new EnhanceClient();
  let tImage: RawImage | null = null; // prévia girada/espelhada/endireitada, SEM recorte (base do ajuste e do "aparar bordas")
  /** modo de comparação escolhido na barra (Antes/Depois, Depois, Antes) */
  const uiMode = () => (document.querySelector<HTMLElement>('[data-emode].on')?.dataset.emode ?? 'compare') as 'compare' | 'vector' | 'original';
  const imgSize = () => (tImage ? [tImage.width, tImage.height] : expandedSize(loaded?.image.width ?? 1, loaded?.image.height ?? 1, 0)) as [number, number];

  /** proporção numérica (largura/altura) do recorte, ou null se livre */
  function currentRatio(): number | null {
    const a = ASPECTS.find((x) => x.id === st.ratioId)!;
    let r: number | null = null;
    if (a.ratio === 'free') return null;
    if (a.ratio === 'original') { const [w, h] = imgSize(); r = w / h; }
    else if (a.ratio === 'output') { const t = target(); r = t ? t.w / t.h : null; }
    else r = a.ratio;
    return r && st.swap && a.ratio !== 'original' && a.ratio !== 'output' ? 1 / r : r;
  }

  async function loadTransformed(): Promise<RawImage> {
    if (!loaded) throw new Error('sem imagem');
    const r = await cropClient.run(loaded.image, NEUTRAL, undefined, false, st.t, true);
    tImage = r.image;
    return r.image;
  }

  /** caixa inicial/ao mudar proporção: a maior possível, ou a área sem cantos vazios após endireitar */
  function defaultCrop(): CropRect {
    const [w, h] = imgSize();
    const base = st.t.angle ? inscribedRect(loaded!.image.width, loaded!.image.height, st.t.angle) : { x: 0, y: 0, w: 1, h: 1 };
    const ratio = currentRatio();
    if (!ratio) return base;
    // maior retângulo dessa proporção dentro de `base` (mesmo centro)
    const bw = base.w * w, bh = base.h * h;
    let rw = bw, rh = bw / ratio;
    if (rh > bh) { rh = bh; rw = bh * ratio; }
    const cx = base.x + base.w / 2, cy = base.y + base.h / 2;
    return { x: cx - rw / w / 2, y: cy - rh / h / 2, w: rw / w, h: rh / h };
  }

  async function enterCrop() {
    if (!loaded) return;
    st.cropMode = true;
    setProg(0.3, 'Preparando recorte…');
    try {
      const img = await loadTransformed();
      for (const u of urls) URL.revokeObjectURL(u);
      const url = await blobUrlOf(img);
      urls = [url];
      const w = img.width, h = img.height;
      viewer.setContent(url, w, h, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><image href="${url}" width="${w}" height="${h}"/></svg>`, null);
      viewer.setMode('vector');
      st.t.crop ??= currentRatio() || st.t.angle ? defaultCrop() : { x: 0, y: 0, w: 1, h: 1 };
      crop.open(w, h, st.t.crop, currentRatio(), (r) => { st.t.crop = r; updateCropInfo(); });
      updateCropInfo();
      setProg(1, 'Arraste as alças para recortar');
    } catch (e) {
      if (!(e instanceof Error && e.message === 'cancelled')) { st.cropMode = false; showMsg('Não foi possível preparar o recorte.'); }
    }
    syncCropUi();
  }
  function exitCrop() {
    st.cropMode = false;
    crop.close();
    viewer.setMode(uiMode());
    const c = st.t.crop;
    if (c && c.x < 1e-3 && c.y < 1e-3 && c.w > 0.999 && c.h > 0.999) st.t.crop = null; // caixa inteira = sem recorte
    syncCropUi();
    refresh();
  }
  const toggleCrop = () => (st.cropMode ? exitCrop() : enterCrop());

  function updateCropInfo() {
    const el = document.getElementById('cropinfo');
    if (!el || !loaded) return;
    const c = st.t.crop, [w, h] = imgSize();
    const full = loaded.origWidth / loaded.image.width; // preview → original
    el.textContent = c ? `Recorte: ${Math.round(c.w * w * full)} × ${Math.round(c.h * h * full)} px (≈ ${(Math.round((c.w * w) / (c.h * h) * 100) / 100)}:1)` : 'Sem recorte';
  }
  const syncCropUi = () => { const b = document.getElementById('cropbtn'); if (b) { b.setAttribute('aria-pressed', String(st.cropMode)); b.textContent = st.cropMode ? '✔ Concluir recorte' : '✂ Ajustar recorte'; } updateCropInfo(); };

  /** Gira/espelha mantendo o recorte no mesmo trecho da imagem (a caixa acompanha) */
  function op(kind: 'cw' | 'ccw' | 'fh' | 'fv') {
    const t = st.t, c = t.crop;
    if (kind === 'cw' || kind === 'ccw') {
      t.rotate = (((t.rotate + (kind === 'cw' ? 90 : 270)) % 360) as Transform['rotate']);
      [t.flipH, t.flipV] = [t.flipV, t.flipH]; // girar uma imagem espelhada troca o eixo do espelho
      if (c) st.t.crop = kind === 'cw' ? { x: 1 - (c.y + c.h), y: c.x, w: c.h, h: c.w } : { x: c.y, y: 1 - (c.x + c.w), w: c.h, h: c.w };
    } else {
      if (kind === 'fh') t.flipH = !t.flipH; else t.flipV = !t.flipV;
      t.angle = -t.angle; // espelhar uma imagem endireitada inverte o sentido do ângulo
      if (c) st.t.crop = kind === 'fh' ? { ...c, x: 1 - (c.x + c.w) } : { ...c, y: 1 - (c.y + c.h) };
    }
    afterTransform(false);
  }

  /** a imagem girada mudou: recarrega a prévia (no modo recorte) ou o resultado */
  async function afterTransform(resetCrop: boolean) {
    if (resetCrop) { st.t.crop = null; }
    if (st.cropMode) {
      const keep = st.t.crop;
      await enterCrop();
      if (resetCrop || !keep) { st.t.crop = defaultCrop(); crop.setRect(st.t.crop); }
    } else if (resetCrop && st.t.angle) {
      // fora do modo recorte: já recorta a área sem cantos vazios
      st.t.crop = inscribedRect(loaded!.image.width, loaded!.image.height, st.t.angle);
      schedule();
    } else schedule();
    updateCropInfo();
  }

  // ---------- prévia ----------
  async function refresh() {
    if (!loaded) return;
    if (st.cropMode) return; // no modo recorte a prévia é a imagem inteira (ver enterCrop)
    const t = target(), src = loaded.image;
    let out: OutputSpec | undefined;
    if (t) { const k = Math.min(1, 1400 / Math.max(t.w, t.h)); out = specFor(Math.max(1, Math.round(t.w * k)), Math.max(1, Math.round(t.h * k))); }
    setProg(0.3, 'Processando…');
    try {
      const r = await preview.run(src, st.params, out, true, st.t);
      const [a, b] = await Promise.all([blobUrlOf(r.before!), blobUrlOf(r.image)]);
      for (const u of urls) URL.revokeObjectURL(u);
      urls = [a, b];
      const w = r.image.width, h = r.image.height;
      const guide = t?.shape === 'circle' && st.guide && st.shape === 'rect'
        ? `<path d="M0 0H${w}V${h}H0Z M${w / 2} ${h / 2 - Math.min(w, h) / 2}a${Math.min(w, h) / 2} ${Math.min(w, h) / 2} 0 1 0 0 ${Math.min(w, h)}a${Math.min(w, h) / 2} ${Math.min(w, h) / 2} 0 1 0 0 -${Math.min(w, h)}Z" fill="rgba(0,0,0,.45)" fill-rule="evenodd"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 2}" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="8 6" vector-effect="non-scaling-stroke"/>`
        : '';
      viewer.setContent(a, w, h, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><image href="${b}" width="${w}" height="${h}"/>${guide}</svg>`, null);
      const full = loaded.origWidth / loaded.image.width;
      const real = t ? `${t.w} × ${t.h}` : `${Math.round(r.image.width * full)} × ${Math.round(r.image.height * full)}`;
      $('estat').innerHTML = `<span class="chip">saída <b>${real}</b> px</span>${t?.shape === 'circle' ? '<span class="chip">aparece em círculo</span>' : ''}`;
      $('enote').textContent = t?.note ?? 'Mantém as dimensões da imagem (após o recorte).';
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
    // --- recorte e giro
    const sc = section('Recorte e giro');
    const rot = document.createElement('div');
    rot.className = 'tools';
    for (const [label, title, k] of [['⟲', 'Girar 90° para a esquerda', 'ccw'], ['⟳', 'Girar 90° para a direita', 'cw'], ['⇋', 'Espelhar na horizontal', 'fh'], ['⇵', 'Espelhar na vertical', 'fv']] as const) {
      const b = Object.assign(document.createElement('button'), { className: 'ghost', textContent: label, title });
      b.setAttribute('aria-label', title);
      b.addEventListener('click', () => op(k));
      rot.append(b);
    }
    sc.append(rot);
    const ang = slider(sc, 'Endireitar (°)', () => st.t.angle, (v) => (st.t.angle = v), -45, 45, 0.1, (v) => `${v.toFixed(1)}°`);
    ang.addEventListener('change', () => afterTransform(true));
    ang.addEventListener('dblclick', () => { st.t.angle = 0; ang.value = '0'; ang.parentElement!.querySelector('output')!.textContent = '0.0°'; afterTransform(true); });
    const ratio = document.createElement('select');
    ratio.setAttribute('aria-label', 'Proporção do recorte');
    for (const a of ASPECTS) ratio.add(new Option(`Proporção: ${a.label}`, a.id));
    ratio.value = st.ratioId;
    const swap = Object.assign(document.createElement('button'), { className: 'ghost', textContent: '⇄', title: 'Inverter orientação da proporção (ex.: 4:5 ↔ 5:4)' });
    ratio.addEventListener('change', () => { st.ratioId = ratio.value; if (st.cropMode) crop.setRatio(currentRatio()); else if (ratio.value !== 'free') enterCrop(); });
    swap.addEventListener('click', () => { st.swap = !st.swap; if (st.cropMode) crop.setRatio(currentRatio()); else if (st.ratioId !== 'free') enterCrop(); });
    const rr = document.createElement('div');
    rr.className = 'tools';
    rr.append(ratio, swap);
    sc.append(rr);
    const rc = document.createElement('div');
    rc.className = 'tools';
    const cb = Object.assign(document.createElement('button'), { id: 'cropbtn', className: 'primary', textContent: st.cropMode ? '✔ Concluir recorte' : '✂ Ajustar recorte' });
    cb.setAttribute('aria-pressed', String(st.cropMode));
    cb.addEventListener('click', toggleCrop);
    const trim = Object.assign(document.createElement('button'), { className: 'ghost', textContent: 'Aparar bordas', title: 'Remove bordas de cor uniforme ou transparentes ao redor do conteúdo' });
    trim.addEventListener('click', async () => {
      if (!loaded) return;
      try {
        const img = tImage ?? (await loadTransformed());
        const r = autoTrimRect(img);
        if (!r) { showMsg('Não há bordas uniformes ou transparentes para aparar.'); return; }
        st.ratioId = 'free'; ratio.value = 'free';
        st.t.crop = r;
        if (st.cropMode) { crop.setRatio(null); crop.setRect(r); } else { updateCropInfo(); schedule(); }
      } catch (e) { if (!(e instanceof Error && e.message === 'cancelled')) showMsg('Não foi possível aparar.'); }
    });
    const clr = Object.assign(document.createElement('button'), { className: 'ghost', textContent: 'Limpar recorte' });
    clr.addEventListener('click', () => { st.t.crop = null; if (st.cropMode) crop.setRect({ x: 0, y: 0, w: 1, h: 1 }); else { updateCropInfo(); schedule(); } });
    const rst = Object.assign(document.createElement('button'), { className: 'ghost', textContent: 'Redefinir giro', title: 'Desfaz giros, espelhos, ângulo e recorte' });
    rst.addEventListener('click', () => { st.t = { ...IDENTITY }; st.ratioId = 'free'; st.swap = false; if (st.cropMode) { st.cropMode = false; crop.close(); viewer.setMode(uiMode()); } buildPanel(); schedule(); });
    rc.append(cb, trim, clr, rst);
    sc.append(rc, Object.assign(document.createElement('p'), { id: 'cropinfo', className: 'shapehint' }));
    const shp = document.createElement('select');
    shp.setAttribute('aria-label', 'Forma do recorte');
    for (const [v, t] of [['rect', 'Forma: retângulo'], ['rounded', 'Forma: retângulo arredondado'], ['ellipse', 'Forma: elipse / círculo (cantos transparentes)']]) shp.add(new Option(t, v));
    shp.value = st.shape;
    sc.append(shp);
    const rad = slider(sc, 'Arredondamento', () => Math.round(st.radius * 100), (v) => (st.radius = v / 100), 0, 50, 1, (v) => `${v}%`);
    rad.parentElement!.hidden = st.shape !== 'rounded';
    shp.addEventListener('change', () => { st.shape = shp.value as CropShape; rad.parentElement!.hidden = st.shape !== 'rounded'; schedule(); });
    box.append(sc);
    syncCropUi();

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

  async function render(w: number | null, h: number | null): Promise<RawImage> {
    const src = await fullImage();
    const out = w && h ? specFor(w, h) : undefined;
    return (await exporter.run(src, st.params, out, false, st.t)).image;
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
      const img = await render(t?.w ?? null, t?.h ?? null);
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
        const img = await render(p.width, p.height);
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
    setImage(l: Loaded) { loaded = l; full = null; tImage = null; st.t = { ...IDENTITY }; st.cropMode = false; crop.close(); buildPanel(); refresh(); },
    refresh,
    /** o painel é reconstruído ao voltar para este modo para refletir o estado */
    stop() { preview.cancel(); exporter.cancel(); cropClient.cancel(); if (st.cropMode) { st.cropMode = false; crop.close(); } },
  };
}
