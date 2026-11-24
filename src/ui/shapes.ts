import { pathData } from '../engine/svg';
import { ShapeEdits, editShapes, listShapes, shapesAt, shapesInRect, similarShapes } from '../engine/shapes';
import type { Gradient, VDoc } from '../engine/types';

export interface ShapesHost {
  /** vetor como saiu do motor (todas as formas, inclusive as excluídas) */
  base(): VDoc | null;
  /** vetor exibido (com edições) */
  doc(): VDoc | null;
  edits(): ShapeEdits;
  selection(): Set<number>;
  setSelection(s: Set<number>): void;
  commit(edits: ShapeEdits): void;
  hint(text: string): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const css = (c: string, g?: Gradient): string => (g ? `linear-gradient(90deg,${g.stops.map((s) => `${s.color} ${Math.round(s.offset * 100)}%`).join(',')})` : c);

/** Painel e interações de edição de formas (seleção por clique/retângulo, excluir, recolorir, fundir, restaurar). */
export function initShapes(host: ShapesHost) {
  const rows = $('shaperows');
  const sel = () => host.selection();

  /** dados de caminho das formas selecionadas (para o realce na prévia) */
  function overlay(): string {
    const doc = host.doc();
    if (!doc || !sel().size) return '';
    return listShapes(doc).filter((s) => sel().has(s.id)).map((s) => s.paths.map(pathData).join('')).join('');
  }

  function render() {
    const doc = host.doc(), base = host.base();
    rows.replaceChildren();
    $('shhidden').replaceChildren();
    if (!doc || !base) { $('shapecount').textContent = ''; return; }
    const shapes = listShapes(doc);
    for (const id of [...sel()]) if (!shapes.some((s) => s.id === id)) sel().delete(id);
    const hiddenIds = Object.entries(host.edits()).filter(([, e]) => e.hidden).map(([k]) => Number(k));
    $('shapecount').textContent = `(${shapes.length}${hiddenIds.length ? ` · ${hiddenIds.length} excluída${hiddenIds.length > 1 ? 's' : ''}` : ''})`;
    const n = sel().size;
    for (const id of ['shdel', 'shmerge', 'shsim', 'shnone']) $<HTMLButtonElement>(id).disabled = id === 'shmerge' ? n < 2 : n === 0;
    $<HTMLInputElement>('shcolor').disabled = n === 0;
    if (n === 1) { const s = shapes.find((x) => sel().has(x.id)); if (s && !s.gradient) $<HTMLInputElement>('shcolor').value = s.color; }
    host.hint(n ? `${n} ${n === 1 ? 'forma selecionada' : 'formas selecionadas'}` : 'Clique numa forma para selecioná-la; arraste para selecionar várias (Shift soma · Alt escolhe a de trás).');
    const list = [...shapes].sort((a, b) => b.area - a.area).slice(0, 60);
    for (const s of list) {
      const r = document.createElement('div');
      r.className = 'shaperow' + (sel().has(s.id) ? ' on' : '');
      const sw = document.createElement('i');
      sw.style.background = css(s.color, s.gradient);
      const t = document.createElement('div');
      t.textContent = `${s.gradient ? 'gradiente' : s.color} `;
      const m = document.createElement('span');
      m.textContent = `${s.nodes} nós`;
      const a = document.createElement('span');
      a.textContent = s.area >= 1000 ? `${(s.area / 1000).toFixed(1)}k px²` : `${Math.round(s.area)} px²`;
      t.append(m);
      r.append(sw, t, a);
      r.addEventListener('click', (e) => toggle(s.id, e.shiftKey || e.ctrlKey || e.metaKey));
      rows.append(r);
    }
    if (shapes.length > list.length) rows.append(Object.assign(document.createElement('span'), { textContent: `… e mais ${shapes.length - list.length} formas menores (selecione na prévia)`, className: 'shapehint' }));
    if (hiddenIds.length) {
      const box = $('shhidden');
      box.append(`Excluídas: `);
      for (const id of hiddenIds.slice(0, 8)) {
        const s = base ? listShapes(base).find((x) => x.id === id) : undefined;
        const b = document.createElement('button');
        b.textContent = `restaurar ${s ? Math.round(s.area) + ' px²' : '#' + id}`;
        b.addEventListener('click', () => host.commit(editShapes(base, host.edits(), [id], null)));
        box.append(b);
      }
      const all = document.createElement('button');
      all.textContent = 'restaurar todas';
      all.addEventListener('click', () => host.commit(editShapes(base, host.edits(), hiddenIds, null)));
      box.append(all);
    }
  }

  function toggle(id: number, add: boolean) {
    const s = new Set(sel());
    if (add) { if (s.has(id)) s.delete(id); else s.add(id); } else { s.clear(); s.add(id); }
    host.setSelection(s);
  }

  function pick(x: number, y: number, shift: boolean, alt: boolean) {
    const doc = host.doc();
    if (!doc) return;
    const hit = shapesAt(doc, x, y);
    if (!hit.length) { if (!shift) host.setSelection(new Set()); return; }
    // Alt: a próxima forma atrás da já selecionada (úteis em camadas empilhadas)
    let id = hit[0];
    if (alt) { const cur = hit.findIndex((h) => sel().has(h)); id = hit[Math.min(hit.length - 1, cur + 1)] ?? hit[0]; }
    toggle(id, shift);
  }

  function rect(r: [number, number, number, number], shift: boolean, alt: boolean) {
    const doc = host.doc();
    if (!doc) return;
    const ids = shapesInRect(doc, r, alt); // Alt: também as que apenas tocam o retângulo
    const s = shift ? new Set(sel()) : new Set<number>();
    for (const id of ids) s.add(id);
    host.setSelection(s);
  }

  const ids = () => [...sel()];
  const base = () => host.base();
  const del = () => { const b = base(); if (b && sel().size) { const n = sel().size; host.commit(editShapes(b, host.edits(), ids(), { hidden: true })); host.setSelection(new Set()); host.hint(`${n} ${n === 1 ? 'forma excluída' : 'formas excluídas'}. Desfazer: Ctrl+Z.${host.doc()?.stacking === 'stacked' ? ' Em “Empilhado” aparece a camada de baixo; use “Recortes” para deixar transparente.' : ''}`); } };
  $('shdel').addEventListener('click', del);
  $('shcolor').addEventListener('change', () => { const b = base(); if (b && sel().size) host.commit(editShapes(b, host.edits(), ids(), { color: $<HTMLInputElement>('shcolor').value, hidden: false })); });
  $('shmerge').addEventListener('click', () => {
    const b = base(), doc = host.doc();
    if (!b || !doc || sel().size < 2) return;
    const shapes = listShapes(doc).filter((s) => sel().has(s.id));
    const main = shapes.reduce((a, c) => (c.area > a.area ? c : a));
    host.commit(editShapes(b, host.edits(), ids().filter((i) => i !== main.id), { mergeInto: main.id }));
    host.setSelection(new Set([main.id]));
    host.hint(`${shapes.length} formas fundidas em uma (a maior define a cor).`);
  });
  $('shsim').addEventListener('click', () => {
    const doc = host.doc();
    if (!doc || !sel().size) return;
    const s = new Set<number>();
    for (const id of ids()) for (const x of similarShapes(doc, id)) s.add(x);
    host.setSelection(s);
  });
  $('shnone').addEventListener('click', () => host.setSelection(new Set()));

  return { render, overlay, pick, rect, del };
}
