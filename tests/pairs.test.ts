import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import jpeg from 'jpeg-js';
import { PNG } from 'pngjs';
import { describe, expect, it } from 'vitest';
import { CASES, rasterize } from '../bench/cases';
import { applyOrientation, exifOrientation } from '../bench/io';
import { comparePng, formatReport, worstTiles } from '../bench/report';
import { DEGRADATIONS, formatStress, runStress } from '../bench/stress';
import { Issue, ThresholdFile, runPairs, thresholdKey } from '../bench/suite';
import type { RawImage } from '../src/engine/types';

const none: ThresholdFile = { default: {}, cases: {} };
const src = (id: string) => CASES.find((c) => c.id === id)!.svg;
const tmp = () => mkdtempSync(join(tmpdir(), 'pairs-'));
const png = (path: string, im: RawImage) => { const p = new PNG({ width: im.width, height: im.height }); p.data = Buffer.from(im.data); writeFileSync(path, PNG.sync.write(p)); };
const jpg = (path: string, im: RawImage, q = 80) => writeFileSync(path, jpeg.encode({ data: Buffer.from(im.data), width: im.width, height: im.height }, q).data);

/** JPEG com EXIF Orientation = o (insere um APP1 mínimo logo após o SOI) */
function withOrientation(buf: Uint8Array, o: number): Buffer {
  const tiff = Buffer.from([0x49, 0x49, 0x2a, 0, 8, 0, 0, 0, 1, 0, 0x12, 0x01, 3, 0, 1, 0, 0, 0, o, 0, 0, 0, 0, 0, 0, 0]);
  const body = Buffer.concat([Buffer.from('Exif\0\0', 'binary'), tiff]);
  const app1 = Buffer.concat([Buffer.from([0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 255]), body]);
  return Buffer.concat([Buffer.from(buf.subarray(0, 2)), app1, Buffer.from(buf.subarray(2))]);
}

describe('fluxo de pares: robustez', () => {
  it('um par com problema NÃO derruba os outros: erros e avisos são listados', () => {
    const d = tmp();
    png(join(d, 'ok.png'), rasterize(src('stripes')));
    writeFileSync(join(d, 'broken.png'), 'isto não é um png');
    png(join(d, 'badsvg.png'), rasterize(src('stripes')));
    writeFileSync(join(d, 'badsvg.ref.svg'), '<svg>quebrado');
    png(join(d, 'typo.png'), rasterize(src('stripes')));
    writeFileSync(join(d, 'typo.json'), JSON.stringify({ preset: 'ilustracao' }));
    png(join(d, 'badjson.png'), rasterize(src('stripes')));
    writeFileSync(join(d, 'badjson.json'), '{ não é json');
    png(join(d, 'opt.png'), rasterize(src('stripes')));
    writeFileSync(join(d, 'opt.json'), JSON.stringify({ options: { maxColour: 3 } }));
    writeFileSync(join(d, 'orfao.ref.svg'), src('logo'));
    writeFileSync(join(d, 'foto.webp'), 'x');
    const issues: Issue[] = [];
    const rows = runPairs(d, none, undefined, issues);
    expect(rows.map((r) => r.id).sort()).toEqual(['badsvg', 'ok', 'opt']); // os que podem rodar rodam
    const err = (id: string) => issues.find((i) => i.id === id && i.level === 'error')?.message ?? '';
    expect(err('broken')).toMatch(/ler a imagem/);
    expect(err('typo')).toMatch(/preset desconhecido "ilustracao".*logo, illustration, photo, cnc/);
    expect(err('badjson')).toMatch(/json inválido/);
    const warn = (id: string) => issues.filter((i) => i.id === id && i.level === 'warn').map((i) => i.message).join(' | ');
    expect(warn('badsvg')).toMatch(/referência inválido/);
    expect(warn('opt')).toMatch(/opção desconhecida "maxColour"/);
    expect(warn('orfao')).toMatch(/não há imagem/);
    expect(warn('foto.webp')).toMatch(/não suportado/);
    expect(rows.find((r) => r.id === 'badsvg')!.ref).toBeUndefined();
  });

  it('referência com 1–2 px de diferença de altura (arredondamento) é aceita; proporção diferente gera aviso', () => {
    const d = tmp();
    const base = rasterize(src('stripes')); // 512×512
    png(join(d, 'a.png'), base);
    writeFileSync(join(d, 'a.ref.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 512 511"><rect width="512" height="511" fill="#fff"/></svg>');
    png(join(d, 'b.png'), base);
    writeFileSync(join(d, 'b.ref.svg'), '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><rect width="400" height="200" fill="#c00"/></svg>');
    const issues: Issue[] = [];
    const rows = runPairs(d, none, undefined, issues);
    expect(rows.find((r) => r.id === 'a')!.ref).toBeDefined();
    expect(rows.find((r) => r.id === 'b')!.ref).toBeUndefined();
    expect(issues.some((i) => i.id === 'b' && /proporção diferente/.test(i.message))).toBe(true);
    expect(issues.some((i) => i.id === 'a')).toBe(false);
  });

  it('limites de par usam a chave `pair:nome` — um par chamado como caso embutido não herda os limites dele', () => {
    expect(thresholdKey('pair', 'logo')).toBe('pair:logo');
    expect(thresholdKey('builtin', 'logo')).toBe('logo');
    const d = tmp();
    jpg(join(d, 'logo.jpg'), rasterize(src('logo')), 50); // JPEG ruim: falharia nos limites rígidos do `logo` sintético
    const strict: ThresholdFile = { default: {}, cases: { logo: { ssim: 0.999, nodes: 80 } } };
    const r1 = runPairs(d, strict)[0];
    expect(r1.hasLimits).toBe(false);
    expect(r1.failures).toEqual([]);
    const own: ThresholdFile = { default: {}, cases: { 'pair:logo': { ssim: 0.9999 } } };
    const r2 = runPairs(d, own)[0];
    expect(r2.hasLimits).toBe(true);
    expect(r2.failures.join()).toMatch(/SSIM/);
  });
});

describe('EXIF (fotos de celular)', () => {
  it('lê a orientação do APP1 e aplica a rotação (a UI abre a imagem já girada)', () => {
    const w = 4, h = 2, data = new Uint8ClampedArray(w * h * 4);
    for (let i = 0; i < w * h; i++) data.set([i * 10, 0, 0, 255], i * 4);
    const base = jpeg.encode({ data: Buffer.from(data), width: w, height: h }, 95).data;
    expect(exifOrientation(base)).toBe(1);
    expect(exifOrientation(withOrientation(base, 6))).toBe(6);
    const im: RawImage = { data, width: w, height: h };
    const r6 = applyOrientation(im, 6); // 90° horário: 4×2 → 2×4; o pixel (0,0) vai para (h−1, 0)
    expect([r6.width, r6.height]).toEqual([2, 4]);
    expect(r6.data[(0 * 2 + 1) * 4]).toBe(data[0]);
    expect(applyOrientation(im, 3).data[((h - 1) * w + (w - 1)) * 4]).toBe(data[0]); // 180°
    expect(applyOrientation(im, 1)).toBe(im);
  });
  it('o par JPEG com EXIF é lido na orientação exibida e avisa', () => {
    const d = tmp();
    const w = 64, h = 32, data = new Uint8ClampedArray(w * h * 4).fill(255);
    const base = jpeg.encode({ data: Buffer.from(data), width: w, height: h }, 90).data;
    writeFileSync(join(d, 'foto.jpg'), withOrientation(base, 6));
    const issues: Issue[] = [];
    const rows = runPairs(d, none, undefined, issues);
    expect([rows[0].width, rows[0].height]).toEqual([32, 64]);
    expect(issues.some((i) => /orientação EXIF 6/.test(i.message))).toBe(true);
  });
});

describe('relatório e imagem comparativa', () => {
  const d = tmp();
  png(join(d, 'sem-ref.png'), rasterize(src('logo')));
  jpg(join(d, 'com-ref.jpg'), rasterize(src('icon')), 60);
  writeFileSync(join(d, 'com-ref.ref.svg'), src('icon'));
  const rows = runPairs(d, none);

  it('worstTiles: ordenados, frações somam ≤ 1 e apontam o bloco com o erro', () => {
    const w = 128, h = 128, m = new Float32Array(w * h);
    for (let y = 64; y < 128; y++) for (let x = 0; x < 64; x++) m[y * w + x] = 10; // todo o erro no bloco (0,64)
    const t = worstTiles(m, w, h, 64, 3);
    expect(t[0]).toMatchObject({ x: 0, y: 64, w: 64, h: 64 });
    expect(t[0].share).toBeCloseTo(1, 6);
    expect(t.reduce((a, b) => a + b.share, 0)).toBeLessThanOrEqual(1 + 1e-9);
  });
  it('formatReport: foco geometria/cor, maiores erros, vs referência e dois rankings', () => {
    const txt = formatReport(rows);
    expect(txt).toMatch(/== sem-ref \(logo, 512×512\)/);
    expect(txt).toMatch(/foco: (GEOMETRIA|COR|geometria e cor)/);
    expect(txt).toMatch(/maiores erros: \(\d+,\d+\) 64×64 = \d+% do erro/);
    expect(txt).toMatch(/nosso vs ref: SSIM [\d.]+ vs [\d.]+ \((melhor|pior|igual)\)/);
    expect(txt).toContain('pares COM referência');
    expect(txt).toContain('Pares SEM referência');
  });
  it('comparePng: original | nosso | mapa de erro [| referência] lado a lado', () => {
    const noRef = PNG.sync.read(comparePng(rows.find((r) => r.id === 'sem-ref')!, 300));
    const withRef = PNG.sync.read(comparePng(rows.find((r) => r.id === 'com-ref')!, 300));
    expect(noRef.width).toBe(3 * 300 + 2 * 6);
    expect(withRef.width).toBe(4 * 300 + 3 * 6);
    expect(noRef.height).toBe(300);
    const heatPx = (noRef.width - 300) * 4; // painel 3, canto superior esquerdo: fundo (erro 0) → cinza-claro
    expect(noRef.data[heatPx]).toBeGreaterThan(150);
  });
});

describe('CLI: --out, --report, --calibrate --write', () => {
  const run = (args: string[]) => spawnSync('npx', ['tsx', 'bench/run.ts', ...args], { encoding: 'utf8', cwd: process.cwd() });
  const d = tmp();
  mkdirSync(join(d, 'pairs'));
  jpg(join(d, 'pairs', 'foto.jpg'), rasterize(src('logo')), 85);
  writeFileSync(join(d, 'pairs', 'foto.ref.svg'), src('logo'));
  const th = join(d, 'thresholds.json');

  it('mede, gera os arquivos de saída e o relatório', () => {
    const r = run(['--no-builtin', '--pairs', join(d, 'pairs'), '--thresholds', th, '--out', join(d, 'out'), '--report', '--no-fail']);
    expect(r.status).toBe(0);
    expect(r.stdout).toContain('foto');
    expect(r.stdout).toContain('sem limites: rode --calibrate --write');
    expect(r.stdout).toContain('Margem de ganho');
    for (const f of ['foto.svg', 'foto.render.png', 'foto.compare.png']) expect(readFileSync(join(d, 'out', f)).length).toBeGreaterThan(100);
  });
  it('--calibrate --write grava `pair:nome`; novo calibrate só APERTA (nunca afrouxa) e erro de par dá exit 1', () => {
    expect(run(['--no-builtin', '--pairs', join(d, 'pairs'), '--thresholds', th, '--calibrate', '--write']).status).toBe(0);
    const f1: ThresholdFile = JSON.parse(readFileSync(th, 'utf8'));
    expect(Object.keys(f1.cases)).toEqual(['pair:foto']);
    expect(f1.cases['pair:foto'].ssim).toBeGreaterThan(0.9);
    // limite mais estrito já existente + resultado pior: continua o mais estrito
    f1.cases['pair:foto'] = { ssim: 0.99999, nodes: 3 };
    writeFileSync(th, JSON.stringify(f1));
    run(['--no-builtin', '--pairs', join(d, 'pairs'), '--thresholds', th, '--calibrate', '--write']);
    const f2: ThresholdFile = JSON.parse(readFileSync(th, 'utf8'));
    expect(f2.cases['pair:foto'].ssim).toBe(0.99999);
    expect(f2.cases['pair:foto'].nodes).toBe(3);
    // com limites rígidos o bench falha; com --no-fail não
    expect(run(['--no-builtin', '--pairs', join(d, 'pairs'), '--thresholds', th]).status).toBe(1);
    expect(run(['--no-builtin', '--pairs', join(d, 'pairs'), '--thresholds', th, '--no-fail']).status).toBe(0);
    // par quebrado: erro listado e exit 1
    writeFileSync(join(d, 'pairs', 'quebrado.png'), 'x');
    const r = run(['--no-builtin', '--pairs', join(d, 'pairs'), '--thresholds', join(d, 'nenhum.json')]);
    expect(r.stdout).toMatch(/ERRO \[quebrado\]/);
    expect(r.status).toBe(1);
  }, 60000);
});

describe('teste de estresse (degradações de produção)', () => {
  it('JPEG q85 no logo: contra a VERDADE limpa a fidelidade se mantém e os nós não explodem', () => {
    const rows = runStress(['logo'], DEGRADATIONS.filter((d) => d.id === 'jpeg85'));
    expect(rows.length).toBe(1);
    expect(rows[0].ssimVsTruth).toBeGreaterThan(0.995);
    expect(rows[0].nodes).toBeLessThan(rows[0].cleanNodes * 3);
    expect(formatStress(rows)).toContain('jpeg85');
  });
  it('conjunto de degradações cobre JPEG, ruído e suavização', () => {
    const ids = DEGRADATIONS.map((d) => d.id);
    expect(ids).toEqual(expect.arrayContaining(['jpeg95', 'jpeg85', 'jpeg70', 'jpeg50', 'ruido4', 'ruido10', 'suave']));
  });
});

