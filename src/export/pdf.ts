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
  const gapOcg = gap && o.groupBy !== 'none' ? 1 : 0; // camada opcional extra para as fendas
  const rgb = (hex: string) => rgbOf(hex).map((v) => fmt(v / 255, 4)) as [string, string, string];
  let c = `q\n${fmt(k, 6)} 0 0 ${fmt(-k, 6)} 0 ${fmt(size.heightPt)} cm\n1 j 1 J\n`;
  if (gap) {
    // fendas: traços sob todos os preenchimentos, recortados pela união quando há bordas abertas
    if (gapOcg) c += '/OC /ocgap BDC\n';
    c += 'q\n';
    if (doc.openBoundary) { for (const l of doc.layers) for (const p of l.paths) c += pathOps(p); c += 'W n\n'; }
    c += `${fmt(o.gapStrokeWidth, 4)} w\n`;
    for (const l of doc.layers) { c += `${rgb(l.color).join(' ')} RG\n`; for (const p of l.paths) c += pathOps(p); c += 'S\n'; }
    c += 'Q\n';
    if (gapOcg) c += 'EMC\n';
  }
  groups.forEach((g) => {
    const idx = named.indexOf(g);
    if (g.name) c += `/OC /oc${idx} BDC\n`;
    for (const layer of g.layers) {
      const col = rgb(layer.color).join(' ');
      c += fill ? `${col} rg\n` : `${col} RG\n${fmt(STROKE_PT / k, 5)} w\n`;
      for (const p of layer.paths) c += pathOps(p);
      c += fill ? 'f\n' : 'S\n';
    }
    if (g.name) c += 'EMC\n';
  });
  c += 'Q\n';

  const ocgBase = 5;
  const ocgs: { key: string; name: string }[] = [];
  if (gapOcg) ocgs.push({ key: 'ocgap', name: 'Preenchimento de fendas' });
  named.forEach((g, i) => ocgs.push({ key: `oc${i}`, name: g.name! }));
  const objs: string[] = [];
  const refs = ocgs.map((_, i) => `${ocgBase + i} 0 R`).join(' ');
  objs.push(`<< /Type /Catalog /Pages 2 0 R${ocgs.length ? ` /OCProperties << /OCGs [${refs}] /D << /Order [${refs}] /ON [${refs}] >> >>` : ''} >>`);
  objs.push('<< /Type /Pages /Kids [3 0 R] /Count 1 >>');
  const props = ocgs.length ? ` /Properties << ${ocgs.map((g, i) => `/${g.key} ${ocgBase + i} 0 R`).join(' ')} >>` : '';
  objs.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${fmt(size.widthPt)} ${fmt(size.heightPt)}] /Contents 4 0 R /Resources << /ProcSet [/PDF]${props} >> >>`);
  objs.push(`<< /Length ${c.length} >>\nstream\n${c}endstream`);
  ocgs.forEach((g) => objs.push(`<< /Type /OCG /Name (${esc(g.name)}) >>`));

  let out = `%PDF-${ocgs.length ? '1.5' : '1.4'}\n%\xE2\xE3\xCF\xD3\n`;
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
