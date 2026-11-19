/** resvg devolve RGBA pré-multiplicado; imagens reais (PNG/canvas) têm cor reta. */
export function unpremultiply(px: Uint8Array | Buffer): Uint8ClampedArray {
  const out = new Uint8ClampedArray(px.length);
  for (let i = 0; i < px.length; i += 4) {
    const a = px[i + 3];
    out[i + 3] = a;
    if (a === 0) continue;
    const k = 255 / a;
    out[i] = Math.min(255, Math.round(px[i] * k));
    out[i + 1] = Math.min(255, Math.round(px[i + 1] * k));
    out[i + 2] = Math.min(255, Math.round(px[i + 2] * k));
  }
  return out;
}
