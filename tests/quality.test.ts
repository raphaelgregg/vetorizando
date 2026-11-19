import { describe, expect, it } from 'vitest';
import { CASES, rasterize } from '../bench/cases';
import { PRESETS } from '../src/engine/presets';
import { vectorize } from '../src/engine/vectorize';

/** Resultados do v0.1 (commit c403dac) nos mesmos casos, para garantir a redução de nós. */
const BASELINE: Record<string, number> = { logo: 300, icon: 220, illustration: 552, lineart: 838, stripes: 106 };

function run(id: string) {
  const c = CASES.find((x) => x.id === id)!;
  return vectorize(rasterize(c.svg), PRESETS.find((p) => p.id === c.preset)!.options);
}

describe('qualidade de curvas e bordas', () => {
  for (const [id, base] of Object.entries(BASELINE)) {
    it(`${id}: reduz ≥ 50% dos nós vs. v0.1 (${base})`, () => {
      const d = run(id);
      expect(d.stats.nodes).toBeLessThanOrEqual(base * 0.5);
    });
  }

  it('anti-aliasing não cria cores/bolhas: logo tem 4 cores e a bolinha laranja ≤ 4 nós', () => {
    const d = run('logo');
    expect(d.layers.length).toBe(4);
    const orange = d.layers.find((l) => l.color.startsWith('#ff7'))!;
    expect(orange.paths.length).toBe(1);
    expect(orange.paths[0].segs.length).toBeLessThanOrEqual(4);
  });

  it('usa arcos para círculos e retas para polígonos', () => {
    const d = run('logo');
    expect(d.stats.arcs).toBeGreaterThan(0);
    const rect = d.layers.find((l) => l.color.startsWith('#17'))!.paths.find((p) => p.segs.length === 4 && p.segs.every((s) => s.t === 'L'));
    expect(rect).toBeTruthy();
  });

  it('métricas antes/depois: pontos de contorno ≫ nós', () => {
    const s = run('icon').stats;
    expect(s.rawPoints).toBeGreaterThan(s.nodes * 20);
    expect(s.lines + s.arcs + s.curves).toBe(s.nodes);
  });

  it('desligar arcos remove segmentos de arco', () => {
    const c = CASES.find((x) => x.id === 'logo')!;
    const d = vectorize(rasterize(c.svg), { ...PRESETS[0].options, arcs: false });
    expect(d.stats.arcs).toBe(0);
  });
});
