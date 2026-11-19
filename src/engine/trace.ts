import type { Pt } from './types';

/**
 * Traça os contornos de uma máscara binária pelas bordas dos pixels.
 * Contornos externos saem no sentido horário e furos no anti-horário
 * (preenchimento `nonzero` já resolve os furos).
 */
export function traceMask(mask: Uint8Array, w: number, h: number): Pt[][] {
  const W = w + 1;
  const out1 = new Int32Array(W * (h + 1)).fill(-1);
  const out2 = new Int32Array(W * (h + 1)).fill(-1);
  const add = (a: number, b: number) => {
    if (out1[a] < 0) out1[a] = b;
    else out2[a] = b;
  };
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < w && y < h && mask[y * w + x] === 1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (!mask[y * w + x]) continue;
      if (!inside(x, y - 1)) add(y * W + x, y * W + x + 1); // topo →
      if (!inside(x + 1, y)) add(y * W + x + 1, (y + 1) * W + x + 1); // direita ↓
      if (!inside(x, y + 1)) add((y + 1) * W + x + 1, (y + 1) * W + x); // base ←
      if (!inside(x - 1, y)) add((y + 1) * W + x, y * W + x); // esquerda ↑
    }
  }
  const loops: Pt[][] = [];
  const total = W * (h + 1);
  for (let s = 0; s < total; s++) {
    while (out1[s] >= 0 || out2[s] >= 0) {
      const loop: Pt[] = [];
      let cur = s;
      let dx = 0, dy = 0;
      for (;;) {
        loop.push({ x: cur % W, y: (cur / W) | 0 });
        let next: number;
        const a = out1[cur], b = out2[cur];
        if (a < 0 && b < 0) break;
        if (a >= 0 && b >= 0) {
          // vértice diagonal: curva à direita (mantém regiões 4-conectadas)
          const cross = (n: number) => dx * (((n / W) | 0) - ((cur / W) | 0)) - dy * ((n % W) - (cur % W));
          if (cross(a) >= cross(b)) { next = a; out1[cur] = out2[cur]; out2[cur] = -1; }
          else { next = b; out2[cur] = -1; }
        } else if (a >= 0) { next = a; out1[cur] = -1; }
        else { next = b; out2[cur] = -1; }
        dx = (next % W) - (cur % W);
        dy = ((next / W) | 0) - ((cur / W) | 0);
        cur = next;
        if (cur === s && out1[cur] < 0 && out2[cur] < 0) break;
      }
      if (loop.length >= 4) loops.push(loop);
    }
  }
  return loops;
}

export function loopArea(p: Pt[]): number {
  let a = 0;
  for (let i = 0; i < p.length; i++) {
    const q = p[(i + 1) % p.length];
    a += p[i].x * q.y - q.x * p[i].y;
  }
  return a / 2;
}
