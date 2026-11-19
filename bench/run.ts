import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PNG } from 'pngjs';
import { readFileSync, existsSync } from 'node:fs';
import { formatTable, loadThresholds, proposeThresholds, runBuiltin, runPairs, Row } from './suite';

const args = process.argv.slice(2);
const opt = (name: string, def?: string) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const flag = (name: string) => args.includes(`--${name}`);

const th = loadThresholds(opt('thresholds', 'bench/thresholds.json')!);
const rows: Row[] = [];
if (!flag('no-builtin')) rows.push(...runBuiltin(th, opt('cases')?.split(',')));
rows.push(...runPairs(opt('pairs', 'bench/pairs')!, th, opt('preset')));

console.log(formatTable(rows));

const out = opt('out');
if (out) {
  mkdirSync(out, { recursive: true });
  for (const r of rows) {
    writeFileSync(join(out, `${r.id}.svg`), r.svg);
    const png = new PNG({ width: r.rendered.width, height: r.rendered.height });
    png.data = Buffer.from(r.rendered.data);
    writeFileSync(join(out, `${r.id}.render.png`), PNG.sync.write(png));
  }
}
const thPath = opt('thresholds', 'bench/thresholds.json')!;
if (flag('calibrate')) {
  // propõe (e com --write grava) limites por caso a partir dos resultados desta execução
  const proposed = Object.fromEntries(rows.map((r) => [r.id, proposeThresholds(r)]));
  console.log('\nLimites propostos:\n' + JSON.stringify(proposed, null, 2));
  if (flag('write')) {
    const file = existsSync(thPath) ? JSON.parse(readFileSync(thPath, 'utf8')) : { default: {}, cases: {} };
    file.cases = { ...file.cases, ...proposed };
    writeFileSync(thPath, JSON.stringify(file, null, 2) + '\n');
    console.log(`\nGravado em ${thPath} (${rows.length} casos).`);
  } else console.log('\n(use --write para gravar em ' + thPath + ')');
  process.exit(0);
}
const json = opt('json');
if (json) writeFileSync(json, JSON.stringify(rows.map(({ svg: _s, rendered: _r, ...rest }) => rest), null, 2));
process.exit(rows.some((r) => r.failures.length) && !flag('no-fail') ? 1 : 0);
