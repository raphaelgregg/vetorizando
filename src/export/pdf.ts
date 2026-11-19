import { toCubicPath } from '../engine/geom';
import type { Options, VDoc, VPath } from '../engine/types';
import { Group, groupLayers, paintMode, rgbOf } from './groups';
import { ResolvedSize, fmt } from './size';

const STROKE_PT = 0.75; // contorno “sem escala” (1 px a 96 dpi)

function pathOps(p: VPath): string {
  const c = toCubicPath(p);
  let s = `${fmt(c.start.x)} ${fmt(c.start.y)} m\n`;
  for (const g of c.segs) s += g.t === 'L' ? `${fmt(g.p.x)} ${fmt(g.p.y)} l\n` : `${fmt(g.c1.x)} ${fmt(g.c1.y)} ${fmt(g.c2.x)} ${fmt(g.c2.y)} ${fmt(g.p.x)} ${fmt(g.p.y)} c\n`;
  return s + 'h\n';
}

function latin1(s: string): Uint8Array {
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0xff;
  return out;
}

const esc = (s: string) => s.replace(/[\\()]/g, '\\$&');

/** PDF vetorial. Grupos (cor/camada) viram camadas opcionais (OCG, PDF 1.5). */
export function toPDF(doc: VDoc, o: Options, size: ResolvedSize): Uint8Array {
  const { fill, gap } = paintMode(o);
  const groups: Group[] = groupLayers(doc, o);
  const named = groups.filter((g) => g.name);
  const k = size.widthPt / doc.width; // doc → pontos
  let c = `q\n${fmt(k, 6)} 0 0 ${fmt(-k, 6)} 0 ${fmt(size.heightPt)} cm\n1 j 1 J\n`;
  groups.forEach((g) => {
    const idx = named.indexOf(g);
    if (g.name) c += `/OC /oc${idx} BDC\n`;
    for (const layer of g.layers) {
      const [r, gg, b] = rgbOf(layer.color).map((v) => fmt(v / 255, 4));
      c += fill ? `${r} ${gg} ${b} rg\n` : `${r} ${gg} ${b} RG\n`;
      if (gap) c += `${r} ${gg} ${b} RG\n${fmt(o.gapStrokeWidth, 4)} w\n`;
      else if (!fill) c += `${fmt(STROKE_PT / k, 5)} w\n`;
      for (const p of layer.paths) c += pathOps(p);
      c += fill ? (gap ? 'B\n' : 'f\n') : 'S\n';
    }
    if (g.name) c += 'EMC\n';
  });
  c += 'Q\n';

  const ocgBase = 5;
  const objs: string[] = [];
  const refs = named.map((_, i) => `${ocgBase + i} 0 R`).join(' ');
  objs.push(`<< /Type /Catalog /Pages 2 0 R${named.length ? ` /OCProperties << /OCGs [${refs}] /D << /Order [${refs}] /ON [${refs}] >> >>` : ''} >>`);
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  const props = named.length ? ` /Properties << ${named.map((_, i) => `/oc${i} ${ocgBase + i} 0 R`).join(' ')} >>` : '';
  objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(size.widthPt)} ${fmt(size.heightPt)}] /Contents 4 0 R /Resources << /ProcSet [/PDF]${props} >> >>`);
  objs.push(`<< /Length ${c.length} >>\nstream\n${c}endstream`);
  named.forEach((g) => objs.push(`<< /Type /OCG /Name (${esc(g.name!)}) >>`));

  let out = `%PDF-${named.length ? '1.5' : '1.4'}\n%\xE2\xE3\xCF\xD3\n`;
  const offsets: number[] = [];
  objs.forEach((body, i) => {
    offsets.push(out.length);
    out += `${i + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objs.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) out += `${String(off).padStart(10, '0')} 00000 n \n`;
  out += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return latin1(out);
}
