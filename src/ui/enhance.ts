import { strToU8, zipSync, type Zippable } from 'fflate';
import { FILTERS } from '../enhance/colors';
import { ASPECTS, CropRect, CropShape, IDENTITY, Transform, autoTrimRect, expandedSize, inscribedRect, prepare } from '../enhance/crop';
import { AUTO_PARAMS, EditOps, EnhanceParams, NEUTRAL, NO_EDIT, OutputSpec, finalize } from '../enhance/ops';
import { Overlay, SHAPE_KINDS, ShapeKind, hitOverlay, isLine, makeOverlay, newId, reserveIds } from '../enhance/overlay';
import { WandClick, applyRemovals, backgroundRemoval, selectionMask, selectionOverlay } from '../enhance/wand';
import { PLATFORMS, PROFILE_PACK, SOCIAL_PRESETS, SocialPreset, presetById } from '../enhance/social';
import type { RawImage } from '../engine/types';
import { encodePng } from '../icons/png';
import { EnhanceClient } from './enhanceClient';
import { CropOverlay } from './crop';
import { Loaded, decodeFull } from './loader';
import { ShapeBox } from './shapebox';
import type { Viewer } from './viewer';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

type Format = 'png' | 'jpeg' | 'webp';
type Tab = 'adj' | 'crop' | 'wand' | 'shape' | 'layers' | 'out';
type Tool = 'none' | 'crop' | 'wand' | 'shape';
const TABS: [Tab, string][] = [['adj', 'Ajustes'], ['crop', 'Recorte'], ['wand', 'Varinha'], ['shape', 'Formas'], ['layers', 'Camadas'], ['out', 'Saída']];
const SWATCHES = ['#ffffff', '#000000', '#ff3b30', '#ff9500', '#ffcc00', '#34c759', '#00c7be', '#007aff', '#5856d6', '#af52de', '#ff2d55', '#8e8e93'];
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
  tab: Tab;
  edit: EditOps; // remoções da varinha, formas inseridas e camada da imagem
  sel: number | null; // forma selecionada (id)
  fillOn: boolean; fill: string; strokeOn: boolean; stroke: string; // cores padrão das formas novas
  wTol: number; wContig: boolean; wFeather: number; wClicks: WandClick[]; wInvert: boolean; wMode: 'new' | 'add' | 'sub'; // varinha
  rFrom: string; rTo: string; rTol: number; // substituir cor
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
  const st: State = { params: { ...AUTO_PARAMS }, preset: 'ig-profile', cw: 1080, ch: 1080, fit: 'cover', fx: 0.5, fy: 0.5, bg: '#ffffff', transparent: false, shape: 'rect', radius: 0.15, t: { ...IDENTITY }, ratioId: 'free', swap: false, cropMode: false, tab: 'adj', edit: { ...NO_EDIT, removals: [], overlays: [] }, sel: null, fillOn: true, fill: '#ff5a36', strokeOn: false, stroke: '#ffffff', wTol: 30, wContig: true, wFeather: 2, wClicks: [], wInvert: false, wMode: 'new', rFrom: '#ffffff', rTo: '#ff5a36', rTol: 25, guide: true, format: 'png', quality: 0.92 };
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
    if (st.cropMode || tool === 'wand') return; // nesses modos a prévia é outra (ver enterCrop / renderWand)
    const t = target(), src = loaded.image;
    let out: OutputSpec | undefined;
    if (t) { const k = Math.min(1, 1400 / Math.max(t.w, t.h)); out = specFor(Math.max(1, Math.round(t.w * k)), Math.max(1, Math.round(t.h * k))); }
    setProg(0.3, 'Processando…');
    try {
      const r = await preview.run(src, st.params, out, true, st.t, false, st.edit, true); // só a parte pesada; formas e forma do recorte são compostas aqui
      baseProc = r.image;
      lastOut = out ?? (st.shape !== 'rect' ? specFor(r.image.width, r.image.height) : undefined);
      extractColors(r.image);
      const bu = await fastUrl(r.before!);
      if (beforeUrl) URL.revokeObjectURL(beforeUrl);
      beforeUrl = bu;
      await recomposite();
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
  // ---------- edição: histórico, varinha, formas, camadas ----------
  let tool: Tool = 'none';
  let baseProc: RawImage | null = null; // resultado "pesado" na escala da prévia (sem formas nem forma do recorte)
  let lastOut: OutputSpec | undefined;
  let shown: RawImage | null = null; // imagem exibida (fonte do conta-gotas)
  let beforeUrl = '';
  let afterUrl = '';
  let token = 0;
  let wandBase: RawImage | null = null; // imagem preparada (giro + recorte) na escala da prévia
  let wandView: RawImage | null = null; // ... com as remoções já aplicadas
  let imgColors: string[] = []; // cores dominantes da imagem (paleta)
  let picking: ((hex: string) => void) | null = null;
  const hist: string[] = [];
  const fut: string[] = [];
  const shapeBox = new ShapeBox(viewer);

  const snapshot = () => JSON.stringify({ edit: st.edit, replaces: st.params.replaces });
  function updateUndo() { const u = document.getElementById('eundo') as HTMLButtonElement | null, r = document.getElementById('eredo') as HTMLButtonElement | null; if (u) u.disabled = !hist.length; if (r) r.disabled = !fut.length; }
  /** registra uma mudança no histórico (o estado ANTERIOR é `before`) */
  function record(before: string) { if (before !== snapshot()) { hist.push(before); if (hist.length > 80) hist.shift(); fut.length = 0; } updateUndo(); }
  let gestureSnap: string | null = null;
  const beginGesture = () => { gestureSnap ??= snapshot(); };
  const endGesture = () => { if (gestureSnap !== null) { record(gestureSnap); gestureSnap = null; } };
  function restore(json: string) {
    const o = JSON.parse(json) as { edit: EditOps; replaces: EnhanceParams['replaces'] };
    st.edit = o.edit; st.params.replaces = o.replaces; reserveIds(st.edit.overlays);
    if (st.sel !== null && !st.edit.overlays.some((x) => x.id === st.sel)) st.sel = null;
    wandView = null; st.wClicks = [];
    buildPanel(); heavyRefresh();
  }
  function undo() { const p = hist.pop(); if (p === undefined) return; fut.push(snapshot()); restore(p); updateUndo(); }
  function redo() { const n = fut.pop(); if (n === undefined) return; hist.push(snapshot()); restore(n); updateUndo(); }

  /** muda o estado de edição registrando o histórico; `heavy` = precisa reprocessar (varinha/cores) */
  function mutate(fn: () => void, heavy = false) {
    const before = snapshot();
    fn();
    record(before);
    if (heavy) heavyRefresh(); else lightRefresh();
    syncLayersUi();
  }
  function heavyRefresh() { wandView = null; if (tool === 'wand') renderWand(); else refresh(); }
  function lightRefresh() { if (tool === 'wand') renderWand(); else scheduleRecomposite(); }

  const fastUrl = (img: RawImage): Promise<string> => {
    const c = document.createElement('canvas');
    c.width = img.width; c.height = img.height;
    c.getContext('2d')!.putImageData(new ImageData(new Uint8ClampedArray(img.data), img.width, img.height), 0, 0);
    return new Promise((res, rej) => c.toBlob((b) => (b ? res(URL.createObjectURL(b)) : rej(new Error('png'))), 'image/png'));
  };

  /** cores dominantes (histograma 4 bits/canal, cores bem distintas) para a paleta */
  function extractColors(img: RawImage) {
    const bins = new Map<number, number>();
    const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 40000)));
    for (let y = 0; y < img.height; y += step) for (let x = 0; x < img.width; x += step) {
      const i = (y * img.width + x) * 4;
      if (img.data[i + 3] < 128) continue;
      const k = ((img.data[i] >> 4) << 8) | ((img.data[i + 1] >> 4) << 4) | (img.data[i + 2] >> 4);
      bins.set(k, (bins.get(k) ?? 0) + 1);
    }
    const out: number[][] = [];
    for (const [k] of [...bins].sort((a, b) => b[1] - a[1])) {
      const c = [((k >> 8) & 15) * 17, ((k >> 4) & 15) * 17, (k & 15) * 17];
      if (out.every((o) => Math.hypot(o[0] - c[0], o[1] - c[1], o[2] - c[2]) > 55)) out.push(c);
      if (out.length >= 10) break;
    }
    imgColors = out.map((c) => '#' + c.map((v) => v.toString(16).padStart(2, '0')).join(''));
    document.querySelectorAll('.imgswatches').forEach((el) => fillSwatches(el as HTMLElement, (el as HTMLElement).dataset.target!));
  }

  // ---------- exibição ----------
  /** vista principal: antes (enquadrado igual) × depois (melhorado + formas + forma do recorte) */
  function paintView() {
    if (!shown || !beforeUrl || !afterUrl || tool === 'wand') return;
    const w = shown.width, h = shown.height, t = target();
    const guide = t?.shape === 'circle' && st.guide && st.shape === 'rect'
      ? `<path d="M0 0H${w}V${h}H0Z M${w / 2} ${h / 2 - Math.min(w, h) / 2}a${Math.min(w, h) / 2} ${Math.min(w, h) / 2} 0 1 0 0 ${Math.min(w, h)}a${Math.min(w, h) / 2} ${Math.min(w, h) / 2} 0 1 0 0 -${Math.min(w, h)}Z" fill="rgba(0,0,0,.45)" fill-rule="evenodd"/><circle cx="${w / 2}" cy="${h / 2}" r="${Math.min(w, h) / 2}" fill="none" stroke="#fff" stroke-width="2" stroke-dasharray="8 6" vector-effect="non-scaling-stroke"/>`
      : '';
    viewer.setContent(beforeUrl, w, h, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><image href="${afterUrl}" width="${w}" height="${h}"/>${guide}</svg>`, null);
    syncShapeBox();
  }
  async function recomposite() {
    if (!baseProc || !loaded || tool === 'wand') return;
    const my = ++token;
    const img = finalize(baseProc, st.edit, lastOut);
    const url = await fastUrl(img);
    if (my !== token) { URL.revokeObjectURL(url); return; }
    if (afterUrl) URL.revokeObjectURL(afterUrl);
    afterUrl = url; shown = img;
    paintView();
  }
  let rcTimer = 0;
  const scheduleRecomposite = () => { if (rcTimer) return; rcTimer = window.setTimeout(() => { rcTimer = 0; recomposite(); }, 60); };

  // ---------- varinha mágica ----------
  const wandDims = () => (wandView ? `${wandView.width}×${wandView.height}` : '');
  async function renderWand() {
    if (!loaded) return;
    wandBase ??= prepare(loaded.image, st.t);
    wandView ??= applyRemovals(wandBase, st.edit.removals);
    const v = wandView, my = ++token;
    shown = v;
    const mask = st.wClicks.length ? selectionMask(v, st.wClicks, st.wInvert) : null;
    let pct = 0;
    if (mask) { let n = 0; for (let i = 0; i < mask.length; i++) n += mask[i]; pct = (n / mask.length) * 100; }
    const [a, b] = await Promise.all([fastUrl(v), mask ? fastUrl(selectionOverlay(mask, v.width, v.height)) : Promise.resolve('')]);
    if (my !== token) { URL.revokeObjectURL(a); if (b) URL.revokeObjectURL(b); return; }
    for (const u of urls) URL.revokeObjectURL(u);
    urls = [a, b].filter(Boolean);
    const w = v.width, h = v.height;
    viewer.setContent(a, w, h, `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${w} ${h}" width="${w}" height="${h}"><image href="${a}" width="${w}" height="${h}"/>${b ? `<image href="${b}" width="${w}" height="${h}"/>` : ''}</svg>`, null);
    const info = document.getElementById('wandinfo');
    if (info) info.textContent = mask ? `Selecionado: ${pct.toFixed(1)}% da imagem (${wandDims()}). Shift soma, Alt subtrai.` : `Clique na imagem para selecionar uma área (${wandDims()}).`;
    for (const id of ['wandrm', 'wandinv', 'wandclr']) { const el = document.getElementById(id) as HTMLButtonElement | null; if (el) el.disabled = !mask; }
    setProg(1, mask ? 'Selecione mais ou remova' : 'Pronto');
  }
  function wandClick(x: number, y: number, shift: boolean, alt: boolean) {
    const v = wandView ?? wandBase;
    if (!v) return;
    const c: WandClick = { x: Math.min(1, Math.max(0, x / v.width)), y: Math.min(1, Math.max(0, y / v.height)), tol: st.wTol, contiguous: st.wContig, mode: alt || st.wMode === 'sub' ? 'sub' : 'add' };
    const accumulate = shift || alt || st.wMode !== 'new';
    st.wClicks = accumulate ? [...st.wClicks, c] : [c];
    if (!accumulate) st.wInvert = false;
    renderWand();
  }
  function wandRemove() {
    if (!st.wClicks.length) return;
    const rem = { clicks: st.wClicks, invert: st.wInvert, feather: st.wFeather };
    st.wClicks = []; st.wInvert = false;
    mutate(() => st.edit.removals.push(rem), true);
  }
  function removeBackground() {
    mutate(() => st.edit.removals.push(backgroundRemoval(st.wTol, Math.max(1, st.wFeather))), true);
  }

  // ---------- formas inseridas e camadas ----------
  const selOverlay = () => st.edit.overlays.find((o) => o.id === st.sel) ?? null;
  const canvasDims = (): [number, number] => (baseProc ? [baseProc.width, baseProc.height] : [1, 1]);
  function addShape(kind: ShapeKind) {
    const o = makeOverlay(kind, st.fill, st.strokeOn ? st.stroke : null);
    if (isLine(kind)) { o.stroke = st.strokeOn ? st.stroke : st.fill; o.fill = null; }
    else { o.fill = st.fillOn ? st.fill : null; o.stroke = st.strokeOn ? st.stroke : null; if (!o.fill && !o.stroke) o.stroke = st.stroke; }
    // um pouco deslocada quando já há formas, para não empilhar exatamente
    const n = st.edit.overlays.length;
    o.x += (n % 5) * 0.02; o.y += (n % 5) * 0.02; o.x1 += (n % 5) * 0.02; o.x2 += (n % 5) * 0.02;
    mutate(() => { st.edit.overlays.push(o); st.sel = o.id; });
    ensureShapeTool();
    buildPanel();
  }
  function ensureShapeTool() { if (tool !== 'shape' && (st.tab === 'shape' || st.tab === 'layers')) setTool('shape'); }
  function deleteSel() {
    if (st.sel === null) return;
    mutate(() => { st.edit.overlays = st.edit.overlays.filter((o) => o.id !== st.sel); st.sel = null; });
    shapeBox.close(); buildPanel();
  }
  function duplicateSel() {
    const o = selOverlay();
    if (!o) return;
    const c: Overlay = { ...o, id: newId(), name: `${o.name} cópia`, x: o.x + 0.03, y: o.y + 0.03, x1: o.x1 + 0.03, y1: o.y1 + 0.03, x2: o.x2 + 0.03, y2: o.y2 + 0.03 };
    mutate(() => { st.edit.overlays.splice(st.edit.overlays.indexOf(o) + 1, 0, c); st.sel = c.id; });
    buildPanel();
  }
  function moveLayer(dir: 'front' | 'back' | 'up' | 'down') {
    const list = st.edit.overlays, i = list.findIndex((o) => o.id === st.sel);
    if (i < 0) return;
    const j = dir === 'front' ? list.length - 1 : dir === 'back' ? 0 : dir === 'up' ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1);
    if (j === i) return;
    mutate(() => { const [o] = list.splice(i, 1); list.splice(j, 0, o); });
    buildPanel();
  }
  /** mostra as alças da forma selecionada sobre a prévia (só nas abas Formas/Camadas) */
  function syncShapeBox() {
    shapeBox.close();
    const o = selOverlay();
    if (tool !== 'shape' || !o || !o.visible || !shown) return;
    shapeBox.onBegin = () => beginGesture();
    shapeBox.onChange = (n, final) => {
      const cur = selOverlay();
      if (!cur) return;
      Object.assign(cur, { x: n.x, y: n.y, w: n.w, h: n.h, rot: n.rot, x1: n.x1, y1: n.y1, x2: n.x2, y2: n.y2 });
      scheduleRecomposite();
      if (final) { endGesture(); syncLayersUi(); }
    };
    shapeBox.open(o, shown.width, shown.height);
  }
  function selectShapeAt(x: number, y: number) {
    if (!shown) return;
    const hit = hitOverlay(st.edit.overlays, x / shown.width, y / shown.height, shown.width, shown.height);
    st.sel = hit ? hit.id : null;
    buildPanel(); syncShapeBox();
  }

  // ---------- ferramentas (exclusivas) ----------
  function setTool(next: Tool) {
    if (tool === next) return;
    if (st.cropMode) exitCrop();
    if (tool === 'shape') shapeBox.close();
    const was = tool;
    tool = next;
    viewer.setMode(next === 'wand' || next === 'shape' ? 'vector' : uiMode());
    if (next === 'wand') { wandBase = null; wandView = null; renderWand(); }
    else if (was === 'wand') { st.wClicks = []; refresh(); }
    else if (next === 'shape') refresh();
  }
  viewer.clickTool = (x, y, shift, alt) => {
    if (picking) { const cb = picking; picking = null; document.getElementById('viewerE')?.classList.remove('picking'); if (shown) { const i = (Math.min(shown.height - 1, Math.max(0, Math.floor(y))) * shown.width + Math.min(shown.width - 1, Math.max(0, Math.floor(x)))) * 4; cb('#' + [0, 1, 2].map((k) => shown!.data[i + k].toString(16).padStart(2, '0')).join('')); } return; }
    if (tool === 'wand') wandClick(x, y, shift, alt);
    else if (tool === 'shape') selectShapeAt(x, y);
  };
  /** conta-gotas: o próximo clique na imagem devolve a cor do pixel */
  function pickColor(cb: (hex: string) => void) { picking = cb; document.getElementById('viewerE')?.classList.add('picking'); showMsg('Clique na imagem para pegar a cor.'); }

  function fillSwatches(host: HTMLElement, target: string) {
    host.replaceChildren();
    const colors = target.endsWith('img') ? imgColors : SWATCHES;
    for (const c of colors) {
      const b = Object.assign(document.createElement('button'), { title: c });
      b.style.background = c;
      b.addEventListener('click', () => applyColorTo(target.replace('img', ''), c));
      host.append(b);
    }
  }
  /** aplica uma cor ao destino: 'fill' | 'stroke' | 'rto' | 'tint' */
  function applyColorTo(target: string, c: string) {
    if (target === 'fill') { st.fill = c; st.fillOn = true; const o = selOverlay(); if (o && !isLine(o.kind)) { beginGesture(); o.fill = c; endGesture(); scheduleRecomposite(); } else if (o) { beginGesture(); o.stroke = c; endGesture(); scheduleRecomposite(); } }
    else if (target === 'stroke') { st.stroke = c; st.strokeOn = true; const o = selOverlay(); if (o) { beginGesture(); o.stroke = c; endGesture(); scheduleRecomposite(); } }
    else if (target === 'rto') st.rTo = c;
    else if (target === 'rfrom') st.rFrom = c;
    else if (target === 'tint') { st.params.tint = c; st.params.tintAmount ||= 40; schedule(); }
    buildPanel();
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

  // ---------- painéis: cores, varinha, formas, camadas ----------
  function colorRow(host: HTMLElement, label: string, get: () => string, set: (v: string) => void, target: string, none?: { get: () => boolean; set: (v: boolean) => void }) {
    const row = document.createElement('div');
    row.className = 'colorrow';
    if (none) {
      const c = Object.assign(document.createElement('input'), { type: 'checkbox', checked: none.get(), title: 'Usar' });
      c.addEventListener('change', () => { none.set(c.checked); });
      row.append(c);
    }
    const inp = Object.assign(document.createElement('input'), { type: 'color', value: get(), title: label });
    inp.addEventListener('input', () => set(inp.value));
    const eye = Object.assign(document.createElement('button'), { className: 'ghost', textContent: '◉', title: 'Conta-gotas: pegar a cor da imagem' });
    eye.addEventListener('click', () => pickColor((hex) => { set(hex); inp.value = hex; buildPanel(); }));
    row.append(label + ' ', inp, eye);
    host.append(row);
    if (target) {
      const sw = document.createElement('div'); sw.className = 'swatches'; sw.dataset.target = target; fillSwatches(sw, target); host.append(sw);
      const im = document.createElement('div'); im.className = 'swatches imgswatches'; im.dataset.target = target + 'img'; fillSwatches(im, target + 'img'); host.append(im);
    }
  }

  function buildColors(host: HTMLElement) {
    const P = st.params, sc = section('Cores');
    slider(sc, 'Matiz', () => P.hue, (v) => (P.hue = v), -180, 180, 1, (v) => `${v}°`);
    const f = document.createElement('select');
    f.setAttribute('aria-label', 'Filtro de cor');
    for (const x of FILTERS) f.add(new Option(`Filtro: ${x.label}`, x.id));
    f.value = P.filter;
    f.addEventListener('change', () => { P.filter = f.value; schedule(); });
    sc.append(f);
    slider(sc, 'Intensidade do filtro', () => P.filterAmount, (v) => (P.filterAmount = v), 0, 100, 1, (v) => `${v}%`);
    colorRow(sc, 'Colorir com', () => P.tint ?? '#ff8800', (v) => { P.tint = v; if (!P.tintAmount) P.tintAmount = 40; schedule(); }, 'tint');
    slider(sc, 'Intensidade do colorir', () => P.tintAmount, (v) => (P.tintAmount = v), 0, 100, 1, (v) => `${v}%`);
    host.append(sc);

    const sr = section('Substituir cor');
    colorRow(sr, 'De', () => st.rFrom, (v) => (st.rFrom = v), 'rfrom');
    colorRow(sr, 'Para', () => st.rTo, (v) => (st.rTo = v), 'rto');
    slider(sr, 'Tolerância', () => st.rTol, (v) => (st.rTol = v), 0, 100, 1);
    const add = Object.assign(document.createElement('button'), { className: 'primary', textContent: 'Substituir' });
    add.addEventListener('click', () => { mutate(() => P.replaces.push({ from: st.rFrom, to: st.rTo, tol: st.rTol }), true); buildPanel(); });
    sr.append(add);
    for (const [i, r] of P.replaces.entries()) {
      const row = document.createElement('div');
      row.className = 'replrow';
      row.innerHTML = `<i style="background:${r.from}"></i>→<i style="background:${r.to}"></i><span>tol. ${r.tol}</span>`;
      const del = Object.assign(document.createElement('button'), { className: 'ghost', textContent: '×', title: 'Remover substituição' });
      del.addEventListener('click', () => { mutate(() => P.replaces.splice(i, 1), true); buildPanel(); });
      row.append(del);
      sr.append(row);
    }
    host.append(sr);
  }

  function buildWand(host: HTMLElement) {
    const sw = section('Varinha mágica');
    sw.append(Object.assign(document.createElement('p'), { id: 'wandinfo', className: 'shapehint', textContent: 'Clique na imagem para selecionar áreas parecidas e removê-las.' }));
    const mode = document.createElement('div');
    mode.className = 'tools';
    for (const [m, label, title] of [['new', 'Nova', 'Cada clique substitui a seleção'], ['add', '＋ Somar', 'Cada clique soma à seleção (Shift)'], ['sub', '－ Subtrair', 'Cada clique tira da seleção (Alt)']] as const) {
      const b = Object.assign(document.createElement('button'), { className: 'ghost', textContent: label, title });
      b.setAttribute('aria-pressed', String(st.wMode === m));
      b.addEventListener('click', () => { st.wMode = m; mode.querySelectorAll('button').forEach((x) => x.setAttribute('aria-pressed', String(x === b))); });
      mode.append(b);
    }
    sw.append(mode);
    slider(sw, 'Tolerância', () => st.wTol, (v) => { st.wTol = v; const c = st.wClicks[st.wClicks.length - 1]; if (c) { c.tol = v; renderWand(); } }, 0, 100, 1);
    check(sw, 'Somente áreas ligadas ao clique (contígua)', () => st.wContig, (v) => { st.wContig = v; const c = st.wClicks[st.wClicks.length - 1]; if (c) { c.contiguous = v; renderWand(); } });
    slider(sw, 'Suavizar a borda (px)', () => st.wFeather, (v) => (st.wFeather = v), 0, 20, 1);
    const acts = document.createElement('div');
    acts.className = 'tools';
    const rm = Object.assign(document.createElement('button'), { id: 'wandrm', className: 'primary', textContent: 'Remover seleção', title: 'Delete', disabled: true });
    const inv = Object.assign(document.createElement('button'), { id: 'wandinv', className: 'ghost', textContent: 'Inverter', title: 'Seleciona o que não está selecionado (útil para manter só o objeto)', disabled: true });
    const clr = Object.assign(document.createElement('button'), { id: 'wandclr', className: 'ghost', textContent: 'Limpar seleção', disabled: true });
    rm.addEventListener('click', wandRemove);
    inv.addEventListener('click', () => { st.wInvert = !st.wInvert; renderWand(); });
    clr.addEventListener('click', () => { st.wClicks = []; st.wInvert = false; renderWand(); });
    acts.append(rm, inv, clr);
    sw.append(acts);
    const bgb = Object.assign(document.createElement('button'), { className: 'ghost wide', textContent: '✨ Remover fundo (automático)', title: 'Varinha contígua nas bordas com a tolerância atual' });
    bgb.addEventListener('click', removeBackground);
    const reset = Object.assign(document.createElement('button'), { className: 'ghost wide', textContent: `Restaurar tudo (${st.edit.removals.length} remoç${st.edit.removals.length === 1 ? 'ão' : 'ões'})`, disabled: !st.edit.removals.length });
    reset.addEventListener('click', () => { mutate(() => (st.edit.removals = []), true); buildPanel(); });
    sw.append(bgb, reset);
    host.append(sw);
  }

  const SHORT: Record<ShapeKind, string> = { rect: 'Retângulo', rounded: 'Arredond.', ellipse: 'Elipse', triangle: 'Triângulo', polygon: 'Polígono', star: 'Estrela', heart: 'Coração', cross: 'Cruz', line: 'Linha', arrow: 'Seta' };
  const ICON: Record<ShapeKind, string> = {
    rect: '<rect x="4" y="7" width="18" height="12"/>', rounded: '<rect x="4" y="7" width="18" height="12" rx="4"/>', ellipse: '<ellipse cx="13" cy="13" rx="9" ry="7"/>',
    triangle: '<polygon points="13,4 23,22 3,22"/>', polygon: '<polygon points="13,3 22,8 22,18 13,23 4,18 4,8"/>', star: '<polygon points="13,3 16,10 23,10 17,15 19,23 13,18 7,23 9,15 3,10 10,10"/>',
    heart: '<path d="M13 22C4 15 3 9 8 6 11 4 13 7 13 8 13 7 15 4 18 6 23 9 22 15 13 22Z"/>', cross: '<polygon points="10,4 16,4 16,10 22,10 22,16 16,16 16,22 10,22 10,16 4,16 4,10 10,10"/>',
    line: '<line x1="4" y1="22" x2="22" y2="4" stroke-width="2.5"/>', arrow: '<line x1="4" y1="22" x2="20" y2="6" stroke-width="2.5"/><polygon points="23,3 14,6 20,12"/>',
  };

  function buildShapes(host: HTMLElement) {
    const sg = section('Inserir forma');
    const grid = document.createElement('div');
    grid.className = 'shapegrid';
    for (const k of SHAPE_KINDS) {
      const b = document.createElement('button');
      b.title = `Inserir ${k.label.toLowerCase()}`;
      b.innerHTML = `<svg viewBox="0 0 26 26" fill="${isLine(k.id) ? 'none' : 'currentColor'}">${ICON[k.id]}</svg><span>${SHORT[k.id]}</span>`;
      b.addEventListener('click', () => addShape(k.id));
      grid.append(b);
    }
    sg.append(grid);
    colorRow(sg, 'Preenchimento', () => st.fill, (v) => { st.fill = v; const o = selOverlay(); if (o) { beginGesture(); if (isLine(o.kind)) o.stroke = v; else o.fill = v; scheduleRecomposite(); } }, 'fill', { get: () => st.fillOn, set: (v) => { st.fillOn = v; const o = selOverlay(); if (o && !isLine(o.kind)) { mutate(() => (o.fill = v ? st.fill : null)); } } });
    colorRow(sg, 'Contorno', () => st.stroke, (v) => { st.stroke = v; const o = selOverlay(); if (o) { beginGesture(); o.stroke = v; scheduleRecomposite(); } }, 'stroke', { get: () => st.strokeOn, set: (v) => { st.strokeOn = v; const o = selOverlay(); if (o && !isLine(o.kind)) { mutate(() => (o.stroke = v ? st.stroke : null)); } } });
    sg.addEventListener('change', endGesture);
    host.append(sg);

    const o = selOverlay();
    const sp = section(o ? `Forma selecionada: ${o.name}` : 'Forma selecionada');
    if (!o) { sp.append(Object.assign(document.createElement('p'), { className: 'shapehint', textContent: 'Insira uma forma ou clique em uma na imagem. Arraste para mover; alças redimensionam; o círculo no topo gira.' })); host.append(sp); return; }
    const rs = (label: string, get: () => number, set: (v: number) => void, min: number, max: number, step: number, fmt = (v: number) => String(v)) => {
      const inp = slider(sp, label, get, (v) => { beginGesture(); set(v); scheduleRecomposite(); syncShapeBox(); }, min, max, step, fmt);
      inp.addEventListener('change', () => { endGesture(); });
    };
    rs('Opacidade', () => Math.round(o.opacity * 100), (v) => (o.opacity = v / 100), 0, 100, 1, (v) => `${v}%`);
    if (!isLine(o.kind)) rs('Rotação', () => Math.round(o.rot), (v) => (o.rot = v), 0, 359, 1, (v) => `${v}°`);
    rs('Espessura do contorno / linha', () => Math.round(o.strokeW * 10) / 10, (v) => (o.strokeW = v), 0, 12, 0.1, (v) => `${v}%`);
    if (o.kind === 'rounded') rs('Arredondamento', () => Math.round(o.radius * 100), (v) => (o.radius = v / 100), 0, 50, 1, (v) => `${v}%`);
    if (o.kind === 'polygon' || o.kind === 'star') rs(o.kind === 'star' ? 'Pontas' : 'Lados', () => o.sides, (v) => (o.sides = v), 3, 12, 1);
    if (o.kind === 'star') rs('Profundidade da estrela', () => Math.round(o.inner * 100), (v) => (o.inner = v / 100), 15, 90, 1, (v) => `${v}%`);
    const acts = document.createElement('div');
    acts.className = 'tools';
    const dup = Object.assign(document.createElement('button'), { className: 'ghost', textContent: 'Duplicar' });
    const del = Object.assign(document.createElement('button'), { className: 'ghost', textContent: 'Excluir', title: 'Delete' });
    dup.addEventListener('click', duplicateSel); del.addEventListener('click', deleteSel);
    acts.append(dup, del);
    sp.append(acts);
    host.append(sp);
  }

  function buildLayers(host: HTMLElement) {
    const sl = section('Camadas');
    sl.append(Object.assign(document.createElement('p'), { className: 'shapehint', textContent: 'Da frente para o fundo. Arraste as linhas para reordenar; o olho oculta/mostra.' }));
    const zb = document.createElement('div');
    zb.className = 'tools';
    for (const [label, title, d] of [['⤒', 'Trazer para a frente', 'front'], ['↑', 'Avançar um nível', 'up'], ['↓', 'Recuar um nível', 'down'], ['⤓', 'Enviar para trás', 'back']] as const) {
      const b = Object.assign(document.createElement('button'), { className: 'ghost', textContent: label, title, disabled: st.sel === null });
      b.addEventListener('click', () => moveLayer(d));
      zb.append(b);
    }
    sl.append(zb);
    let dragId: number | null = null;
    const rows = document.createElement('div');
    rows.className = 'shaperows';
    for (const o of [...st.edit.overlays].reverse()) {
      const r = document.createElement('div');
      r.className = 'layerrow' + (st.sel === o.id ? ' on' : '') + (o.visible ? '' : ' hid');
      const eye = Object.assign(document.createElement('button'), { className: 'eye', textContent: '👁', title: o.visible ? 'Ocultar' : 'Mostrar' });
      eye.addEventListener('click', (e) => { e.stopPropagation(); mutate(() => (o.visible = !o.visible)); buildPanel(); });
      const sw = document.createElement('i');
      sw.style.background = o.fill ?? o.stroke ?? '#888';
      const nm = document.createElement('span');
      nm.textContent = o.name;
      r.append(eye, sw, nm);
      r.addEventListener('click', () => { st.sel = o.id; buildPanel(); syncShapeBox(); });
      r.draggable = true;
      r.addEventListener('dragstart', (e) => { dragId = o.id; e.dataTransfer?.setData('text/plain', String(o.id)); });
      r.addEventListener('dragover', (e) => { if (dragId === null || dragId === o.id) return; e.preventDefault(); const rc = r.getBoundingClientRect(), top = e.clientY < rc.top + rc.height / 2; r.classList.toggle('drop-top', top); r.classList.toggle('drop-bottom', !top); });
      r.addEventListener('dragleave', () => r.classList.remove('drop-top', 'drop-bottom'));
      r.addEventListener('drop', (e) => {
        e.preventDefault();
        const rc = r.getBoundingClientRect(), top = e.clientY < rc.top + rc.height / 2, id = dragId;
        dragId = null;
        if (id === null || id === o.id) return;
        mutate(() => {
          const list = st.edit.overlays, from = list.findIndex((x) => x.id === id), [m] = list.splice(from, 1), to = list.findIndex((x) => x.id === o.id);
          list.splice(top ? to + 1 : to, 0, m); // metade de cima da linha = na frente dela
        });
        buildPanel();
      });
      rows.append(r);
    }
    // camada da imagem (sempre embaixo)
    const base = document.createElement('div');
    base.className = 'layerrow' + (st.edit.baseVisible ? '' : ' hid');
    const be = Object.assign(document.createElement('button'), { className: 'eye', textContent: '👁', title: st.edit.baseVisible ? 'Ocultar a imagem' : 'Mostrar a imagem' });
    be.addEventListener('click', () => { mutate(() => (st.edit.baseVisible = !st.edit.baseVisible)); buildPanel(); });
    const bi = document.createElement('i');
    bi.style.background = 'linear-gradient(135deg,#888,#ddd)';
    base.append(be, bi, Object.assign(document.createElement('span'), { textContent: 'Imagem' }));
    rows.append(base);
    sl.append(rows);
    slider(sl, 'Opacidade da imagem', () => Math.round(st.edit.baseOpacity * 100), (v) => { beginGesture(); st.edit.baseOpacity = v / 100; scheduleRecomposite(); }, 0, 100, 1, (v) => `${v}%`).addEventListener('change', endGesture);
    const o = selOverlay();
    if (o) {
      const nm = Object.assign(document.createElement('input'), { type: 'text', value: o.name, maxLength: 40, ariaLabel: 'Nome da camada' });
      nm.addEventListener('change', () => mutate(() => (o.name = nm.value || o.name)));
      sl.append(nm);
      slider(sl, 'Opacidade da forma', () => Math.round(o.opacity * 100), (v) => { beginGesture(); o.opacity = v / 100; scheduleRecomposite(); }, 0, 100, 1, (v) => `${v}%`).addEventListener('change', endGesture);
    }
    host.append(sl);
  }

  function syncLayersUi() {
    for (const [tab, fn] of [['shape', buildShapes], ['layers', buildLayers]] as const) {
      const host = document.querySelector<HTMLElement>(`.page[data-tab="${tab}"]`);
      if (host) { host.replaceChildren(); fn(host); }
    }
  }

  function selectTab(tab: Tab) {
    st.tab = tab;
    document.querySelectorAll<HTMLElement>('#enhpanel .page').forEach((p) => (p.hidden = p.dataset.tab !== tab));
    document.querySelectorAll<HTMLElement>('#enhpanel .tabs button').forEach((b) => b.setAttribute('aria-selected', String(b.dataset.tab === tab)));
    setTool(tab === 'wand' ? 'wand' : tab === 'shape' || tab === 'layers' ? 'shape' : 'none');
  }

  function buildPanel() {
    const box = $('enhpanel');
    box.replaceChildren();
    const bar = document.createElement('div');
    bar.className = 'tabs';
    bar.setAttribute('role', 'tablist');
    const pages = {} as Record<Tab, HTMLElement>;
    for (const [id, label] of TABS) {
      const b = Object.assign(document.createElement('button'), { textContent: label });
      b.dataset.tab = id; b.setAttribute('role', 'tab'); b.setAttribute('aria-selected', String(st.tab === id));
      b.addEventListener('click', () => selectTab(id));
      bar.append(b);
      const pg = document.createElement('div');
      pg.className = 'page'; pg.dataset.tab = id; pg.hidden = st.tab !== id;
      pages[id] = pg;
    }
    box.append(bar, ...Object.values(pages));
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
    pages.crop.append(sc);
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
    pages.adj.append(s1);
    buildColors(pages.adj);

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
    pages.out.append(s2);

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
    pages.out.append(s3);

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
    pages.out.append(det);
    buildWand(pages.wand);
    buildShapes(pages.shape);
    buildLayers(pages.layers);
  }

  // ---------- exportação ----------
  const fullImage = () => (full ??= decodeFull(loaded!.file));

  async function render(w: number | null, h: number | null): Promise<RawImage> {
    const src = await fullImage();
    const out = w && h ? specFor(w, h) : undefined;
    const base = (await exporter.run(src, st.params, out, false, st.t, false, st.edit, true)).image; // parte pesada no worker; formas e forma do recorte aqui
    return finalize(base, st.edit, out ?? (st.shape !== 'rect' ? specFor(base.width, base.height) : undefined));
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
  $('eundo').addEventListener('click', undo);
  $('eredo').addEventListener('click', redo);
  window.addEventListener('keydown', (e) => {
    if (document.getElementById('stepE')?.hidden !== false || (e.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName))) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
    else if (e.key === 'Delete' || e.key === 'Backspace') { if (tool === 'wand' && st.wClicks.length) { e.preventDefault(); wandRemove(); } else if (tool === 'shape' && st.sel !== null) { e.preventDefault(); deleteSel(); } }
    else if (e.key === 'Escape') { if (picking) { picking = null; document.getElementById('viewerE')?.classList.remove('picking'); } else if (tool === 'wand') { st.wClicks = []; renderWand(); } else if (tool === 'shape') { st.sel = null; buildPanel(); syncShapeBox(); } }
    else if (tool === 'shape' && st.sel !== null && e.key.startsWith('Arrow')) {
      e.preventDefault();
      const o = selOverlay(), [W, H] = canvasDims(), k = (e.shiftKey ? 10 : 1) / Math.max(1, W);
      if (o) { const dx = e.key === 'ArrowLeft' ? -k : e.key === 'ArrowRight' ? k : 0, dy = (e.key === 'ArrowUp' ? -k : e.key === 'ArrowDown' ? k : 0) * (W / Math.max(1, H)); mutate(() => { o.x += dx; o.x1 += dx; o.x2 += dx; o.y += dy; o.y1 += dy; o.y2 += dy; }); syncShapeBox(); }
    }
  });
  buildPanel();

  return {
    setImage(l: Loaded) {
      loaded = l; full = null; tImage = null; st.t = { ...IDENTITY }; st.cropMode = false; crop.close(); shapeBox.close();
      st.edit = { ...NO_EDIT, removals: [], overlays: [] }; st.params.replaces = []; st.sel = null; st.wClicks = []; hist.length = 0; fut.length = 0;
      wandBase = null; wandView = null; baseProc = null; tool = 'none'; st.tab = 'adj'; updateUndo(); buildPanel(); refresh();
    },
    refresh,
    /** o painel é reconstruído ao voltar para este modo para refletir o estado */
    stop() { preview.cancel(); exporter.cancel(); cropClient.cancel(); shapeBox.close(); if (st.cropMode) { st.cropMode = false; crop.close(); } },
  };
}
