import './style.css';
import { autoOptions } from './engine/analyze';
import { PRESETS } from './engine/presets';
import { PaletteEdits, applyPaletteEdits, backgroundOriginal, canHideWithoutReprocess, suggestCurrentColor } from './engine/palette';
import { ShapeEdits, applyShapeEdits, editShapes, hasShapeEdits, listShapes, remapShapeEdits, shapeMapDoc } from './engine/shapes';
import { SvgColors, toSVG } from './engine/svg';
import type { Options, VDoc } from './engine/types';
import { FORMATS, Format, exportDoc } from './export';
import { SizeSpec, Unit, fmt as fnum, resolveSize, sizeInUnit } from './export/size';
import { EngineClient } from './ui/client';
import { initIcons } from './ui/icons';
import { initPalette } from './ui/palette';
import { Overlay } from './ui/handles';
import { initEnhance } from './ui/enhance';
import { initShapes } from './ui/shapes';
import { Loaded, LoadError, loadFile } from './ui/loader';
import { SAMPLES, renderSample, sampleToFile } from './ui/samples';
import { Mode, Viewer } from './ui/viewer';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  step: 1,
  /** o que o usuário quer fazer: vetorizar (SVG/PDF/EPS/DXF) ou só melhorar a imagem e exportar PNG */
  app: 'vector' as 'vector' | 'enhance',
  loaded: null as Loaded | null,
  /** vetor como saiu do motor (sem edições) */
  baseDoc: null as VDoc | null,
  /** edições de paleta, por cor ORIGINAL */
  edits: {} as PaletteEdits,
  svgColors: { mode: 'hex' } as SvgColors,
  /** edições de formas (por id de forma) e histórico para desfazer/refazer */
  shapeEdits: {} as ShapeEdits,
  /** última versão confirmada (o histórico guarda as anteriores; edições ao vivo só mudam `shapeEdits`) */
  shapeCommitted: {} as ShapeEdits,
  nodeMode: false,
  history: [] as ShapeEdits[],
  future: [] as ShapeEdits[],
  selection: new Set<number>(),
  editMode: false,
  mapView: false,
  /** vetor após as edições de formas (base da paleta) */
  midDoc: null as VDoc | null,
  /** vetor com as edições aplicadas: é ele que aparece no preview e vai para todos os exportadores */
  doc: null as VDoc | null,
  svg: '',
  options: { ...PRESETS[0].options } as Options,
  preset: 'auto' as string,
  /** explicação da escolha automática (preset e nº de cores) */
  autoNote: '',
  format: 'svg' as Format,
  size: { unit: 'px', dpi: 96 } as SizeSpec,
};

const client = new EngineClient();
const viewer = new Viewer($('viewer'));
const viewer2 = new Viewer($('viewer2'));
viewer2.setMode('vector');
const viewerE = new Viewer($('viewerE'));
viewerE.setLabels('Antes', 'Depois');

// ---------- tema ----------
function applyTheme(t: string | null) { if (t) document.documentElement.dataset.theme = t; }
try { applyTheme(localStorage.getItem('theme')); } catch { /* sem storage */ }
$('theme').addEventListener('click', () => {
  const cur = document.documentElement.dataset.theme ?? (matchMedia('(prefers-color-scheme:dark)').matches ? 'dark' : 'light');
  const next = cur === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  try { localStorage.setItem('theme', next); } catch { /* ignore */ }
});

// ---------- mensagens ----------
let msgTimer = 0;
function showMsg(text: string) {
  const m = $('msg');
  m.textContent = text; m.hidden = false;
  clearTimeout(msgTimer);
  msgTimer = window.setTimeout(() => (m.hidden = true), 7000);
}

// ---------- navegação ----------
function go(n: number) {
  const enh = state.app === 'enhance';
  if (enh && n === 3) n = 2; // melhorar imagem tem uma só etapa depois do envio
  state.step = n;
  for (let i = 1; i <= 3; i++) $(`step${i}`).hidden = i !== n || (enh && i > 1);
  $('stepE').hidden = !(enh && n === 2);
  document.querySelectorAll<HTMLButtonElement>('.step').forEach((b) => b.classList.toggle('on', Number(b.dataset.go) === n));
  requestAnimationFrame(() => (enh ? viewerE : n === 2 ? viewer : viewer2).fit());
  icons.setActive(!enh && n === 3 && mode3 === 'icons');
}
document.querySelectorAll<HTMLButtonElement>('.step').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.go))));
$('next').addEventListener('click', () => go(3));
$('back').addEventListener('click', () => go(2));

// ---------- modo: vetorizar × só melhorar a imagem ----------
const enhanceUI = initEnhance(viewerE, showMsg);
function setApp(app: 'vector' | 'enhance') {
  state.app = app;
  document.querySelectorAll<HTMLButtonElement>('[data-app]').forEach((b) => b.classList.toggle('on', b.dataset.app === app));
  const enh = app === 'enhance';
  document.querySelector<HTMLButtonElement>('.step[data-go="2"]')!.innerHTML = `<b>2</b> ${enh ? 'Melhorar e exportar' : 'Inspecionar'}`;
  $('step3').hidden = true;
  document.querySelector<HTMLButtonElement>('.step[data-go="3"]')!.hidden = enh;
  if (!enh) enhanceUI.stop();
  if (state.loaded) {
    go(Math.max(2, state.step));
    if (enh) enhanceUI.setImage(state.loaded); else if (!state.baseDoc) process();
  } else go(1);
}
document.querySelectorAll<HTMLButtonElement>('[data-app]').forEach((b) => b.addEventListener('click', () => setApp(b.dataset.app as 'vector' | 'enhance')));
document.querySelectorAll<HTMLButtonElement>('[data-emode]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-emode]').forEach((x) => x.classList.toggle('on', x === b));
  viewerE.setMode(b.dataset.emode as Mode);
}));
$('ezin').addEventListener('click', () => viewerE.zoomBy(1.25));
$('ezout').addEventListener('click', () => viewerE.zoomBy(1 / 1.25));
$('ezfit').addEventListener('click', () => viewerE.fit());

// ---------- upload ----------
async function handleFile(file: File | null | undefined) {
  if (!file) return;
  try {
    const loaded = await loadFile(file);
    if (state.loaded) URL.revokeObjectURL(state.loaded.url);
    state.loaded = loaded;
    state.doc = null;
    state.baseDoc = null;
    state.edits = {};
    applyAuto(); renderPresets(); renderAdvanced();
    state.shapeEdits = {}; state.shapeCommitted = {}; state.history = []; state.future = []; state.selection = new Set(); state.midDoc = null;
    icons.setName(loaded.name);
    state.size = { unit: 'px', dpi: Number($<HTMLInputElement>('dpi').value) || 96 };
    refreshSize();
    document.querySelectorAll<HTMLButtonElement>('.step').forEach((b) => (b.disabled = false));
    go(2);
    if (state.app === 'enhance') enhanceUI.setImage(loaded); else process();
  } catch (e) {
    showMsg(e instanceof LoadError ? e.message : 'Erro ao abrir a imagem.');
  }
}
const drop = $('drop'), fileInput = $<HTMLInputElement>('file');
drop.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInput.click(); } });
fileInput.addEventListener('change', () => { handleFile(fileInput.files?.[0]); fileInput.value = ''; });
window.addEventListener('dragover', (e) => { e.preventDefault(); drop.classList.add('over'); });
window.addEventListener('dragleave', (e) => { if (!e.relatedTarget) drop.classList.remove('over'); });
window.addEventListener('drop', (e) => { e.preventDefault(); drop.classList.remove('over'); handleFile(e.dataTransfer?.files[0]); });
window.addEventListener('paste', (e) => {
  const item = [...(e.clipboardData?.items ?? [])].find((i) => i.type.startsWith('image/'));
  if (item) handleFile(item.getAsFile());
  else if (e.clipboardData?.files.length === 0 && !(e.target instanceof HTMLInputElement)) showMsg('Nenhuma imagem encontrada na área de transferência.');
});

// exemplos
for (const s of SAMPLES) {
  const b = document.createElement('button');
  b.className = 'sample';
  b.append(renderSample(s, 240), Object.assign(document.createElement('span'), { textContent: s.label }));
  b.addEventListener('click', async () => handleFile(await sampleToFile(s)));
  $('samples').append(b);
}

// ---------- processamento ----------
let debounce = 0;
function schedule() { clearTimeout(debounce); debounce = window.setTimeout(process, 250); }

function setProgress(f: number, label: string) {
  for (const id of ['prog', 'prog2']) {
    $(id).querySelector<HTMLElement>('i')!.style.width = `${Math.round(f * 100)}%`;
    $(id).querySelector('span')!.textContent = label;
  }
}

async function process() {
  const l = state.loaded;
  if (!l) return;
  try {
    const doc = await client.run(l.image, state.options, setProgress);
    state.baseDoc = doc;
    if (hasShapeEdits(state.shapeEdits)) {
      // reprocessado: as edições de formas são reaplicadas pelas âncoras (ponto dentro da forma + área)
      const r = remapShapeEdits(doc, state.shapeEdits);
      state.shapeEdits = r.edits;
      state.shapeCommitted = r.edits;
      if (r.dropped || r.orderLost) showMsg([r.dropped ? `${r.dropped} edição(ões) de formas não encontraram correspondência após reprocessar e foram descartadas.` : '', r.orderLost ? 'A ordem das camadas foi redefinida ao reprocessar.' : ''].filter(Boolean).join(' '));
    }
    state.history = []; state.future = []; state.selection = new Set();
    refreshFromEdits();
    setProgress(1, `Pronto em ${Math.round(doc.stats.ms)} ms`);
  } catch (e) {
    if (e instanceof Error && e.message === 'cancelled') return;
    setProgress(0, 'Erro');
    showMsg('Não foi possível vetorizar esta imagem. Tente reduzir o número de cores ou usar uma imagem menor.');
  }
}

/** Reaplica as edições de paleta ao vetor base e atualiza TUDO que depende dele (preview, Raio‑X, estatísticas, SVG, ícones). */
let refreshRaf = 0;
function refreshFromEdits(live = false) {
  const l = state.loaded;
  if (!state.baseDoc || !l) return;
  state.midDoc = applyShapeEdits(state.baseDoc, state.shapeEdits);
  state.doc = applyPaletteEdits(state.midDoc, state.edits);
  const paint = () => {
    refreshRaf = 0;
    if (!state.doc || !state.loaded) return;
    state.svg = toSVG(state.doc, state.options, { width: l.origWidth, height: l.origHeight }, { mode: 'hex', gradients: state.svgColors.gradients, objects: state.svgColors.objects });
    // "Mapa de formas": só a prévia do estúdio mostra cada forma com uma cor sólida distinta; o SVG exportado não muda
    const view = state.mapView ? toSVG(shapeMapDoc(state.doc), { ...state.options, gapFiller: false, groupBy: 'none' }, { width: l.origWidth, height: l.origHeight }) : state.svg;
    viewer.setContent(l.url, state.doc.width, state.doc.height, view, state.doc);
    viewer2.setContent(l.url, state.doc.width, state.doc.height, state.svg, state.doc);
    shapes.render(live);
    viewer.setSelection(shapes.overlay());
    if (!live) refreshOverlay();
    renderStats();
    syncCurrentColor();
    icons.invalidate();
  };
  updateHistoryButtons();
  if (live) { if (!refreshRaf) refreshRaf = requestAnimationFrame(paint); } else { cancelAnimationFrame(refreshRaf); paint(); palette.render(); }
}

function renderStats() {
  const d = state.doc!;
  const st = d.stats;
  const red = st.rawPoints ? Math.round((1 - st.nodes / st.rawPoints) * 100) : 0;
  $('stats').innerHTML = [['nós', st.nodes], ['retas', st.lines], ['arcos', st.arcs], ['elipses', st.ellipses], ['curvas', st.curves], ['caminhos', st.paths], ['cores', st.colors]]
    .map(([k, v]) => `<span class="chip"><b>${v}</b> ${k}</span>`).join('')
    + (st.gradients ? `<span class="chip" title="Regiões de variação suave reconstruídas com gradiente linear/radial (menos nós, sem bandas)"><b>${st.gradients}</b> gradiente${st.gradients > 1 ? 's' : ''}</span>` : '')
    + (st.denoised ? `<span class="chip" title="Ruído/artefatos JPEG detectados: pré-filtro com preservação de bordas aplicado antes da vetorização">ruído σ̂ ${st.noise.toFixed(1)} · filtrado</span>` : '')
    + `<span class="chip" title="Pontos de contorno antes do ajuste → nós finais">${st.rawPoints} pts → <b>${st.nodes}</b> nós (−${red}%)</span>`;
  const o = state.options;
  $('summary').textContent = `${o.drawStyle === 'fill' ? 'Preenchido' : 'Contornos'} · ${o.stacking === 'stacked' ? 'Empilhado' : 'Recortes'} · Agrupar: ${o.groupBy === 'color' ? 'cor' : o.groupBy === 'layer' ? 'camada' : 'nenhum'} · Fenda: ${o.gapFiller && o.stacking === 'cutouts' && o.drawStyle === 'fill' ? 'ligado' : 'desligado'}`;
}

// ---------- toolbar do estúdio ----------
document.querySelectorAll<HTMLButtonElement>('[data-mode]').forEach((b) => b.addEventListener('click', () => {
  document.querySelectorAll('[data-mode]').forEach((x) => x.classList.toggle('on', x === b));
  viewer.setMode(b.dataset.mode as Mode);
}));
$('wire').addEventListener('click', (e) => {
  const b = e.currentTarget as HTMLElement;
  const on = b.getAttribute('aria-pressed') !== 'true';
  b.setAttribute('aria-pressed', String(on));
  viewer.setWire(on);
  $('legend').hidden = !on;
});
$('zin').addEventListener('click', () => viewer.zoomBy(1.4));
$('zout').addEventListener('click', () => viewer.zoomBy(1 / 1.4));
$('zfit').addEventListener('click', () => viewer.fit());

// ---------- presets e avançado ----------
/** Analisa a imagem carregada e aplica preset/cores sugeridos (modo Automático). */
function applyAuto() {
  const l = state.loaded;
  if (!l) return;
  const a = autoOptions(l.image);
  state.options = { ...a.options };
  state.preset = 'auto';
  state.autoNote = `${PRESETS.find((p) => p.id === a.suggestion.preset)!.label} · ${a.options.maxColors} cores — ${a.suggestion.reason}`;
}

function renderPresets() {
  const auto = document.createElement('button');
  auto.className = 'preset' + (state.preset === 'auto' ? ' on' : '');
  auto.innerHTML = `<b>Automático</b><small>${state.preset === 'auto' && state.autoNote ? state.autoNote : 'Analisa a imagem e escolhe preset e nº de cores'}</small>`;
  auto.addEventListener('click', () => { applyAuto(); renderPresets(); renderAdvanced(); schedule(); });
  $('presets').replaceChildren(auto, ...PRESETS.map((p) => {
    const b = document.createElement('button');
    b.className = 'preset' + (state.preset === p.id ? ' on' : '');
    b.innerHTML = `<b>${p.label}</b><small>${p.hint}</small>`;
    b.addEventListener('click', () => { state.preset = p.id; state.options = { ...p.options }; renderPresets(); renderAdvanced(); schedule(); });
    return b;
  }));
}

type NumKey = 'maxColors' | 'denoise' | 'edgeDelta' | 'mergeDeltaE' | 'speckle' | 'lineFitTolerance' | 'cornerThreshold' | 'smooth' | 'gapStrokeWidth';
const RANGES: [NumKey, string, number, number, number][] = [
  ['maxColors', 'Máximo de cores', 2, 64, 1],
  ['denoise', 'Redução de ruído / JPEG (0 = desligada · 1 = automática)', 0, 3, 0.5],
  ['mergeDeltaE', 'Mesclar tons próximos (ΔE)', 0, 25, 1],
  ['speckle', 'Remover manchas (px²)', 0, 100, 1],
  ['lineFitTolerance', 'Tolerância de ajuste (px)', 0.1, 3, 0.1],
  ['cornerThreshold', 'Ângulo de canto (°)', 20, 120, 5],
  ['smooth', 'Suavizar ruído do contorno (px)', 0, 10, 1],
  ['edgeDelta', 'Limpeza de bordas / anti-aliasing (ΔE)', 0, 20, 1],
  ['gapStrokeWidth', 'Largura do preenchimento de fendas', 0, 3, 0.1],
];
const SELECTS: [keyof Options, string, [string, string][]][] = [
  ['stacking', 'Empilhamento', [['cutouts', 'Recortes (sem sobreposição)'], ['stacked', 'Empilhado (camadas)']]],
  ['drawStyle', 'Estilo de desenho', [['fill', 'Preenchido'], ['outline', 'Contornos']]],
  ['groupBy', 'Agrupar por', [['none', 'Sem agrupamento'], ['color', 'Cor'], ['layer', 'Camada (ordem de empilhamento)']]],
];
const CHECKS: [keyof Options, string][] = [['arcs', 'Ajustar arcos circulares'], ['ellipses', 'Ajustar arcos elípticos'], ['gradients', 'Detectar gradientes (SVG; PDF/EPS/DXF/Android usam bandas sólidas)'], ['gapFiller', 'Preencher fendas (gap filler)'], ['removeBackground', 'Remover fundo']];

function renderAdvanced() {
  const box = $('adv');
  box.replaceChildren();
  const o = state.options as unknown as Record<string, number | string | boolean>;
  const changed = () => { state.preset = 'custom'; renderPresets(); schedule(); };
  for (const [k, label, min, max, step] of RANGES) {
    const lab = document.createElement('label');
    const out = document.createElement('output');
    out.textContent = String(o[k]);
    lab.innerHTML = `<span>${label}</span>`;
    lab.firstElementChild!.append(out);
    const inp = Object.assign(document.createElement('input'), { type: 'range', min: String(min), max: String(max), step: String(step), value: String(o[k]) });
    inp.addEventListener('input', () => { o[k] = Number(inp.value); out.textContent = inp.value; changed(); });
    lab.append(inp);
    box.append(lab);
  }
  for (const [k, label, opts] of SELECTS) {
    const lab = document.createElement('label');
    lab.innerHTML = `<span>${label}</span>`;
    const sel = document.createElement('select');
    for (const [v, t] of opts) sel.add(new Option(t, v, false, o[k] === v));
    sel.addEventListener('change', () => { o[k] = sel.value; changed(); });
    lab.append(sel);
    box.append(lab);
  }
  for (const [k, label] of CHECKS) {
    const lab = document.createElement('label');
    lab.className = 'chk';
    const c = Object.assign(document.createElement('input'), { type: 'checkbox', checked: Boolean(o[k]) });
    c.addEventListener('change', () => { o[k] = c.checked; changed(); });
    lab.append(c, label);
    box.append(lab);
  }
}
renderPresets();
renderAdvanced();

// ---------- formato, tamanho e download ----------
const HINTS: Record<Format, string> = {
  svg: 'Vetor para web e editores (Inkscape, Illustrator, Figma).',
  pdf: 'Vetorial para impressão. Agrupar por cor/camada cria camadas opcionais (PDF 1.5).',
  eps: 'PostScript nível 3 (EPSF‑3.0). Grupos ficam como comentários (PostScript não tem camadas).',
  dxf: 'CAD/CNC: só contornos fechados (sem preenchimento), arcos nativos; Béziers viram polilinhas. Uma layer por grupo.',
};

function renderFormats() {
  $('fmt').replaceChildren(...FORMATS.map((f) => {
    const b = document.createElement('button');
    b.textContent = f.label;
    b.title = f.hint;
    b.className = state.format === f.id ? 'on' : '';
    b.addEventListener('click', () => { state.format = f.id; renderFormats(); });
    return b;
  }));
  $('fmthint').textContent = HINTS[state.format];
  $('download').textContent = `Baixar ${state.format.toUpperCase()}`;
}

function origDims() {
  const l = state.loaded;
  return { w: l?.origWidth ?? 1, h: l?.origHeight ?? 1 };
}

function refreshSize(skip?: 'w' | 'h') {
  const { w, h } = origDims();
  const r = resolveSize(state.size, w, h, w, h);
  const pct = state.size.unit === '%';
  if (skip !== 'w') $<HTMLInputElement>('sw').value = fnum(pct ? (state.size.width ?? 100) : r.width, 3);
  if (skip !== 'h') $<HTMLInputElement>('sh').value = fnum(pct ? (state.size.width ?? 100) : r.height, 3);
  $<HTMLInputElement>('sh').disabled = pct;
  $<HTMLInputElement>('unit').value = state.size.unit;
  $('sizeinfo').textContent = `Saída: ${fnum(r.width, 2)} × ${fnum(r.height, 2)} ${r.unit}` + (r.unit !== 'px' ? ` (${Math.round(r.width * (r.unit === 'mm' ? state.size.dpi / 25.4 : state.size.dpi / 2.54))} × ${Math.round(r.height * (r.unit === 'mm' ? state.size.dpi / 25.4 : state.size.dpi / 2.54))} px a ${state.size.dpi} dpi)` : '');
}

$('unit').addEventListener('change', () => {
  const unit = $<HTMLSelectElement>('unit').value as Unit;
  const { w, h } = origDims();
  const d = sizeInUnit(unit, w, h, state.size.dpi);
  state.size = { unit, dpi: state.size.dpi, width: unit === '%' ? 100 : d.width };
  refreshSize();
});
$('dpi').addEventListener('input', () => {
  const v = Number($<HTMLInputElement>('dpi').value);
  if (!(v >= 36 && v <= 2400)) return;
  state.size = { ...state.size, dpi: v };
  refreshSize();
});
$('sw').addEventListener('input', () => {
  const v = Number($<HTMLInputElement>('sw').value);
  if (v > 0) { state.size = { ...state.size, width: v }; refreshSize('w'); }
});
$('sh').addEventListener('input', () => {
  const v = Number($<HTMLInputElement>('sh').value);
  const { w, h } = origDims();
  if (v > 0) { state.size = { ...state.size, width: (v * w) / h }; refreshSize('h'); }
});

$('download').addEventListener('click', () => {
  if (!state.doc || !state.loaded) return;
  const { w, h } = origDims();
  let e;
  try {
    e = exportDoc(state.format, state.doc, state.options, state.size, w, h, state.svgColors);
  } catch {
    showMsg('Não foi possível gerar o arquivo neste formato.');
    return;
  }
  const url = URL.createObjectURL(new Blob([e.data as BlobPart], { type: e.mime }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${state.loaded.name}.${e.ext}` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});
renderFormats();
refreshSize();

// ---------- paleta de cores (edição sobre o vetor gerado) ----------
const palette = initPalette({
  base: () => state.midDoc,
  edits: () => state.edits,
  set(edits, opts) {
    const base = state.midDoc;
    if (!base) return;
    const newlyHidden = Object.keys(edits).filter((k) => edits[k].hidden && !state.edits[k]?.hidden);
    state.edits = edits;
    // em "empilhado", ocultar uma camada que não é a de baixo revelaria a camada de baixo dela (não transparência):
    // muda para "Recortes" e reprocessa; as edições são por cor original e continuam valendo
    if (state.options.stacking === 'stacked' && newlyHidden.some((k) => !canHideWithoutReprocess(base, k))) {
      state.options = { ...state.options, stacking: 'cutouts' };
      state.preset = 'custom';
      renderPresets();
      renderAdvanced();
      showMsg('Transparência em camadas empilhadas exige o modo “Recortes”: reprocessando a imagem.');
      palette.render();
      process();
      return;
    }
    refreshFromEdits(!!opts?.live);
  },
});

// ---------- edição de formas: selecionar · excluir · recolorir · fundir · desfazer ----------
function updateHistoryButtons() {
  $<HTMLButtonElement>('undo').disabled = !state.history.length;
  $<HTMLButtonElement>('redo').disabled = !state.future.length;
}
function commitShapes(edits: ShapeEdits) {
  state.history.push(state.shapeCommitted);
  if (state.history.length > 100) state.history.shift();
  state.future = [];
  state.shapeCommitted = edits;
  state.shapeEdits = edits;
  refreshFromEdits();
}
/** edição ao vivo (arrastando/ajustando): atualiza a prévia sem entrar no histórico */
function previewShapes(edits: ShapeEdits) { state.shapeEdits = edits; refreshFromEdits(true); }
function undo() { const p = state.history.pop(); if (p) { state.future.push(state.shapeCommitted); state.shapeCommitted = p; state.shapeEdits = p; refreshFromEdits(); } }
function redo() { const n = state.future.pop(); if (n) { state.history.push(state.shapeCommitted); state.shapeCommitted = n; state.shapeEdits = n; refreshFromEdits(); } }
const overlay = new Overlay(viewer);
overlay.onInfo = (t) => { $('shapehint').textContent = t; };
/** alças sobre a prévia da forma selecionada: pontos/alças de Bézier (Editar pontos) ou alças do gradiente */
function refreshOverlay() {
  overlay.close();
  const ids = [...state.selection];
  const one = state.editMode && ids.length === 1;
  $<HTMLButtonElement>('nodes').disabled = !one;
  if (!one && state.nodeMode) { state.nodeMode = false; setToggle('nodes', false); $('nodebar').hidden = true; }
  const s = one && state.doc && state.baseDoc ? listShapes(state.doc).find((x) => x.id === ids[0]) : undefined;
  if (!s) return;
  const base = state.baseDoc!, id = s.id;
  if (state.nodeMode) overlay.openNodes(s.paths, id, (paths) => commitShapes(editShapes(base, state.shapeEdits, [id], { geom: paths })), (d) => viewer.setSelection(d));
  else if (s.gradient) overlay.openGradient(s.gradient, (g) => previewShapes(editShapes(base, state.shapeEdits, [id], { gradient: g })), (g) => commitShapes(editShapes(base, state.shapeEdits, [id], { gradient: g })));
}
const shapes = initShapes({
  base: () => state.baseDoc,
  doc: () => state.doc,
  edits: () => state.shapeEdits,
  selection: () => state.selection,
  setSelection(s) { state.selection = s; shapes.render(); viewer.setSelection(shapes.overlay()); refreshOverlay(); },
  commit: commitShapes,
  preview: previewShapes,
  hint: (t) => { $('shapehint').textContent = t; },
  picking: (on) => $('viewer').classList.toggle('picking', on),
});
viewer.onPick = (x, y, shift, alt) => shapes.pick(x, y, shift, alt);
viewer.onRect = (r, shift, alt) => shapes.rect(r, shift, alt);
$('undo').addEventListener('click', undo);
$('redo').addEventListener('click', redo);
function setToggle(id: string, on: boolean) { $(id).setAttribute('aria-pressed', String(on)); }
$('edit').addEventListener('click', () => {
  state.editMode = !state.editMode;
  setToggle('edit', state.editMode);
  viewer.setEditMode(state.editMode);
  if (state.editMode) document.querySelector<HTMLButtonElement>('[data-mode="vector"]')?.click();
  viewer.setSelection(shapes.overlay());
  refreshOverlay();
});
$('nodes').addEventListener('click', () => {
  state.nodeMode = !state.nodeMode;
  setToggle('nodes', state.nodeMode);
  $('nodebar').hidden = !state.nodeMode;
  refreshOverlay();
});
$('ndel').addEventListener('click', () => overlay.deleteNode());
$('ntog').addEventListener('click', () => overlay.toggleEdge());
$('npath').addEventListener('click', () => overlay.deletePath());
$('shapemap').addEventListener('click', () => {
  state.mapView = !state.mapView;
  setToggle('shapemap', state.mapView);
  if (state.mapView && !state.editMode) $('edit').click();
  refreshFromEdits();
});
window.addEventListener('keydown', (e) => {
  if (state.app !== 'vector' || state.step !== 2 || (e.target instanceof HTMLElement && /^(INPUT|SELECT|TEXTAREA)$/.test(e.target.tagName))) return;
  const mod = e.ctrlKey || e.metaKey;
  if (mod && state.editMode && (e.code === 'BracketRight' || e.code === 'BracketLeft')) { e.preventDefault(); const up = e.code === 'BracketRight'; shapes.reorder(e.shiftKey ? (up ? 'front' : 'back') : up ? 'forward' : 'backward'); return; }
  if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); if (e.shiftKey) redo(); else undo(); }
  else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); redo(); }
  else if (state.nodeMode && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); overlay.deleteNode(); } // em "Editar pontos" Delete nunca exclui a forma inteira
  else if (state.editMode && (e.key === 'Delete' || e.key === 'Backspace')) { e.preventDefault(); shapes.del(); }
  else if (state.editMode && e.key === 'Escape' && shapes.copying) shapes.cancelCopy();
  else if (state.editMode && e.key === 'Escape') { state.selection = new Set(); shapes.render(); viewer.setSelection(''); refreshOverlay(); }
});

// ---------- cores do SVG exportado: hex · currentColor · classes CSS ----------
const svgColor = $<HTMLSelectElement>('svgcolor'), ccsel = $<HTMLSelectElement>('ccsel');
function syncCurrentColor() {
  const doc = state.doc;
  if (!doc) return;
  const colors = [...new Set(doc.layers.map((l) => l.color))];
  ccsel.replaceChildren(...colors.map((c) => new Option(c, c)));
  const want = state.svgColors.currentColor && colors.includes(state.svgColors.currentColor) ? state.svgColors.currentColor : suggestCurrentColor(doc);
  if (want) ccsel.value = want;
  if (state.svgColors.mode === 'currentColor') state.svgColors = { ...state.svgColors, mode: 'currentColor', currentColor: want };
  const hasGrad = doc.layers.some((l) => l.gradient);
  $('gradwrap').hidden = !hasGrad;
  $('ccwrap').hidden = state.svgColors.mode !== 'currentColor';
}
const svgObj = $<HTMLInputElement>('svgobj');
svgObj.addEventListener('change', () => { state.svgColors = { ...state.svgColors, objects: svgObj.checked }; refreshFromEdits(); icons.invalidate(); });
const svgGrad = $<HTMLSelectElement>('svggrad');
svgGrad.addEventListener('change', () => { state.svgColors = { ...state.svgColors, gradients: svgGrad.value !== 'solid' }; refreshFromEdits(); icons.invalidate(); });
svgColor.addEventListener('change', () => {
  state.svgColors = { mode: svgColor.value as SvgColors['mode'], currentColor: ccsel.value || undefined, gradients: state.svgColors.gradients, objects: state.svgColors.objects };
  syncCurrentColor();
  icons.invalidate();
});
ccsel.addEventListener('change', () => { state.svgColors = { ...state.svgColors, mode: 'currentColor', currentColor: ccsel.value }; icons.invalidate(); });

// ---------- exportar: vetor ou ícones (Web · Android · iOS) ----------
let mode3: 'vector' | 'icons' = 'vector';
const icons = initIcons({
  doc: () => state.doc,
  options: () => state.options,
  svgColors: () => state.svgColors,
  name: () => state.loaded?.name ?? 'icone',
  origWidth: () => state.loaded?.origWidth ?? 512,
  backgroundColor: () => (state.midDoc ? backgroundOriginal(state.midDoc) : null),
});
function setMode3(m: 'vector' | 'icons') {
  mode3 = m;
  document.querySelectorAll<HTMLButtonElement>('[data-m3]').forEach((b) => b.classList.toggle('on', b.dataset.m3 === m));
  $('vecpanel').hidden = m !== 'vector';
  $('iconpanel').hidden = m !== 'icons';
  $('viewer2').hidden = m === 'icons';
  $('iconfiles').hidden = m !== 'icons';
  icons.setActive(m === 'icons' && state.step === 3);
  if (m === 'vector') requestAnimationFrame(() => viewer2.fit());
}
document.querySelectorAll<HTMLButtonElement>('[data-m3]').forEach((b) => b.addEventListener('click', () => setMode3(b.dataset.m3 as 'vector' | 'icons')));
