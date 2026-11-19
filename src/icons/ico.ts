export interface IcoEntry { size: number; png: Uint8Array }

/** favicon.ico com imagens PNG embutidas (aceito por todos os navegadores e pelo Windows desde o Vista). */
export function buildIco(entries: IcoEntry[]): Uint8Array {
  const list = [...entries].sort((a, b) => a.size - b.size);
  const head = 6 + 16 * list.length;
  const out = new Uint8Array(head + list.reduce((n, e) => n + e.png.length, 0));
  const dv = new DataView(out.buffer);
  dv.setUint16(0, 0, true); // reservado
  dv.setUint16(2, 1, true); // tipo 1 = ícone
  dv.setUint16(4, list.length, true);
  let off = head;
  list.forEach((e, i) => {
    const d = 6 + 16 * i;
    out[d] = e.size >= 256 ? 0 : e.size; // largura (0 = 256)
    out[d + 1] = e.size >= 256 ? 0 : e.size;
    out[d + 2] = 0; out[d + 3] = 0; // paleta, reservado
    dv.setUint16(d + 4, 1, true); // planos
    dv.setUint16(d + 6, 32, true); // bits por pixel
    dv.setUint32(d + 8, e.png.length, true);
    dv.setUint32(d + 12, off, true);
    out.set(e.png, off);
    off += e.png.length;
  });
  return out;
}
