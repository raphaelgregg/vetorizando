import { Gradient } from '../engine/types';
import type { VPath } from '../engine/types';
import { handles, moveHandle as moveGradHandle } from '../engine/gradedit';
import { Node, fromNodes, insertNode, moveHandle, moveNode, nearestOnPath, removeNode, toNodes, toggleEdge } from '../engine/nodeedit';
import { pathData } from '../engine/svg';
import type { Viewer } from './viewer';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, cls = ''): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (cls) e.setAttribute('class', cls);
  return e;
};

/**
 * Alças interativas sobre a prévia: pontos e alças de Bézier do contorno (editar pontos) ou as duas alças do
 * gradiente. Durante o arrasto só os elementos SVG são atualizados (o vetor só é recalculado ao soltar).
 */
export class Overlay {
  private nodes: Node[][] = [];
  private like: VPath[] = [];
  private sel: { p: number; i: number } | null = null;
  private syncs: (() => void)[] = [];
  private key: number | null = null;
  private onCommit: (paths: VPath[]) => void = () => {};
  private onPreview: (d: string) => void = () => {};
  onInfo: (text: string) => void = () => {};

  constructor(private viewer: Viewer) {}

  close(): void { this.viewer.overlay.replaceChildren(); this.syncs = []; this.nodes = []; }

  private root(): SVGSVGElement {
    const [w, h] = this.viewer.size;
    const host = this.viewer.overlay;
    host.replaceChildren();
    const svg = svgEl('svg', { viewBox: `0 0 ${w} ${h}`, width: w, height: h }, 'ov');
    host.append(svg);
    this.syncs = [];
    return svg;
  }

  private drag(el: Element, move: (x: number, y: number) => void, up: (moved: boolean) => void, down?: () => void): void {
    el.addEventListener('pointerdown', (e) => {
      const ev = e as PointerEvent;
      if (ev.button !== 0) return;
      ev.stopPropagation(); ev.preventDefault();
      (el as Element).setPointerCapture(ev.pointerId);
      let moved = false;
      down?.();
      const mv = (m: Event) => { const pe = m as PointerEvent; const [x, y] = this.viewer.docPoint(pe.clientX, pe.clientY); moved = true; move(x, y); };
      const end = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end); up(moved); };
      el.addEventListener('pointermove', mv);
      el.addEventListener('pointerup', end);
      el.addEventListener('pointercancel', end);
    });
  }

  // ---------- pontos ----------
  /** `key` identifica a forma: reabrir a mesma forma depois de uma edição mantém o ponto selecionado */
  openNodes(paths: VPath[], key: number, onCommit: (paths: VPath[]) => void, onPreview: (d: string) => void): void {
    if (paths.reduce((n, p) => n + p.segs.length, 0) > 4000) { this.close(); this.onInfo('Forma com pontos demais para editar à mão (> 4000): divida/simplifique antes.'); return; }
    this.like = paths;
    this.nodes = paths.map(toNodes);
    if (this.key !== key) this.sel = null;
    this.key = key;
    this.onCommit = onCommit; this.onPreview = onPreview;
    this.build();
  }

  private paths(): VPath[] { return this.nodes.map((ns, i) => fromNodes(ns, this.like[i])); }
  private commit(): void { this.onCommit(this.paths()); }
  private preview(): void { this.onPreview(this.paths().map(pathData).join('')); this.syncs.forEach((f) => f()); }

  private build(): void {
    const svg = this.root();
    this.nodes.forEach((_, pi) => {
      const hit = svgEl('path', {}, 'nd-hit'), line = svgEl('path', {}, 'nd-line');
      const sync = () => { const d = pathData(fromNodes(this.nodes[pi])); hit.setAttribute('d', d); line.setAttribute('d', d); };
      sync(); this.syncs.push(sync);
      hit.addEventListener('pointerdown', (e) => e.stopPropagation()); // não deixa o clique na linha virar seleção de outra forma
      hit.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const [x, y] = this.viewer.docPoint(e.clientX, e.clientY);
        const n = nearestOnPath(this.nodes[pi], { x, y });
        this.nodes[pi] = insertNode(this.nodes[pi], n.edge, n.t);
        this.sel = { p: pi, i: n.edge + 1 };
        this.commit();
      });
      svg.append(hit, line);
    });
    // alças da Bézier do nó selecionado (pool de 2 linhas + 2 círculos, atualizado por sync)
    const hl = [svgEl('line', {}, 'nd-hl'), svgEl('line', {}, 'nd-hl')];
    const hc = [svgEl('circle', {}, 'nd-h'), svgEl('circle', {}, 'nd-h')];
    (['in', 'out'] as const).forEach((which, k) => {
      this.syncs.push(() => {
        const n = this.sel ? this.nodes[this.sel.p][this.sel.i] : null, h = n && (which === 'in' ? n.hIn : n.hOut);
        const show = !!(n && h);
        hl[k].style.display = hc[k].style.display = show ? '' : 'none';
        if (n && h) { hl[k].setAttribute('x1', String(n.p.x)); hl[k].setAttribute('y1', String(n.p.y)); hl[k].setAttribute('x2', String(h.x)); hl[k].setAttribute('y2', String(h.y)); hc[k].setAttribute('cx', String(h.x)); hc[k].setAttribute('cy', String(h.y)); }
      });
      this.drag(hc[k], (x, y) => { if (this.sel) { this.nodes[this.sel.p] = moveHandle(this.nodes[this.sel.p], this.sel.i, which, { x, y }); this.preview(); } }, (moved) => { if (moved) this.commit(); });
    });
    svg.append(...hl, ...hc);
    this.nodes.forEach((ns, pi) => ns.forEach((_, i) => {
      const c = svgEl('circle', {}, 'nd-n');
      this.syncs.push(() => {
        const n = this.nodes[pi][i];
        if (!n) return;
        c.setAttribute('cx', String(n.p.x)); c.setAttribute('cy', String(n.p.y));
        c.classList.toggle('sel', !!this.sel && this.sel.p === pi && this.sel.i === i);
        c.classList.toggle('curve', !!(n.hIn || n.hOut));
      });
      this.drag(c, (x, y) => { this.nodes[pi] = moveNode(this.nodes[pi], i, { x, y }); this.preview(); },
        (moved) => { if (moved) this.commit(); },
        () => { this.sel = { p: pi, i }; this.syncs.forEach((f) => f()); });
      svg.append(c);
    }));
    this.syncs.forEach((f) => f());
  }

  deleteNode(): boolean {
    if (!this.sel) { this.onInfo('Selecione um ponto (clique num círculo) para excluí-lo.'); return true; }
    const { p, i } = this.sel;
    if (this.nodes[p].length <= 3) { this.onInfo('Um contorno precisa de pelo menos 3 pontos. Use “Excluir contorno”.'); return true; }
    this.nodes[p] = removeNode(this.nodes[p], i);
    this.sel = { p, i: Math.max(0, i - 1) };
    this.commit();
    return true;
  }

  toggleEdge(): boolean {
    if (!this.sel) { this.onInfo('Selecione um ponto: a aresta que sai dele alterna entre reta e curva.'); return false; }
    this.nodes[this.sel.p] = toggleEdge(this.nodes[this.sel.p], this.sel.i);
    this.commit();
    return true;
  }

  /** remove o contorno do ponto selecionado (ex.: um furo que não deveria existir) */
  deletePath(): boolean {
    if (!this.sel) { this.onInfo('Selecione um ponto do contorno que deseja excluir.'); return false; }
    if (this.nodes.length <= 1) { this.onInfo('Esta forma só tem um contorno: use “Excluir” para remover a forma inteira.'); return false; }
    this.nodes.splice(this.sel.p, 1);
    this.like = this.like.filter((_, i) => i !== this.sel!.p);
    this.sel = null;
    this.commit();
    return true;
  }

  get hasSelection(): boolean { return !!this.sel; }

  // ---------- gradiente ----------
  openGradient(g: Gradient, onPreview: (g: Gradient) => void, onCommit: (g: Gradient) => void): void {
    let cur = g;
    const svg = this.root();
    const line = svgEl('line', {}, 'gr-line'), ring = svgEl('circle', {}, 'gr-ring');
    const pts = [svgEl('circle', {}, 'gr-h'), svgEl('circle', {}, 'gr-h')];
    svg.append(ring, line, ...pts);
    const sync = () => {
      const [a, b] = handles(cur);
      line.setAttribute('x1', String(a[0])); line.setAttribute('y1', String(a[1])); line.setAttribute('x2', String(b[0])); line.setAttribute('y2', String(b[1]));
      pts[0].setAttribute('cx', String(a[0])); pts[0].setAttribute('cy', String(a[1])); pts[1].setAttribute('cx', String(b[0])); pts[1].setAttribute('cy', String(b[1]));
      ring.style.display = cur.kind === 'radial' ? '' : 'none';
      if (cur.kind === 'radial') { ring.setAttribute('cx', String(cur.cx)); ring.setAttribute('cy', String(cur.cy)); ring.setAttribute('r', String(cur.r)); }
    };
    this.syncs.push(sync);
    sync();
    pts.forEach((c, i) => this.drag(c, (x, y) => { cur = moveGradHandle(cur, i, x, y); sync(); onPreview(cur); }, (moved) => { if (moved) onCommit(cur); }));
  }
}
