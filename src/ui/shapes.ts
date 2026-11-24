import { pathData } from '../engine/svg';
import { ReorderOp, ShapeEdits, copyPaint, editShapes, effectiveOrder, listShapes, mergeShapes, reorderShapes, shapesAt, shapesInRect, similarShapes } from '../engine/shapes';
import { addStop, convertKind, defaultGradient, removeStop, reverse, setStop } from '../engine/gradedit';
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
  /** atualização ao vivo (arrastando/ajustando): não entra no histórico */
  preview(edits: ShapeEdits): void;
  hint(text: string): void;
  /** modo "copiar cor de…" ligado/desligado (muda o cursor da prévia) */
  picking(on: boolean): void;
}

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

const css = (c: string, g?: Gradient): string => (g ? `linear-gradient(90deg,${g.stops.map((s) => `${s.color} ${Math.round(s.offset * 100)}%`).join(',')})` : c);

/** Painel e interações de edição de formas (seleção por clique/retângulo, excluir, recolorir, fundir, restaurar). */
export function initShapes(host: ShapesHost) {
  const rows = $('shaperows');
  let copying = false;
  let dragIds: number[] = [];
  const setCopying = (on: boolean) => { copying = on; $('shcopy').setAttribute('aria-pressed', String(on)); host.picking(on); if (on) host.hint('Clique na forma cuja cor deseja copiar (na prévia ou na lista). Esc cancela.'); };
  /** aplica a tinta da forma `sourceId` às selecionadas e sai do modo */
  const applyCopy = (sourceId: number) => {
    const b = host.base(), doc = host.doc();
    setCopying(false);
    if (!b || !doc) return;
    const targets = [...host.selection()].filter((i) => i !== sourceId);
    if (!targets.length) { host.hint('A forma de origem não pode ser a única selecionada.'); return; }
    host.commit(copyPaint(b, doc, host.edits(), sourceId, targets));
    host.hint(`Cor copiada para ${targets.length} ${targets.length === 1 ? 'forma' : 'formas'}.`);
  };
  const sel = () => host.selection();

  /** dados de caminho das formas selecionadas (para o realce na prévia) */
  function overlay(): string {
    const doc = host.doc();
    if (!doc || !sel().size) return '';
    return listShapes(doc).filter((s) => sel().has(s.id)).map((s) => s.paths.map(pathData).join('')).join('');
  }

  function render(live = false) {
    if (live) return; // edição em andamento: não reconstruir painéis (perderia o foco dos controles)
    renderGradient();
    const doc = host.doc(), base = host.base();
    rows.replaceChildren();
    if (!doc || !base) { $('shapecount').textContent = ''; return; }
    const shapes = listShapes(doc);
    for (const id of [...sel()]) if (!shapes.some((s) => s.id === id)) sel().delete(id);
    const hiddenIds = Object.entries(host.edits()).filter(([, e]) => e.hidden).map(([k]) => Number(k));
    $('shapecount').textContent = `(${shapes.length}${hiddenIds.length ? ` · ${hiddenIds.length} oculta${hiddenIds.length > 1 ? 's' : ''}` : ''})`;
    const n = sel().size;
    for (const id of ['shdel', 'shmerge', 'shsim', 'shnone', 'shcopy', 'zfront', 'zfwd', 'zbwd', 'zback']) $<HTMLButtonElement>(id).disabled = id === 'shmerge' ? n < 2 : n === 0;
    if (n === 0 && copying) setCopying(false);
    $<HTMLInputElement>('shcolor').disabled = n === 0;
    if (n === 1) { const s = shapes.find((x) => sel().has(x.id)); if (s && !s.gradient) $<HTMLInputElement>('shcolor').value = s.color; }
    host.hint(n ? `${n} ${n === 1 ? 'forma selecionada' : 'formas selecionadas'}` : 'Clique numa forma para selecioná-la; arraste para selecionar várias (Shift soma · Alt escolhe a de trás).');
    // camadas: da frente para o fundo (como num painel de camadas); formas ocultas aparecem esmaecidas
    const edits = host.edits();
    const liveMap = new Map(shapes.map((x) => [x.id, x]));
    const baseMap = new Map(listShapes(base).map((x) => [x.id, x]));
    const order = effectiveOrder(base, edits).filter((id) => edits[id]?.absorbed === undefined).reverse();
    const MAX = 300;
    for (const id of order.slice(0, MAX)) {
      const s = liveMap.get(id) ?? baseMap.get(id);
      if (!s) continue;
      const hid = !liveMap.has(id);
      const r = document.createElement('div');
      r.className = 'shaperow' + (sel().has(id) ? ' on' : '') + (hid ? ' hid' : '');
      r.dataset.id = String(id);
      const eye = Object.assign(document.createElement('button'), { className: 'eye', textContent: '👁', title: hid ? 'Oculta — clique para mostrar' : 'Visível — clique para ocultar' });
      eye.setAttribute('aria-pressed', String(hid));
      eye.addEventListener('click', (e) => { e.stopPropagation(); host.commit(editShapes(base, host.edits(), [id], hid ? null : { hidden: true })); });
      const sw = document.createElement('i');
      sw.style.background = css(s.color, s.gradient);
      const t = document.createElement('div');
      t.textContent = `${s.gradient ? 'gradiente' : s.color} `;
      const m = document.createElement('span');
      m.textContent = `${s.nodes} nós`;
      const a = document.createElement('span');
      a.textContent = s.area >= 1000 ? `${(s.area / 1000).toFixed(1)}k px²` : `${Math.round(s.area)} px²`;
      t.append(m);
      r.append(eye, sw, t, a);
      r.addEventListener('click', (e) => { if (hid) return; if (copying) applyCopy(id); else toggle(id, e.shiftKey || e.ctrlKey || e.metaKey); });
      if (!hid) {
        r.draggable = true;
        r.addEventListener('dragstart', (e) => { dragIds = sel().has(id) ? ids() : [id]; e.dataTransfer?.setData('text/plain', String(id)); if (e.dataTransfer) e.dataTransfer.effectAllowed = 'move'; });
        r.addEventListener('dragend', () => rows.querySelectorAll('.drop-top,.drop-bottom').forEach((x) => x.classList.remove('drop-top', 'drop-bottom')));
      }
      r.addEventListener('dragover', (e) => {
        if (!dragIds.length || dragIds.includes(id)) return;
        e.preventDefault();
        const rc = r.getBoundingClientRect(), top = e.clientY < rc.top + rc.height / 2;
        r.classList.toggle('drop-top', top); r.classList.toggle('drop-bottom', !top);
      });
      r.addEventListener('dragleave', () => r.classList.remove('drop-top', 'drop-bottom'));
      r.addEventListener('drop', (e) => {
        e.preventDefault();
        const rc = r.getBoundingClientRect(), top = e.clientY < rc.top + rc.height / 2; // metade de cima da linha = na frente dela
        const mv = dragIds; dragIds = [];
        if (mv.length && !mv.includes(id)) host.commit(reorderShapes(base, doc, host.edits(), mv, top ? { inFrontOf: id } : { behind: id }));
      });
      rows.append(r);
    }
    if (order.length > MAX) rows.append(Object.assign(document.createElement('span'), { textContent: `… e mais ${order.length - MAX} camadas mais ao fundo (selecione na prévia)`, className: 'shapehint' }));
    rows.querySelector('.shaperow.on')?.scrollIntoView({ block: 'nearest' });
  }

  /** editor do gradiente da forma selecionada: tipo, paradas (cor + posição), inverter; as alças ficam na prévia */
  function renderGradient() {
    const box = $('gradbox');
    box.replaceChildren();
    const doc = host.doc(), base = host.base();
    const s = doc && sel().size === 1 ? listShapes(doc).find((x) => sel().has(x.id)) : undefined;
    box.hidden = !s || !base;
    if (!s || !base) return;
    const id = s.id, g = s.gradient;
    const set = (ng: Gradient, live: boolean) => { const e = editShapes(base, host.edits(), [id], { gradient: ng }); if (live) host.preview(e); else host.commit(e); };
    const h = document.createElement('h3');
    h.textContent = 'Preenchimento da forma';
    const kind = document.createElement('select');
    for (const [v, t] of [['solid', 'Cor sólida'], ['linear', 'Gradiente linear'], ['radial', 'Gradiente radial']]) kind.add(new Option(t, v, false, (g?.kind ?? 'solid') === v));
    kind.addEventListener('change', () => {
      if (kind.value === 'solid') { host.commit(editShapes(base, host.edits(), [id], { color: g ? g.stops[Math.floor(g.stops.length / 2)].color : s.color })); return; }
      const start = g ?? defaultGradient(s.bbox, s.color);
      set(convertKind(start, kind.value as 'linear' | 'radial', s.bbox), false);
    });
    box.append(h, kind);
    if (!g) { box.append(Object.assign(document.createElement('p'), { className: 'shapehint', textContent: 'Escolha linear ou radial para criar um gradiente nesta forma.' })); return; }
    const bar = document.createElement('div');
    bar.className = 'gradbar';
    bar.style.background = css('', g);
    box.append(bar);
    g.stops.forEach((st, i) => {
      const row = document.createElement('div');
      row.className = 'stoprow';
      const c = Object.assign(document.createElement('input'), { type: 'color', value: st.color, title: 'Cor da parada' });
      const o = Object.assign(document.createElement('input'), { type: 'range', min: '0', max: '100', step: '1', value: String(Math.round(st.offset * 100)), title: 'Posição da parada' });
      const out = document.createElement('span');
      out.textContent = `${Math.round(st.offset * 100)}%`;
      c.addEventListener('input', () => set(setStop(g, i, { color: c.value }), true));
      c.addEventListener('change', () => set(setStop(g, i, { color: c.value }), false));
      o.addEventListener('input', () => { out.textContent = `${o.value}%`; set(setStop(g, i, { offset: Number(o.value) / 100 }), true); });
      o.addEventListener('change', () => set(setStop(g, i, { offset: Number(o.value) / 100 }), false));
      const rm = Object.assign(document.createElement('button'), { textContent: '×', title: 'Remover parada (mínimo 2)' });
      rm.disabled = g.stops.length <= 2;
      rm.addEventListener('click', () => set(removeStop(g, i), false));
      row.append(c, o, out, rm);
      box.append(row);
    });
    const tools = document.createElement('div');
    tools.className = 'tools';
    const add = Object.assign(document.createElement('button'), { className: 'ghost', textContent: '+ parada' });
    add.addEventListener('click', () => set(addStop(g), false));
    const rev = Object.assign(document.createElement('button'), { className: 'ghost', textContent: 'Inverter' });
    rev.addEventListener('click', () => set(reverse(g), false));
    tools.append(add, rev);
    box.append(tools, Object.assign(document.createElement('p'), { className: 'shapehint', textContent: 'Arraste as alças brancas na prévia para mudar a direção (linear) ou o centro e o raio (radial).' }));
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
    if (copying) { if (hit.length) applyCopy(hit[0]); return; } // modo conta-gotas: o clique escolhe a ORIGEM da cor
    if (!hit.length) { if (!shift) host.setSelection(new Set()); return; }
    // Alt: a próxima forma atrás da já selecionada (úteis em camadas empilhadas)
    let id = hit[0];
    if (alt) { const cur = hit.findIndex((h) => sel().has(h)); id = hit[Math.min(hit.length - 1, cur + 1)] ?? hit[0]; }
    toggle(id, shift);
  }

  function rect(r: [number, number, number, number], shift: boolean, alt: boolean) {
    const doc = host.doc();
    if (!doc) return;
    if (copying) return;
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
    const before = shapes.reduce((n, x) => n + x.nodes, 0);
    host.commit(mergeShapes(b, doc, host.edits(), ids()));
    host.setSelection(new Set([main.id]));
    const after = host.doc() ? listShapes(host.doc()!).find((x) => x.id === main.id)?.nodes : undefined;
    host.hint(`${shapes.length} formas unidas em um único objeto${after !== undefined ? ` (${before} → ${after} pontos: os pontos que dividiam as formas foram removidos)` : ''}. A maior define a cor.`);
  });
  const reorder = (op: ReorderOp) => { const b = base(), doc = host.doc(); if (b && doc && sel().size) host.commit(reorderShapes(b, doc, host.edits(), ids(), op)); };
  $('zfront').addEventListener('click', () => reorder('front'));
  $('zfwd').addEventListener('click', () => reorder('forward'));
  $('zbwd').addEventListener('click', () => reorder('backward'));
  $('zback').addEventListener('click', () => reorder('back'));
  $('shcopy').addEventListener('click', () => setCopying(!copying));
  $('shsim').addEventListener('click', () => {
    const doc = host.doc();
    if (!doc || !sel().size) return;
    const s = new Set<number>();
    for (const id of ids()) for (const x of similarShapes(doc, id)) s.add(x);
    host.setSelection(s);
  });
  $('shnone').addEventListener('click', () => host.setSelection(new Set()));

  return { render, overlay, pick, rect, del, reorder, cancelCopy: () => { if (copying) setCopying(false); }, get copying() { return copying; } };
}
