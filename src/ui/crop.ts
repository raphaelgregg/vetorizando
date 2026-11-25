import type { CropRect } from '../enhance/crop';
import type { Viewer } from './viewer';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, cls = ''): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (cls) e.setAttribute('class', cls);
  return e;
};

type Handle = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HANDLES: Handle[] = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const CURSOR: Record<Handle, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };
interface R { x0: number; y0: number; x1: number; y1: number }

/**
 * Recorte interativo sobre a prévia: retângulo com 8 alças e grade de terços, mover arrastando por dentro, proporção
 * travada opcional. Trabalha em pixels da prévia e entrega frações (independentes da resolução).
 */
export class CropOverlay {
  private w = 1;
  private h = 1;
  private r: R = { x0: 0, y0: 0, x1: 1, y1: 1 };
  private ratio: number | null = null; // largura/altura em pixels; null = livre
  private syncs: (() => void)[] = [];
  private onChange: (r: CropRect, final: boolean) => void = () => {};

  constructor(private viewer: Viewer) {}

  close(): void { this.viewer.overlay.replaceChildren(); this.viewer.setOverlayVisible(false); this.syncs = []; }

  private frac(): CropRect { return { x: this.r.x0 / this.w, y: this.r.y0 / this.h, w: (this.r.x1 - this.r.x0) / this.w, h: (this.r.y1 - this.r.y0) / this.h }; }
  private minSize() { return Math.max(12, Math.min(this.w, this.h) * 0.04); }

  open(w: number, h: number, rect: CropRect | null, ratio: number | null, onChange: (r: CropRect, final: boolean) => void): void {
    this.w = w; this.h = h; this.ratio = ratio; this.onChange = onChange;
    this.r = rect ? { x0: rect.x * w, y0: rect.y * h, x1: (rect.x + rect.w) * w, y1: (rect.y + rect.h) * h } : { x0: 0, y0: 0, x1: w, y1: h };
    if (ratio) this.fitRatio();
    this.build();
    this.viewer.setOverlayVisible(true);
    this.onChange(this.frac(), true);
  }

  /** muda a proporção travada: a caixa passa a ser a maior dessa proporção dentro da atual (mesmo centro) */
  setRatio(ratio: number | null): void {
    this.ratio = ratio;
    if (ratio) this.fitRatio();
    this.syncs.forEach((f) => f());
    this.onChange(this.frac(), true);
  }

  setRect(rect: CropRect): void {
    this.r = { x0: rect.x * this.w, y0: rect.y * this.h, x1: (rect.x + rect.w) * this.w, y1: (rect.y + rect.h) * this.h };
    this.syncs.forEach((f) => f());
    this.onChange(this.frac(), true);
  }

  private fitRatio(): void {
    const ratio = this.ratio!;
    const cx = (this.r.x0 + this.r.x1) / 2, cy = (this.r.y0 + this.r.y1) / 2;
    let rw = this.r.x1 - this.r.x0, rh = this.r.y1 - this.r.y0;
    if (rw / rh > ratio) rw = rh * ratio; else rh = rw / ratio;
    this.r = { x0: cx - rw / 2, y0: cy - rh / 2, x1: cx + rw / 2, y1: cy + rh / 2 };
    this.clampInside();
  }

  /** empurra a caixa para dentro da imagem (sem mudar o tamanho; se não couber, encolhe mantendo a proporção) */
  private clampInside(): void {
    let { x0, y0, x1, y1 } = this.r;
    let rw = x1 - x0, rh = y1 - y0;
    if (rw > this.w || rh > this.h) { const k = Math.min(this.w / rw, this.h / rh); rw *= k; rh *= k; x1 = x0 + rw; y1 = y0 + rh; }
    if (x0 < 0) { x1 -= x0; x0 = 0; } if (y0 < 0) { y1 -= y0; y0 = 0; }
    if (x1 > this.w) { x0 -= x1 - this.w; x1 = this.w; } if (y1 > this.h) { y0 -= y1 - this.h; y1 = this.h; }
    this.r = { x0, y0, x1, y1 };
  }

  private resize(hd: Handle, mx: number, my: number, s: R): R {
    const min = this.minSize(), W = this.w, H = this.h;
    const cl = (v: number, a: number, b: number) => Math.max(a, Math.min(b, v));
    const west = hd.includes('w'), east = hd.includes('e'), north = hd.includes('n'), south = hd.includes('s');
    if (!this.ratio) {
      const r = { ...s };
      if (west) r.x0 = cl(mx, 0, s.x1 - min); if (east) r.x1 = cl(mx, s.x0 + min, W);
      if (north) r.y0 = cl(my, 0, s.y1 - min); if (south) r.y1 = cl(my, s.y0 + min, H);
      return r;
    }
    const ratio = this.ratio;
    const corner = (west || east) && (north || south);
    if (corner) {
      const ax = west ? s.x1 : s.x0, ay = north ? s.y1 : s.y0; // âncora = canto oposto
      let w = Math.abs(mx - ax), h = Math.abs(my - ay);
      if (w / ratio > h) h = w / ratio; else w = h * ratio;
      const maxW = west ? ax : W - ax, maxH = north ? ay : H - ay;
      const k = Math.min(1, maxW / w, maxH / h);
      w = Math.max(min, w * k); h = w / ratio;
      return { x0: west ? ax - w : ax, x1: west ? ax : ax + w, y0: north ? ay - h : ay, y1: north ? ay : ay + h };
    }
    // alça de aresta: o lado oposto é fixo e a outra dimensão acompanha, centrada
    const cx = (s.x0 + s.x1) / 2, cy = (s.y0 + s.y1) / 2;
    if (west || east) {
      const ax = west ? s.x1 : s.x0;
      let w = Math.abs(mx - ax);
      w = Math.min(w, west ? ax : W - ax, H * ratio);
      w = Math.max(min, w);
      const h = w / ratio, y0 = cl(cy - h / 2, 0, H - h);
      return { x0: west ? ax - w : ax, x1: west ? ax : ax + w, y0, y1: y0 + h };
    }
    const ay = north ? s.y1 : s.y0;
    let h = Math.abs(my - ay);
    h = Math.min(h, north ? ay : H - ay, W / ratio);
    h = Math.max(min / ratio, h);
    const w = h * ratio, x0 = cl(cx - w / 2, 0, W - w);
    return { x0, x1: x0 + w, y0: north ? ay - h : ay, y1: north ? ay : ay + h };
  }

  private drag(el: Element, move: (x: number, y: number, start: R, x0: number, y0: number) => void): void {
    el.addEventListener('pointerdown', (e) => {
      const ev = e as PointerEvent;
      if (ev.button !== 0) return;
      ev.stopPropagation(); ev.preventDefault();
      (el as Element).setPointerCapture(ev.pointerId);
      const [sx, sy] = this.viewer.docPoint(ev.clientX, ev.clientY);
      const start = { ...this.r };
      const mv = (m: Event) => { const pe = m as PointerEvent; const [x, y] = this.viewer.docPoint(pe.clientX, pe.clientY); move(x, y, start, sx, sy); this.syncs.forEach((f) => f()); this.onChange(this.frac(), false); };
      const end = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end); this.onChange(this.frac(), true); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    });
  }

  private build(): void {
    const host = this.viewer.overlay;
    host.replaceChildren();
    this.syncs = [];
    const svg = svgEl('svg', { viewBox: `0 0 ${this.w} ${this.h}`, width: this.w, height: this.h }, 'ov');
    host.append(svg);
    const dim = svgEl('path', { 'fill-rule': 'evenodd' }, 'cr-dim');
    const body = svgEl('rect', {}, 'cr-body');
    const frame = svgEl('rect', {}, 'cr-frame');
    const grid = [0, 1, 2, 3].map(() => svgEl('line', {}, 'cr-grid'));
    svg.append(dim, body, frame, ...grid);
    this.drag(body, (x, y, s, sx, sy) => {
      const rw = s.x1 - s.x0, rh = s.y1 - s.y0;
      const nx = Math.max(0, Math.min(this.w - rw, s.x0 + x - sx)), ny = Math.max(0, Math.min(this.h - rh, s.y0 + y - sy));
      this.r = { x0: nx, y0: ny, x1: nx + rw, y1: ny + rh };
    });
    this.syncs.push(() => {
      const { x0, y0, x1, y1 } = this.r, w = x1 - x0, h = y1 - y0;
      dim.setAttribute('d', `M0 0H${this.w}V${this.h}H0Z M${x0} ${y0}H${x1}V${y1}H${x0}Z`);
      for (const e of [body, frame]) { e.setAttribute('x', String(x0)); e.setAttribute('y', String(y0)); e.setAttribute('width', String(w)); e.setAttribute('height', String(h)); }
      const g = (l: SVGLineElement, ax: number, ay: number, bx: number, by: number) => { l.setAttribute('x1', String(ax)); l.setAttribute('y1', String(ay)); l.setAttribute('x2', String(bx)); l.setAttribute('y2', String(by)); };
      g(grid[0], x0 + w / 3, y0, x0 + w / 3, y1); g(grid[1], x0 + (2 * w) / 3, y0, x0 + (2 * w) / 3, y1);
      g(grid[2], x0, y0 + h / 3, x1, y0 + h / 3); g(grid[3], x0, y0 + (2 * h) / 3, x1, y0 + (2 * h) / 3);
    });
    for (const hd of HANDLES) {
      const c = svgEl('rect', {}, 'cr-h');
      c.style.cursor = CURSOR[hd];
      this.syncs.push(() => {
        const { x0, y0, x1, y1 } = this.r;
        const x = hd.includes('w') ? x0 : hd.includes('e') ? x1 : (x0 + x1) / 2, y = hd.includes('n') ? y0 : hd.includes('s') ? y1 : (y0 + y1) / 2;
        c.setAttribute('x', String(x)); c.setAttribute('y', String(y));
      });
      this.drag(c, (mx, my, s) => { this.r = this.resize(hd, mx, my, s); });
      svg.append(c);
    }
    this.syncs.forEach((f) => f());
  }
}
