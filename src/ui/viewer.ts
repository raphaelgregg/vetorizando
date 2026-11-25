import { pathData } from '../engine/svg';
import type { VDoc } from '../engine/types';

export type Mode = 'compare' | 'vector' | 'original';

const NS = 'http://www.w3.org/2000/svg';

/** Visualizador com Antes/Depois deslizante, zoom/pan e modo Raio‑X (nós e alças). */
export class Viewer {
  private a = el('div', 'layer'); // original
  private b = el('div', 'layer'); // vetor + wire
  private stageA = el('div', 'stage');
  private stageB = el('div', 'stage');
  private handle = el('div', 'handle');
  private knob = el('i');
  private tagA = el('span', 'tag');
  private tagB = el('span', 'tag');
  private w = 1;
  private h = 1;
  private scale = 1;
  private tx = 0;
  private ty = 0;
  private split = 0.5;
  private mode: Mode = 'compare';
  private wire = false;
  private fitted = false;
  private vecEl = el('div');
  private wireEl = el('div', 'wire');
  private pointers = new Map<number, { x: number; y: number }>();
  private draggingKnob = false;
  private pinch = 0;
  // edição de formas: clique seleciona, arrastar desenha um retângulo; pan com botão do meio/direito ou dois dedos
  private edit = false;
  private selEl = el('div', 'selection');
  private marquee = el('div', 'marquee');
  private ovEl = el('div', 'handles');
  private ovOn = false;
  private drag: { x0: number; y0: number; moved: boolean; kind: 'marquee' | 'move' | 'knife' } | null = null;
  private knifeEl = el('div', 'knifeline');
  /** ferramenta faca ligada: arrastar traça uma reta de corte */
  knife = false;
  /** o ponto (espaço do documento) está sobre uma forma selecionada? então arrastar MOVE a seleção */
  movable: (x: number, y: number) => boolean = () => false;
  onMove: (dx: number, dy: number, final: boolean) => void = () => {};
  onKnife: (p0: [number, number], p1: [number, number]) => void = () => {};
  onPick: (x: number, y: number, shift: boolean, alt: boolean) => void = () => {};
  onRect: (r: [number, number, number, number], shift: boolean, alt: boolean) => void = () => {};

  constructor(private root: HTMLElement) {
    root.replaceChildren();
    this.stageA.append(new Image());
    this.stageB.append(this.vecEl, this.wireEl, this.selEl, this.ovEl);
    this.root.append(this.marquee, this.knifeEl);
    this.knifeEl.hidden = true;
    this.marquee.hidden = true;
    this.root.addEventListener('contextmenu', (e) => { if (this.edit) e.preventDefault(); });
    this.a.append(this.stageA);
    this.b.append(this.stageB);
    this.knob.textContent = '↔';
    this.knob.tabIndex = 0;
    this.knob.setAttribute('role', 'slider');
    this.knob.setAttribute('aria-label', 'Comparar antes e depois');
    this.handle.append(this.knob);
    this.tagA.textContent = 'Original';
    this.tagB.textContent = 'Vetor';
    this.tagA.style.left = '8px';
    this.tagB.style.right = '8px';
    root.append(this.a, this.b, this.handle, this.tagA, this.tagB);
    root.addEventListener('wheel', (e) => { e.preventDefault(); this.zoomAt(e.deltaY < 0 ? 1.15 : 1 / 1.15, e.clientX, e.clientY); }, { passive: false });
    root.addEventListener('pointerdown', (e) => this.down(e));
    root.addEventListener('pointermove', (e) => this.move(e));
    root.addEventListener('pointerup', (e) => this.up(e));
    root.addEventListener('pointercancel', (e) => this.up(e));
    root.addEventListener('dblclick', () => this.fit());
    this.knob.addEventListener('keydown', (e) => {
      if (e.key === 'ArrowLeft') this.setSplit(this.split - 0.03);
      else if (e.key === 'ArrowRight') this.setSplit(this.split + 0.03);
    });
    new ResizeObserver(() => { if (!this.fitted) this.fit(); this.render(); }).observe(root);
  }

  setContent(origUrl: string, w: number, h: number, svg: string, doc: VDoc | null): void {
    const first = this.w !== w || this.h !== h || !this.fitted;
    this.w = w; this.h = h;
    for (const s of [this.stageA, this.stageB]) { s.style.width = `${w}px`; s.style.height = `${h}px`; }
    const img = this.stageA.firstElementChild as HTMLImageElement;
    if (img.src !== origUrl) img.src = origUrl;
    this.vecEl.innerHTML = svg;
    this.vecEl.style.cssText = `width:${w}px;height:${h}px`;
    this.buildWire(doc);
    if (first) { this.fitted = false; this.fit(); }
    this.render();
  }

  setEditMode(on: boolean): void { this.edit = on; this.root.classList.toggle('editing', on); if (!on) { this.drag = null; this.marquee.hidden = true; this.knifeEl.hidden = true; } }

  /** mostra a camada de alças (recorte) mesmo sem o modo de edição de formas */
  setOverlayVisible(on: boolean): void { this.ovOn = on; this.render(); }

  /** cursor/estado da ferramenta faca */
  setKnife(on: boolean): void { this.knife = on; this.root.classList.toggle('knife', on); }

  /** `d`: dados de caminho (SVG) das formas selecionadas, em coordenadas do documento */
  setSelection(d: string): void {
    this.selEl.style.cssText = `width:${this.w}px;height:${this.h}px`;
    this.selEl.innerHTML = d ? `<svg viewBox="0 0 ${this.w} ${this.h}" xmlns="${NS}"><path d="${d}" fill-rule="nonzero"/></svg>` : '';
  }

  /** contêiner (no espaço do documento) para alças de pontos e de gradiente */
  get overlay(): HTMLElement { this.ovEl.style.cssText = `width:${this.w}px;height:${this.h}px`; return this.ovEl; }
  get size(): [number, number] { return [this.w, this.h]; }

  docPoint(cx: number, cy: number): [number, number] { return this.toDoc(cx, cy); }

  private toDoc(cx: number, cy: number): [number, number] {
    const r = this.root.getBoundingClientRect();
    return [(cx - r.left - this.tx) / this.scale, (cy - r.top - this.ty) / this.scale];
  }

  /** rótulos dos lados do comparador (padrão: Original / Vetor) */
  setLabels(a: string, b: string): void { this.tagA.textContent = a; this.tagB.textContent = b; }

  setMode(m: Mode): void { this.mode = m; this.render(); }
  setWire(on: boolean): void { this.wire = on; this.render(); }
  zoomBy(f: number): void { const r = this.root.getBoundingClientRect(); this.zoomAt(f, r.left + r.width / 2, r.top + r.height / 2); }

  fit(): void {
    const r = this.root.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return;
    this.scale = Math.min(r.width / this.w, r.height / this.h) * 0.94;
    this.tx = (r.width - this.w * this.scale) / 2;
    this.ty = (r.height - this.h * this.scale) / 2;
    this.fitted = true;
    this.render();
  }

  private buildWire(doc: VDoc | null): void {
    this.wireEl.replaceChildren();
    this.wireEl.style.cssText = `width:${this.w}px;height:${this.h}px`;
    if (!doc) return;
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('viewBox', `0 0 ${doc.width} ${doc.height}`);
    const detail = doc.stats.nodes <= 15000;
    let lines = '', nodes = '', handles = '', ctrls = '';
    let d = '';
    for (const layer of doc.layers) {
      for (const p of layer.paths) {
        d += pathData(p);
        if (!detail) continue;
        let cur = p.start;
        nodes += `<circle class="n" cx="${cur.x}" cy="${cur.y}"/>`;
        for (const s of p.segs) {
          if (s.t === 'C') {
            handles += `M${cur.x} ${cur.y}L${s.c1.x} ${s.c1.y}M${s.p.x} ${s.p.y}L${s.c2.x} ${s.c2.y}`;
            ctrls += `<circle class="c" cx="${s.c1.x}" cy="${s.c1.y}"/><circle class="c" cx="${s.c2.x}" cy="${s.c2.y}"/>`;
          }
          nodes += `<circle class="n t${s.t}" cx="${s.p.x}" cy="${s.p.y}"/>`;
          cur = s.p;
        }
      }
    }
    lines = `<path d="${d}"/>`;
    svg.innerHTML = lines + (handles ? `<path class="hd" d="${handles}"/>` : '') + ctrls + nodes;
    this.wireEl.append(svg);
  }

  private render(): void {
    const t = `translate(${this.tx}px,${this.ty}px) scale(${this.scale})`;
    this.stageA.style.transform = t;
    this.stageB.style.transform = t;
    this.root.style.setProperty('--inv', String(1 / this.scale));
    const rw = this.root.clientWidth;
    const m = this.mode;
    this.a.style.display = m === 'vector' && !this.wire ? 'none' : '';
    this.b.style.display = m === 'original' && !this.wire ? 'none' : '';
    this.vecEl.style.display = this.wire ? 'none' : '';
    this.wireEl.style.display = this.wire ? '' : 'none';
    this.selEl.style.display = this.edit ? '' : 'none';
    this.ovEl.style.display = this.edit || this.ovOn ? '' : 'none';
    const cmp = m === 'compare' && !this.wire;
    this.b.style.clipPath = cmp ? `inset(0 0 0 ${this.split * rw}px)` : 'none';
    // o original só aparece à esquerda do divisor: senão ele vazaria por baixo das áreas transparentes do vetor
    this.a.style.clipPath = cmp ? `inset(0 ${rw - this.split * rw}px 0 0)` : 'none';
    this.handle.style.display = cmp ? '' : 'none';
    this.handle.style.left = `${this.split * rw}px`;
    this.knob.setAttribute('aria-valuenow', String(Math.round(this.split * 100)));
    this.tagA.style.display = cmp ? '' : 'none';
    this.tagB.style.display = cmp ? '' : 'none';
  }

  private setSplit(v: number): void { this.split = Math.min(0.98, Math.max(0.02, v)); this.render(); }

  private zoomAt(f: number, cx: number, cy: number): void {
    const r = this.root.getBoundingClientRect();
    const px = cx - r.left, py = cy - r.top;
    const ns = Math.min(64, Math.max(0.05, this.scale * f));
    const k = ns / this.scale;
    this.tx = px - (px - this.tx) * k;
    this.ty = py - (py - this.ty) * k;
    this.scale = ns;
    this.render();
  }

  private down(e: PointerEvent): void {
    this.root.setPointerCapture(e.pointerId);
    this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    this.draggingKnob = e.target === this.knob;
    this.drag = null;
    if (this.edit && !this.draggingKnob && e.button === 0 && this.pointers.size === 1) {
      const [x0, y0] = this.toDoc(e.clientX, e.clientY);
      const kind = this.knife ? 'knife' : this.movable(x0, y0) ? 'move' : 'marquee';
      this.drag = { x0, y0, moved: false, kind };
    }
    if (this.pointers.size === 2) { this.pinch = this.pinchDist(); this.drag = null; this.marquee.hidden = true; }
  }

  private move(e: PointerEvent): void {
    const prev = this.pointers.get(e.pointerId);
    if (!prev) return;
    const cur = { x: e.clientX, y: e.clientY };
    this.pointers.set(e.pointerId, cur);
    if (this.drag) {
      const [x, y] = this.toDoc(cur.x, cur.y);
      const r = this.root.getBoundingClientRect();
      if (this.drag.moved || Math.hypot((x - this.drag.x0) * this.scale, (y - this.drag.y0) * this.scale) > 4) {
        this.drag.moved = true;
        if (this.drag.kind === 'move') {
          let dx = x - this.drag.x0, dy = y - this.drag.y0;
          if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; } // Shift trava o eixo
          this.onMove(dx, dy, false);
          return;
        }
        const ax = this.drag.x0 * this.scale + this.tx, ay = this.drag.y0 * this.scale + this.ty, bx = cur.x - r.left, by = cur.y - r.top;
        if (this.drag.kind === 'knife') {
          // reta de corte (estendida na prévia por uma linha tracejada)
          const len = Math.hypot(bx - ax, by - ay), ang = Math.atan2(by - ay, bx - ax);
          Object.assign(this.knifeEl.style, { left: `${ax}px`, top: `${ay}px`, width: `${len}px`, transform: `rotate(${ang}rad)` });
          this.knifeEl.hidden = false;
          return;
        }
        Object.assign(this.marquee.style, { left: `${Math.min(ax, bx)}px`, top: `${Math.min(ay, by)}px`, width: `${Math.abs(ax - bx)}px`, height: `${Math.abs(ay - by)}px` });
        this.marquee.hidden = false;
      }
    } else if (this.draggingKnob) {
      const r = this.root.getBoundingClientRect();
      this.setSplit((cur.x - r.left) / r.width);
    } else if (this.pointers.size === 2) {
      const d = this.pinchDist();
      const [p, q] = [...this.pointers.values()];
      if (this.pinch > 0) this.zoomAt(d / this.pinch, (p.x + q.x) / 2, (p.y + q.y) / 2);
      this.pinch = d;
    } else {
      this.tx += cur.x - prev.x;
      this.ty += cur.y - prev.y;
      this.render();
    }
  }

  private up(e: PointerEvent): void {
    if (this.drag && e.type === 'pointerup') {
      const [x, y] = this.toDoc(e.clientX, e.clientY);
      if (this.drag.kind === 'move' && this.drag.moved) {
        let dx = x - this.drag.x0, dy = y - this.drag.y0;
        if (e.shiftKey) { if (Math.abs(dx) > Math.abs(dy)) dy = 0; else dx = 0; }
        this.onMove(dx, dy, true);
      } else if (this.drag.kind === 'knife') {
        if (this.drag.moved) this.onKnife([this.drag.x0, this.drag.y0], [x, y]);
      } else if (this.drag.moved) this.onRect([this.drag.x0, this.drag.y0, x, y], e.shiftKey, e.altKey);
      else this.onPick(x, y, e.shiftKey, e.altKey);
    }
    this.drag = null;
    this.marquee.hidden = true;
    this.knifeEl.hidden = true;
    this.pointers.delete(e.pointerId);
    if (this.pointers.size === 0) this.draggingKnob = false;
    this.pinch = 0;
  }

  private pinchDist(): number {
    const [p, q] = [...this.pointers.values()];
    return Math.hypot(p.x - q.x, p.y - q.y);
  }
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls = ''): HTMLElementTagNameMap[K] {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  return e;
}
