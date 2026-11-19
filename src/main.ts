import './style.css';
import { PRESETS } from './engine/presets';
import { toSVG } from './engine/svg';
import type { Options, VDoc } from './engine/types';
import { EngineClient } from './ui/client';
import { Loaded, LoadError, loadFile } from './ui/loader';
import { SAMPLES, renderSample, sampleToFile } from './ui/samples';
import { Mode, Viewer } from './ui/viewer';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const state = {
  step: 1,
  loaded: null as Loaded | null,
  doc: null as VDoc | null,
  svg: '',
  options: { ...PRESETS[0].options } as Options,
  preset: 'logo' as string,
};

const client = new EngineClient();
const viewer = new Viewer($('viewer'));
const viewer2 = new Viewer($('viewer2'));
viewer2.setMode('vector');

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
  state.step = n;
  for (let i = 1; i <= 3; i++) $(`step${i}`).hidden = i !== n;
  document.querySelectorAll<HTMLButtonElement>('.step').forEach((b) => b.classList.toggle('on', Number(b.dataset.go) === n));
  requestAnimationFrame(() => (n === 2 ? viewer : viewer2).fit());
}
document.querySelectorAll<HTMLButtonElement>('.step').forEach((b) => b.addEventListener('click', () => go(Number(b.dataset.go))));
$('next').addEventListener('click', () => go(3));
$('back').addEventListener('click', () => go(2));

// ---------- upload ----------
async function handleFile(file: File | null | undefined) {
  if (!file) return;
  try {
    const loaded = await loadFile(file);
    if (state.loaded) URL.revokeObjectURL(state.loaded.url);
    state.loaded = loaded;
    state.doc = null;
    document.querySelectorAll<HTMLButtonElement>('.step').forEach((b) => (b.disabled = false));
    go(2);
    process();
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
    state.doc = doc;
    state.svg = toSVG(doc, state.options, { width: l.origWidth, height: l.origHeight });
    viewer.setContent(l.url, doc.width, doc.height, state.svg, doc);
    viewer2.setContent(l.url, doc.width, doc.height, state.svg, doc);
    renderStats();
    setProgress(1, `Pronto em ${Math.round(doc.stats.ms)} ms`);
  } catch (e) {
    if (e instanceof Error && e.message === 'cancelled') return;
    setProgress(0, 'Erro');
    showMsg('Não foi possível vetorizar esta imagem. Tente reduzir o número de cores ou usar uma imagem menor.');
  }
}

function renderStats() {
  const d = state.doc!;
  const st = d.stats;
  const red = st.rawPoints ? Math.round((1 - st.nodes / st.rawPoints) * 100) : 0;
  $('stats').innerHTML = [['nós', st.nodes], ['retas', st.lines], ['arcos', st.arcs], ['curvas', st.curves], ['caminhos', st.paths], ['cores', st.colors]]
    .map(([k, v]) => `<span class="chip"><b>${v}</b> ${k}</span>`).join('')
    + `<span class="chip" title="Pontos de contorno antes do ajuste → nós finais">${st.rawPoints} pts → <b>${st.nodes}</b> nós (−${red}%)</span>`;
  const o = state.options;
  $('summary').textContent = `${o.drawStyle === 'fill' ? 'Preenchido' : 'Contornos'} · ${o.stacking === 'stacked' ? 'Empilhado' : 'Recortes'} · Agrupar: ${o.groupBy === 'color' ? 'cor' : 'nenhum'} · Fenda: ${o.gapFiller && o.stacking === 'cutouts' && o.drawStyle === 'fill' ? 'ligado' : 'desligado'}`;
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
});
$('zin').addEventListener('click', () => viewer.zoomBy(1.4));
$('zout').addEventListener('click', () => viewer.zoomBy(1 / 1.4));
$('zfit').addEventListener('click', () => viewer.fit());

// ---------- presets e avançado ----------
function renderPresets() {
  $('presets').replaceChildren(...PRESETS.map((p) => {
    const b = document.createElement('button');
    b.className = 'preset' + (state.preset === p.id ? ' on' : '');
    b.innerHTML = `<b>${p.label}</b><small>${p.hint}</small>`;
    b.addEventListener('click', () => { state.preset = p.id; state.options = { ...p.options }; renderPresets(); renderAdvanced(); schedule(); });
    return b;
  }));
}

type NumKey = 'maxColors' | 'edgeDelta' | 'mergeDeltaE' | 'speckle' | 'lineFitTolerance' | 'cornerThreshold' | 'smooth' | 'gapStrokeWidth';
const RANGES: [NumKey, string, number, number, number][] = [
  ['maxColors', 'Máximo de cores', 2, 64, 1],
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
  ['groupBy', 'Agrupar por', [['none', 'Sem agrupamento'], ['color', 'Cor']]],
];
const CHECKS: [keyof Options, string][] = [['arcs', 'Ajustar arcos circulares'], ['gapFiller', 'Preencher fendas (gap filler)'], ['removeBackground', 'Remover fundo']];

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

// ---------- download ----------
$('download').addEventListener('click', () => {
  if (!state.svg || !state.loaded) return;
  const url = URL.createObjectURL(new Blob([state.svg], { type: 'image/svg+xml' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `${state.loaded.name}.svg` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

