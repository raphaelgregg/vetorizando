import { PaletteEdits, PaletteEntry, backgroundOriginal, mergeColors, mergeSimilar, normalizeHex, paletteEntries, resetColor, setColor, setHidden } from '../engine/palette';
import type { VDoc } from '../engine/types';

export interface PaletteHost {
  base(): VDoc | null;
  edits(): PaletteEdits;
  /** `live`: edição em andamento (ex.: arrastando o seletor) — não reconstruir a lista para não perder o foco */
  set(edits: PaletteEdits, opts?: { live?: boolean }): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

/** Painel da paleta: editar (seletor/HEX), tornar transparente, mesclar iguais/semelhantes, remover fundo, restaurar. */
export function initPalette(host: PaletteHost) {
  const rows = $('palrows');
  const selected = new Set<string>();

  const hint = (t: string) => { $('palhint').textContent = t; };

  function row(e: PaletteEntry): HTMLElement {
    const el = document.createElement('div');
    el.className = 'palrow' + (e.hidden ? ' off' : '');
    const sel = Object.assign(document.createElement('input'), { type: 'checkbox', checked: selected.has(e.original), title: 'Selecionar para mesclar' });
    sel.setAttribute('aria-label', `Selecionar ${e.original}`);
    sel.addEventListener('change', () => { if (sel.checked) selected.add(e.original); else selected.delete(e.original); });
    const sw = Object.assign(document.createElement('input'), { type: 'color', value: e.color, title: 'Escolher cor' });
    sw.setAttribute('aria-label', `Cor ${e.original}`);
    const hex = Object.assign(document.createElement('input'), { type: 'text', value: e.color, maxLength: 7, className: 'hex', spellcheck: false, title: 'Cor em HEX (#rgb ou #rrggbb)' });
    hex.setAttribute('aria-label', `HEX de ${e.original}`);
    if (e.gradient) {
      sw.style.cssText = 'outline:2px dashed currentColor;outline-offset:1px';
      sw.title = 'Região com gradiente (cor média). Escolher uma cor a substitui por cor sólida';
    }
    const eye = document.createElement('button');
    eye.className = 'eye';
    eye.textContent = '∅';
    eye.title = e.hidden ? 'Transparente — clique para mostrar' : 'Tornar transparente';
    eye.setAttribute('aria-pressed', String(e.hidden));
    sw.addEventListener('input', () => { hex.value = sw.value; hex.classList.remove('bad'); host.set(setColor(host.edits(), e.original, sw.value), { live: true }); });
    sw.addEventListener('change', () => host.set(setColor(host.edits(), e.original, sw.value)));
    const commitHex = () => {
      const n = normalizeHex(hex.value);
      hex.classList.toggle('bad', !n);
      if (n) host.set(setColor(host.edits(), e.original, n));
    };
    hex.addEventListener('change', commitHex);
    hex.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') commitHex(); });
    eye.addEventListener('click', () => host.set(setHidden(host.edits(), e.original, !e.hidden)));
    const meta = document.createElement('div');
    meta.className = 'meta';
    meta.append(`${e.paths} ${e.paths === 1 ? 'forma' : 'formas'}`);
    if (e.edited) {
      const orig = document.createElement('span');
      orig.textContent = `original ${e.original}`;
      const back = document.createElement('button');
      back.textContent = 'restaurar';
      back.addEventListener('click', () => host.set(resetColor(host.edits(), e.original)));
      meta.append(orig, back);
    }
    el.append(sel, sw, hex, eye, meta);
    return el;
  }

  function render() {
    const base = host.base();
    rows.replaceChildren();
    if (!base) { $('palcount').textContent = ''; return; }
    const entries = paletteEntries(base, host.edits());
    for (const s of [...selected]) if (!entries.some((e) => e.original === s)) selected.delete(s);
    const visible = new Set(entries.filter((e) => !e.hidden).map((e) => e.color)).size;
    $('palcount').textContent = `(${visible} ${visible === 1 ? 'cor' : 'cores'}${entries.some((e) => e.hidden) ? ', com transparência' : ''})`;
    rows.append(...entries.map(row));
  }

  $('palbg').addEventListener('click', () => {
    const base = host.base();
    const bg = base && backgroundOriginal(base);
    if (!base || !bg) return;
    const hidden = !!host.edits()[bg]?.hidden;
    host.set(setHidden(host.edits(), bg, !hidden));
    hint(hidden ? 'Fundo restaurado.' : 'Fundo removido (transparente).');
  });
  $('palmerge').addEventListener('click', () => {
    const base = host.base();
    if (!base) return;
    if (selected.size < 2) { hint('Marque 2 ou mais cores na lista para mesclar.'); return; }
    const picked = base.layers.map((l) => l.color).filter((c) => selected.has(c));
    host.set(mergeColors(base, host.edits(), picked));
    selected.clear();
    hint(`${picked.length} cores mescladas numa só.`);
  });
  const sim = $<HTMLInputElement>('palsim');
  sim.addEventListener('input', () => { $('palsimv').textContent = sim.value; });
  $('palsimbtn').addEventListener('click', () => {
    const base = host.base();
    if (!base) return;
    const r = mergeSimilar(base, host.edits(), Number(sim.value));
    if (!r.merged) { hint(`Nenhuma cor com ΔE ≤ ${sim.value} para mesclar.`); return; }
    host.set(r.edits);
    hint(`${r.merged} ${r.merged === 1 ? 'cor mesclada' : 'cores mescladas'} (ΔE ≤ ${sim.value}).`);
  });
  $('palreset').addEventListener('click', () => { selected.clear(); host.set({}); hint('Paleta original restaurada.'); });

  return { render, hint };
}
