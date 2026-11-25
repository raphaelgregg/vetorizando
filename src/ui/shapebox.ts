import { Overlay, isLine } from '../enhance/overlay';
import type { Viewer } from './viewer';

const NS = 'http://www.w3.org/2000/svg';
const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K, attrs: Record<string, string | number> = {}, cls = ''): SVGElementTagNameMap[K] => {
  const e = document.createElementNS(NS, tag);
  for (const [k, v] of Object.entries(attrs)) e.setAttribute(k, String(v));
  if (cls) e.setAttribute('class', cls);
  return e;
};

type H = 'nw' | 'n' | 'ne' | 'e' | 'se' | 's' | 'sw' | 'w';
const HS: { id: H; sx: number; sy: number }[] = [
  { id: 'nw', sx: -1, sy: -1 }, { id: 'n', sx: 0, sy: -1 }, { id: 'ne', sx: 1, sy: -1 }, { id: 'e', sx: 1, sy: 0 },
  { id: 'se', sx: 1, sy: 1 }, { id: 's', sx: 0, sy: 1 }, { id: 'sw', sx: -1, sy: 1 }, { id: 'w', sx: -1, sy: 0 },
];
const CURSOR: Record<H, string> = { nw: 'nwse-resize', se: 'nwse-resize', ne: 'nesw-resize', sw: 'nesw-resize', n: 'ns-resize', s: 'ns-resize', e: 'ew-resize', w: 'ew-resize' };

/**
 * Manipulação de uma forma inserida sobre a prévia: caixa girada com 8 alças de tamanho, alça de rotação e mover por
 * dentro; linhas/setas têm uma alça em cada extremo. Coordenadas do documento = pixels da prévia; a forma guarda frações.
 */
export class ShapeBox {
  private o!: Overlay;
  private W = 1;
  private H = 1;
  private syncs: (() => void)[] = [];
  onBegin: () => void = () => {};
  onChange: (o: Overlay, final: boolean) => void = () => {};

  constructor(private viewer: Viewer) {}

  close(): void { this.viewer.overlay.replaceChildren(); this.viewer.setOverlayVisible(false); this.syncs = []; }

  open(o: Overlay, W: number, H: number): void {
    this.o = { ...o }; this.W = W; this.H = H;
    const host = this.viewer.overlay;
    host.replaceChildren();
    this.syncs = [];
    const svg = svgEl('svg', { viewBox: `0 0 ${W} ${H}`, width: W, height: H }, 'ov');
    host.append(svg);
    if (isLine(o.kind)) this.buildLine(svg); else this.buildBox(svg);
    this.syncs.forEach((f) => f());
    this.viewer.setOverlayVisible(true);
  }

  private emit(final: boolean) { this.onChange({ ...this.o }, final); }

  private drag(el: Element, move: (x: number, y: number, sx: number, sy: number, start: Overlay, ev: PointerEvent) => void): void {
    el.addEventListener('pointerdown', (e) => {
      const ev = e as PointerEvent;
      if (ev.button !== 0) return;
      ev.stopPropagation(); ev.preventDefault();
      (el as Element).setPointerCapture(ev.pointerId);
      const [sx, sy] = this.viewer.docPoint(ev.clientX, ev.clientY);
      const start = { ...this.o };
      this.onBegin();
      const mv = (m: Event) => { const pe = m as PointerEvent; const [x, y] = this.viewer.docPoint(pe.clientX, pe.clientY); move(x, y, sx, sy, start, pe); this.syncs.forEach((f) => f()); this.emit(false); };
      const end = () => { el.removeEventListener('pointermove', mv); el.removeEventListener('pointerup', end); el.removeEventListener('pointercancel', end); this.emit(true); };
      el.addEventListener('pointermove', mv); el.addEventListener('pointerup', end); el.addEventListener('pointercancel', end);
    });
  }

  private buildLine(svg: SVGSVGElement): void {
    const line = svgEl('line', {}, 'sb-line'), hit = svgEl('line', {}, 'sb-hit');
    svg.append(hit, line);
    this.drag(hit, (x, y, sx, sy, s) => {
      const dx = (x - sx) / this.W, dy = (y - sy) / this.H;
      this.o.x1 = s.x1 + dx; this.o.y1 = s.y1 + dy; this.o.x2 = s.x2 + dx; this.o.y2 = s.y2 + dy;
    });
    const pts = [svgEl('circle', {}, 'sb-h'), svgEl('circle', {}, 'sb-h')];
    pts.forEach((c, i) => { svg.append(c); this.drag(c, (x, y) => { const fx = Math.min(1, Math.max(0, x / this.W)), fy = Math.min(1, Math.max(0, y / this.H)); if (i === 0) { this.o.x1 = fx; this.o.y1 = fy; } else { this.o.x2 = fx; this.o.y2 = fy; } }); });
    this.syncs.push(() => {
      const [a, b] = [[this.o.x1 * this.W, this.o.y1 * this.H], [this.o.x2 * this.W, this.o.y2 * this.H]];
      for (const l of [line, hit]) { l.setAttribute('x1', String(a[0])); l.setAttribute('y1', String(a[1])); l.setAttribute('x2', String(b[0])); l.setAttribute('y2', String(b[1])); }
      pts[0].setAttribute('cx', String(a[0])); pts[0].setAttribute('cy', String(a[1])); pts[1].setAttribute('cx', String(b[0])); pts[1].setAttribute('cy', String(b[1]));
    });
  }

  private buildBox(svg: SVGSVGElement): void {
    const g = svgEl('g');
    svg.append(g);
    const frame = svgEl('rect', {}, 'sb-frame'), body = svgEl('rect', {}, 'sb-body');
    g.append(body, frame);
    const rotLine = svgEl('line', {}, 'sb-frame'), rotH = svgEl('circle', {}, 'sb-h sb-rot');
    g.append(rotLine, rotH);
    const handles = HS.map((h) => { const r = svgEl('rect', {}, 'sb-sq'); r.style.cursor = CURSOR[h.id]; g.append(r); return { h, r }; });
    const box = () => ({ x: this.o.x * this.W, y: this.o.y * this.H, w: this.o.w * this.W, h: this.o.h * this.H });
    this.syncs.push(() => {
      const b = box(), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      g.setAttribute('transform', `rotate(${this.o.rot} ${cx} ${cy})`);
      for (const e of [frame, body]) { e.setAttribute('x', String(b.x)); e.setAttribute('y', String(b.y)); e.setAttribute('width', String(b.w)); e.setAttribute('height', String(b.h)); }
      const off = 26;
      rotLine.setAttribute('x1', String(cx)); rotLine.setAttribute('y1', String(b.y)); rotLine.setAttribute('x2', String(cx)); rotLine.setAttribute('y2', String(b.y - off));
      rotH.setAttribute('cx', String(cx)); rotH.setAttribute('cy', String(b.y - off));
      for (const { h, r } of handles) { r.setAttribute('x', String(b.x + b.w / 2 + (h.sx * b.w) / 2)); r.setAttribute('y', String(b.y + b.h / 2 + (h.sy * b.h) / 2)); }
    });
    // mover
    this.drag(body, (x, y, sx, sy, s) => { this.o.x = s.x + (x - sx) / this.W; this.o.y = s.y + (y - sy) / this.H; });
    // girar
    this.drag(rotH, (x, y, _sx, _sy, _s, ev) => {
      const b = box(), cx = b.x + b.w / 2, cy = b.y + b.h / 2;
      let deg = (Math.atan2(y - cy, x - cx) * 180) / Math.PI + 90;
      if (ev.shiftKey) deg = Math.round(deg / 15) * 15;
      this.o.rot = ((deg % 360) + 360) % 360;
    });
    // redimensionar no referencial da forma (girado)
    for (const { h, r } of handles) {
      this.drag(r, (x, y, _sx, _sy, s, ev) => {
        const w0 = s.w * this.W, h0 = s.h * this.H, c0x = s.x * this.W + w0 / 2, c0y = s.y * this.H + h0 / 2;
        const a = (-s.rot * Math.PI) / 180, co = Math.cos(a), si = Math.sin(a);
        let lx = (x - c0x) * co - (y - c0y) * si, ly = (x - c0x) * si + (y - c0y) * co; // mouse no referencial local
        const min = 8;
        let nw = w0, nh = h0, ncx = 0, ncy = 0;
        if (h.sx) { const fixed = -h.sx * (w0 / 2); nw = Math.max(min, h.sx * (lx - fixed)); ncx = fixed + (h.sx * nw) / 2; }
        if (h.sy) { const fixed = -h.sy * (h0 / 2); nh = Math.max(min, h.sy * (ly - fixed)); ncy = fixed + (h.sy * nh) / 2; }
        if (ev.shiftKey && h.sx && h.sy) { const k = Math.max(nw / w0, nh / h0); nw = w0 * k; nh = h0 * k; ncx = -h.sx * (w0 / 2) + (h.sx * nw) / 2; ncy = -h.sy * (h0 / 2) + (h.sy * nh) / 2; }
        const b = (s.rot * Math.PI) / 180, cb = Math.cos(b), sb = Math.sin(b);
        const gx = c0x + ncx * cb - ncy * sb, gy = c0y + ncx * sb + ncy * cb; // centro novo no referencial global
        this.o.w = nw / this.W; this.o.h = nh / this.H; this.o.x = gx / this.W - this.o.w / 2; this.o.y = gy / this.H - this.o.h / 2;
        lx = ly = 0;
      });
    }
  }
}
