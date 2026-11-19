/** Remove regiões (4-conectadas) menores que `minArea`, absorvendo-as no vizinho mais comum. */
export function removeSpeckles(labels: Int16Array, w: number, h: number, minArea: number): void {
  if (minArea <= 1) return;
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
      if (x > 0 && !seen[i - 1] && labels[i - 1] === lab) { seen[i - 1] = 1; stack.push(i - 1); }
      if (x < w - 1 && !seen[i + 1] && labels[i + 1] === lab) { seen[i + 1] = 1; stack.push(i + 1); }
      if (y > 0 && !seen[i - w] && labels[i - w] === lab) { seen[i - w] = 1; stack.push(i - w); }
      if (y < h - 1 && !seen[i + w] && labels[i + w] === lab) { seen[i + w] = 1; stack.push(i + w); }
    }
    if (comp.length >= minArea) continue;
    const votes = new Map<number, number>();
    for (const i of comp) {
      const x = i % w, y = (i / w) | 0;
      const nb = [x > 0 ? labels[i - 1] : -2, x < w - 1 ? labels[i + 1] : -2, y > 0 ? labels[i - w] : -2, y < h - 1 ? labels[i + w] : -2];
      for (const l of nb) if (l >= 0 && l !== lab) votes.set(l, (votes.get(l) ?? 0) + 1);
    }
    let best = -1, bv = 0;
    for (const [l, v] of votes) if (v > bv) { bv = v; best = l; }
    if (best >= 0) for (const i of comp) labels[i] = best;
  }
}
