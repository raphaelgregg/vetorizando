import { Lab, dist2 } from './color';

/**
 * Remove regiões menores que `minArea`, absorvendo-as no vizinho mais comum.
 * Componentes com conectividade 8: uma linha fina diagonal (degraus de 1 px) é UM componente e não vira “mancha”.
 */
/** A cor `p` está (a ≤ 12 ΔE) sobre o segmento A–B no espaço Lab, com A e B distintas? */
function onSegment(p: Lab, a: Lab, b: Lab): boolean {
  const ab = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
  const l2 = ab[0] * ab[0] + ab[1] * ab[1] + ab[2] * ab[2];
  if (l2 < 15 * 15) return false;
  const t = ((p[0] - a[0]) * ab[0] + (p[1] - a[1]) * ab[1] + (p[2] - a[2]) * ab[2]) / l2;
  if (t < -0.05 || t > 1.05) return false;
  const q: Lab = [a[0] + t * ab[0], a[1] + t * ab[1], a[2] + t * ab[2]];
  return Math.sqrt(dist2(p, q)) <= 12;
}

export function removeSpeckles(labels: Int16Array, w: number, h: number, minArea: number, palette?: Lab[]): void {
  if (minArea <= 1) return;
  // ruído tem pouco contraste; detalhe real (linha fina, ponto) destaca-se da vizinhança: limite menor
  const limit = (a: number, b: number): number => {
    if (!palette) return minArea;
    const de = Math.sqrt(dist2(palette[a], palette[b]));
    return minArea * (de >= 35 ? 0.25 : de >= 20 ? 0.6 : 1);
  };
  const n = w * h;
  const seen = new Uint8Array(n);
  const stack: number[] = [];
  for (let s = 0; s < n; s++) {
    if (seen[s] || labels[s] < 0) continue;
    const lab = labels[s];
    const comp: number[] = [];
    stack.push(s);
    seen[s] = 1;
    while (stack.length) {
      const i = stack.pop()!;
      comp.push(i);
      const x = i % w, y = (i / w) | 0;
      for (let dy = -1; dy <= 1; dy++) {
        const yy = y + dy;
        if (yy < 0 || yy >= h) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const xx = x + dx;
          if ((!dx && !dy) || xx < 0 || xx >= w) continue;
          const j = yy * w + xx;
          if (!seen[j] && labels[j] === lab) { seen[j] = 1; stack.push(j); }
        }
      }
    }
    if (comp.length >= minArea) continue; // grande o bastante (o limite por contraste só diminui)
    const votes = new Map<number, number>();
    for (const i of comp) {
      const x = i % w, y = (i / w) | 0;
      const nb = [x > 0 ? labels[i - 1] : -2, x < w - 1 ? labels[i + 1] : -2, y > 0 ? labels[i - w] : -2, y < h - 1 ? labels[i + w] : -2];
      for (const l of nb) if (l >= 0 && l !== lab) votes.set(l, (votes.get(l) ?? 0) + 1);
    }
    let best = -1, bv = 0, second = -1, sv = 0, total = 0;
    for (const [l, v] of votes) { total += v; if (v > bv) { sv = bv; second = best; bv = v; best = l; } else if (v > sv) { sv = v; second = l; } }
    // franja de anti-aliasing: cor entre as duas vizinhas, que ocupam lados opostos → ruído, não detalhe
    if (palette && best >= 0 && second >= 0 && sv / total >= 0.3 && onSegment(palette[lab], palette[best], palette[second])) {
      for (const i of comp) labels[i] = best;
      continue;
    }
    if (best >= 0 && comp.length >= limit(lab, best)) continue; // detalhe contrastante (linha fina, ponto): mantém
    if (best >= 0) for (const i of comp) labels[i] = best;
  }
}
