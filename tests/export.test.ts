import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { CASES, rasterize } from '../bench/cases';
import { compare } from '../bench/metrics';
import { renderSvg } from '../bench/io';
import { PRESETS } from '../src/engine/presets';
import { DEFAULT_OPTIONS, Options, VDoc } from '../src/engine/types';
import { vectorize } from '../src/engine/vectorize';
import { exportDoc } from '../src/export';
import { SizeSpec, resolveSize, sizeInUnit } from '../src/export/size';

const logoCase = CASES.find((c) => c.id === 'logo')!;
const logoOpts: Options = PRESETS[0].options;
const logoDoc: VDoc = vectorize(rasterize(logoCase.svg), logoOpts); // 512×512 px
const px = { unit: 'px' as const, dpi: 96 };
const str = (d: string | Uint8Array) => (typeof d === 'string' ? d : Buffer.from(d).toString('latin1'));

describe('tamanho, unidades e DPI', () => {
  it('px: sem medida usa o tamanho original; largura define a altura pela proporção', () => {
    expect(resolveSize(px, 512, 512, 512, 512)).toMatchObject({ unit: 'px', width: 512, height: 512, scale: 1 });
    expect(resolveSize({ ...px, width: 100 }, 512, 256, 512, 256)).toMatchObject({ width: 100, height: 50 });
    expect(resolveSize({ ...px, height: 50 }, 512, 256, 512, 256)).toMatchObject({ width: 100, height: 50 });
  });
  it('mm/cm: 96 dpi → 25,4 mm = 96 px; largura em mm define o tamanho físico', () => {
    const r = resolveSize({ unit: 'mm', dpi: 96 }, 96, 96, 96, 96);
    expect(r.width).toBeCloseTo(25.4, 6);
    expect(r.widthPt).toBeCloseTo(72, 6);
    const c = resolveSize({ unit: 'cm', width: 10, dpi: 300 }, 1000, 500, 1000, 500);
    expect(c).toMatchObject({ unit: 'cm', width: 10, height: 5 });
    expect(c.widthPt).toBeCloseTo((10 / 2.54) * 72, 6);
    expect(c.scale).toBeCloseTo(0.01, 9);
  });
  it('DPI muda o tamanho físico de px→mm (300 dpi: 300 px = 25,4 mm)', () => {
    expect(resolveSize({ unit: 'mm', dpi: 300 }, 300, 300, 300, 300).width).toBeCloseTo(25.4, 6);
  });
  it('%: porcentagem do tamanho original, saída em px', () => {
    const r = resolveSize({ unit: '%', width: 50, dpi: 96 }, 400, 200, 400, 200);
    expect(r).toMatchObject({ unit: 'px', width: 200, height: 100 });
    expect(sizeInUnit('%', 400, 200, 96)).toEqual({ width: 100, height: 100 });
  });
});

describe('SVG', () => {
  it('respeita unidade (mm) e agrupamento por camada (inkscape layers)', () => {
    const e = exportDoc('svg', logoDoc, { ...logoOpts, groupBy: 'layer' }, { unit: 'mm', width: 40, dpi: 96 }, 512, 512);
    const s = str(e.data);
    expect(s).toContain('width="40mm" height="40mm"');
    expect(s).toContain('viewBox="0 0 512 512"');
    expect((s.match(/inkscape:groupmode="layer"/g) ?? []).length).toBe(logoDoc.layers.length + 1); // + camada de fendas
    expect(s).toContain('inkscape:label="Preenchimento de fendas"');
  });
  it('agrupamento por cor gera <g> por cor; sem agrupamento não gera', () => {
    expect(str(exportDoc('svg', logoDoc, { ...logoOpts, groupBy: 'color' }, px, 512, 512).data)).toContain('<g id="cor-');
    expect(str(exportDoc('svg', logoDoc, { ...logoOpts, groupBy: 'none', gapFiller: false }, px, 512, 512).data)).not.toContain('<g ');
  });
});

describe('PDF', () => {
  const pdf = (o: Partial<Options>, spec: SizeSpec = { unit: 'mm', width: 40, dpi: 96 }) => str(exportDoc('pdf', logoDoc, { ...logoOpts, ...o }, spec, 512, 512).data);

  it('estrutura válida: xref aponta para cada objeto, MediaBox em pontos', () => {
    const s = pdf({});
    expect(s.startsWith('%PDF-1.4')).toBe(true);
    expect(s).toMatch(/\/MediaBox \[0 0 113\.386 113\.386\]/); // 40 mm = 113,386 pt
    const start = Number(/startxref\n(\d+)/.exec(s)![1]);
    expect(s.slice(start, start + 4)).toBe('xref');
    const entries = [...s.slice(start).matchAll(/^(\d{10}) 00000 n $/gm)].map((m) => Number(m[1]));
    expect(entries.length).toBe(4);
    entries.forEach((off, i) => expect(s.slice(off, off + 8)).toBe(`${i + 1} 0 obj\n`));
    const len = Number(/\/Length (\d+)/.exec(s)![1]);
    const body = s.slice(s.indexOf('stream\n') + 7, s.indexOf('endstream'));
    expect(body.length).toBe(len);
  });
  it('estilo: fendas = traços (S) ANTES de todos os preenchimentos (f), sem B; contornos usam S', () => {
    const g = pdf({ gapFiller: true, stacking: 'cutouts', drawStyle: 'fill' });
    expect(g).not.toMatch(/\nB\n/);
    expect(g.indexOf('\nS\n')).toBeGreaterThan(-1);
    expect(g.indexOf('\nS\n')).toBeLessThan(g.indexOf('\nf\n')); // traços de fenda ficam abaixo
    expect((g.match(/\nS\n/g) ?? []).length).toBe(logoDoc.layers.length);
    expect(pdf({ gapFiller: false, drawStyle: 'fill' })).not.toMatch(/\nS\n/);
    expect(pdf({ gapFiller: false, drawStyle: 'fill' })).toMatch(/\nf\n/);
    const outline = pdf({ drawStyle: 'outline', gapFiller: false });
    expect(outline).toMatch(/\nS\n/);
    expect(outline).not.toMatch(/\nf\n/);
  });
  it('agrupamento vira camadas opcionais (OCG) e muda a versão para 1.5', () => {
    const s = pdf({ groupBy: 'layer' });
    expect(s.startsWith('%PDF-1.5')).toBe(true);
    expect((s.match(/\/Type \/OCG/g) ?? []).length).toBe(logoDoc.layers.length + 1); // + camada de fendas
    expect((s.match(/BDC/g) ?? []).length).toBe(logoDoc.layers.length + 1);
    expect(s).toContain('(Preenchimento de fendas)');
    expect(s).toContain('(Camada 1)');
    expect(pdf({ groupBy: 'color' })).toContain('(Cor ');
  });
  it('arcos viram Béziers (sem comando A); empilhado preserva ordem fundo→frente', () => {
    const s = pdf({});
    expect(logoDoc.stats.arcs).toBeGreaterThan(0);
    expect((s.match(/ c\n/g) ?? []).length).toBeGreaterThan(logoDoc.stats.curves);
    const st = vectorize(rasterize(logoCase.svg), { ...logoOpts, stacking: 'stacked' });
    const sp = str(exportDoc('pdf', st, { ...logoOpts, stacking: 'stacked' }, px, 512, 512).data);
    expect((sp.match(/ rg\n/g) ?? []).length).toBe(st.layers.length);
  });

  const hasPdftoppm = spawnSync('pdftoppm', ['-v']).status !== null;
  it.skipIf(!hasPdftoppm)('renderizado por pdftoppm ≈ SVG renderizado (SSIM ≥ 0,98)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdf-'));
    const e = exportDoc('pdf', logoDoc, logoOpts, { unit: 'px', width: 512, dpi: 72 }, 512, 512); // 512 px @72dpi = 512 pt
    writeFileSync(join(dir, 'a.pdf'), e.data as Uint8Array);
    execFileSync('pdftoppm', ['-png', '-r', '72', '-singlefile', join(dir, 'a.pdf'), join(dir, 'a')]);
    const p = PNG.sync.read(readFileSync(join(dir, 'a.png')));
    const rendered = { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height };
    const ref = renderSvg(str(exportDoc('svg', logoDoc, logoOpts, px, 512, 512).data), rendered.width);
    expect(rendered.width).toBe(512);
    expect(compare(ref, rendered).ssim).toBeGreaterThan(0.98);
  });
});

/** Mini-interpretador do subconjunto de PostScript que geramos: devolve bbox dos pontos em pt. */
function psBBox(ps: string) {
  const st: number[] = [];
  let ctm = [1, 0, 0, 1, 0, 0]; // a b c d e f
  const stack: number[][] = [];
  const bb = { x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity };
  let gs = 0, maxLine = 0, curves = 0, fills = 0, strokes = 0, colors = 0;
  const pt = (x: number, y: number) => {
    const X = ctm[0] * x + ctm[2] * y + ctm[4], Y = ctm[1] * x + ctm[3] * y + ctm[5];
    bb.x0 = Math.min(bb.x0, X); bb.x1 = Math.max(bb.x1, X); bb.y0 = Math.min(bb.y0, Y); bb.y1 = Math.max(bb.y1, Y);
  };
  for (const line of ps.split('\n')) {
    maxLine = Math.max(maxLine, line.length);
    if (line.startsWith('%')) continue;
    for (const tok of line.trim().split(/\s+/)) {
      if (tok === '') continue;
      if (!Number.isNaN(Number(tok))) { st.push(Number(tok)); continue; }
      switch (tok) {
        case 'gsave': gs++; stack.push([...ctm]); break;
        case 'grestore': gs--; ctm = stack.pop()!; break;
        case 'translate': { const y = st.pop()!, x = st.pop()!; ctm = [ctm[0], ctm[1], ctm[2], ctm[3], ctm[0] * x + ctm[2] * y + ctm[4], ctm[1] * x + ctm[3] * y + ctm[5]]; break; }
        case 'scale': { const y = st.pop()!, x = st.pop()!; ctm = [ctm[0] * x, ctm[1] * x, ctm[2] * y, ctm[3] * y, ctm[4], ctm[5]]; break; }
        case 'moveto': case 'lineto': { const y = st.pop()!, x = st.pop()!; pt(x, y); break; }
        case 'curveto': { const v = st.splice(-6); pt(v[4], v[5]); curves++; break; }
        case 'setrgbcolor': st.splice(-3); colors++; break;
        case 'setlinewidth': case 'setlinejoin': case 'setlinecap': st.pop(); break;
        case 'fill': fills++; break;
        case 'stroke': strokes++; break;
        case 'newpath': case 'closepath': case 'showpage': case 'clip': break;
        default: throw new Error(`operador PostScript inesperado: ${tok}`);
      }
    }
  }
  return { bb, gs, maxLine, curves, fills, strokes, colors, left: st.length };
}

describe('EPS', () => {
  const eps = (o: Partial<Options>, spec: SizeSpec = { unit: 'mm', width: 40, dpi: 96 }) => str(exportDoc('eps', logoDoc, { ...logoOpts, ...o }, spec, 512, 512).data);
  it('cabeçalho EPSF-3.0 e BoundingBox arredondada para cima', () => {
    const s = eps({});
    expect(s.startsWith('%!PS-Adobe-3.0 EPSF-3.0\n')).toBe(true);
    expect(s).toContain('%%BoundingBox: 0 0 114 114'); // 113,386 pt
    expect(s).toContain('%%HiResBoundingBox: 0 0 113.386 113.386');
    expect(s.trimEnd().endsWith('%%EOF')).toBe(true);
  });
  it('geometria interpretada ocupa exatamente o tamanho pedido (40 mm) com Y para cima', () => {
    const r = psBBox(eps({}));
    expect(r.gs).toBe(0);
    expect(r.left).toBe(0);
    expect(r.bb.x0).toBeGreaterThanOrEqual(-0.01);
    expect(r.bb.x1).toBeCloseTo(113.386, 2);
    expect(r.bb.y0).toBeGreaterThanOrEqual(-0.01);
    expect(r.bb.y1).toBeCloseTo(113.386, 2); // fundo branco cobre a página inteira
    expect(r.maxLine).toBeLessThan(255);
  });
  it('estilos: fendas (gsave fill grestore stroke), contornos (stroke), agrupamento em comentários', () => {
    const gp = eps({ gapFiller: true });
    expect(gp).not.toContain('gsave fill grestore stroke');
    expect(gp.indexOf('stroke\n')).toBeLessThan(gp.indexOf('fill\n')); // fendas abaixo dos preenchimentos
    expect(gp).toContain('%%Group: Preenchimento de fendas');
    const o = psBBox(eps({ drawStyle: 'outline', gapFiller: false }));
    expect(o.fills).toBe(0);
    expect(o.strokes).toBe(logoDoc.layers.length);
    expect(psBBox(eps({ gapFiller: true })).strokes).toBe(logoDoc.layers.length); // 1 traço de fenda por camada
    expect(eps({ groupBy: 'layer' })).toContain('%%Group: Camada 1');
  });
  it('unidade em % e DPI: 50% de 512 px @ 72 dpi = 256 pt', () => {
    const r = psBBox(eps({}, { unit: '%', width: 50, dpi: 72 }));
    expect(r.bb.x1).toBeCloseTo(256, 2);
  });
});

/** Lê pares (código, valor) do DXF. */
function dxfPairs(s: string): [number, string][] {
  const lines = s.split('\n');
  if (lines[lines.length - 1] === '') lines.pop();
  expect(lines.length % 2).toBe(0);
  const out: [number, string][] = [];
  for (let i = 0; i < lines.length; i += 2) { expect(Number.isInteger(Number(lines[i]))).toBe(true); out.push([Number(lines[i]), lines[i + 1]]); }
  return out;
}

describe('DXF', () => {
  const dxf = (o: Partial<Options>, spec: SizeSpec = { unit: 'mm', width: 40, dpi: 96 }, doc = logoDoc) => str(exportDoc('dxf', doc, { ...logoOpts, ...o }, spec, 512, 512).data);

  it('estrutura R12: seções, tabela de layers e uma polilinha por caminho', () => {
    const p = dxfPairs(dxf({}));
    const names = p.filter(([c]) => c === 2).map(([, v]) => v);
    expect(names.slice(0, 3)).toEqual(['HEADER', 'TABLES', 'LAYER']);
    expect(names).toContain('ENTITIES');
    expect(p[p.length - 1]).toEqual([0, 'EOF']);
    const count = (v: string) => p.filter(([c, x]) => c === 0 && x === v).length;
    expect(count('POLYLINE')).toBe(logoDoc.stats.paths);
    expect(count('SEQEND')).toBe(count('POLYLINE'));
    expect(count('SECTION')).toBe(count('ENDSEC'));
  });
  it('coordenadas em mm: caixa = 40 × 40 mm, Y para cima', () => {
    const p = dxfPairs(dxf({}));
    const xs = p.filter(([c]) => c === 10).map(([, v]) => Number(v)).slice(1); // 1º 10 é o do POLYLINE
    const ys = p.filter(([c]) => c === 20).map(([, v]) => Number(v));
    expect(Math.min(...xs)).toBeCloseTo(0, 3);
    expect(Math.max(...xs)).toBeCloseTo(40, 3);
    expect(Math.max(...ys)).toBeCloseTo(40, 3);
  });
  it('arcos viram bulge e retas ficam exatas; círculo perfeito = 2–3 vértices com bulge', () => {
    const img = { width: 120, height: 120, data: new Uint8ClampedArray(120 * 120 * 4) };
    for (let y = 0; y < 120; y++) for (let x = 0; x < 120; x++) img.data.set(Math.hypot(x - 59.5, y - 59.5) < 40 ? [200, 30, 30, 255] : [255, 255, 255, 255], (y * 120 + x) * 4);
    const doc = vectorize(img, { ...DEFAULT_OPTIONS, maxColors: 2, removeBackground: true });
    const p = dxfPairs(dxf({ removeBackground: true }, { unit: 'px', dpi: 96 }, doc));
    const bulges = p.filter(([c]) => c === 42).map(([, v]) => Number(v));
    expect(doc.stats.arcs).toBeGreaterThan(0);
    expect(bulges.length).toBe(doc.stats.arcs);
    expect(bulges.every((b) => Math.abs(b) > 0 && Math.abs(b) <= 1 + 1e-6 || Math.abs(b) > 1)).toBe(true);
    expect(bulges.every((b) => b < 0)).toBe(true); // sweep=1 na tela → negativo com Y invertido
  });
  it('agrupamento: nenhuma → 1 layer; cor → 1 por cor; camada → 1 por camada', () => {
    const layers = (o: Partial<Options>) => dxfPairs(dxf(o)).filter(([c, v], i, a) => c === 0 && v === 'LAYER' && a[i + 1][0] === 2).length;
    expect(layers({ groupBy: 'none' })).toBe(1);
    expect(layers({ groupBy: 'color' })).toBe(logoDoc.layers.length);
    expect(layers({ groupBy: 'layer' })).toBe(logoDoc.layers.length);
    expect(dxf({ groupBy: 'layer' })).toContain('CAMADA_1');
  });
});

describe('borda aberta (transparência): fendas recortadas pela união', () => {
  const ic = CASES.find((c) => c.id === 'icon')!;
  const o = PRESETS[0].options;
  const doc = vectorize(rasterize(ic.svg), o);
  it('PDF usa recorte (W n) antes dos traços de fenda; EPS usa clip', () => {
    expect(doc.openBoundary).toBe(true);
    const pdf = str(exportDoc('pdf', doc, o, { unit: 'px', dpi: 72 }, 512, 512).data);
    expect(pdf).toContain('W n\n');
    expect(pdf.indexOf('W n\n')).toBeLessThan(pdf.indexOf('\nS\n'));
    const eps = str(exportDoc('eps', doc, o, { unit: 'px', dpi: 72 }, 512, 512).data);
    expect(eps).toContain('clip\n');
    expect(psBBox(eps).left).toBe(0); // interpretador entende o recorte e a pilha fecha
  });
  const hasPdftoppm = spawnSync('pdftoppm', ['-v']).status !== null;
  it.skipIf(!hasPdftoppm)('PDF do ícone renderizado ≈ SVG (SSIM ≥ 0,98) e silhueta não engrossa', () => {
    const dir = mkdtempSync(join(tmpdir(), 'pdf2-'));
    writeFileSync(join(dir, 'a.pdf'), exportDoc('pdf', doc, o, { unit: 'px', width: 512, dpi: 72 }, 512, 512).data as Uint8Array);
    execFileSync('pdftoppm', ['-png', '-r', '72', '-singlefile', join(dir, 'a.pdf'), join(dir, 'a')]);
    const p = PNG.sync.read(readFileSync(join(dir, 'a.png')));
    const rendered = { data: new Uint8ClampedArray(p.data), width: p.width, height: p.height };
    const ref = renderSvg(str(exportDoc('svg', doc, o, px, 512, 512).data), 512);
    expect(compare(ref, rendered).ssim).toBeGreaterThan(0.98);
  });
});
