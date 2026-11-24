import { describe, expect, it } from 'vitest';
import { CASES, rasterize } from '../bench/cases';
import { renderSvg } from '../bench/io';
import { compare } from '../bench/metrics';
import { DEGRADATIONS } from '../bench/stress';
import { autoOptions, profileImage, suggestPreset } from '../src/engine/analyze';
import { PRESETS } from '../src/engine/presets';
import { toSVG } from '../src/engine/svg';
import { vectorize } from '../src/engine/vectorize';

const img = (id: string) => rasterize(CASES.find((c) => c.id === id)!.svg);
const deg = (id: string) => DEGRADATIONS.find((d) => d.id === id)!;

describe('escolha automática de preset e cores', () => {
  it('arte chapada (logo, ícone, linhas, texto, formas, listras) → logo', () => {
    for (const id of ['logo', 'icon', 'lineart', 'text', 'ellipses', 'details', 'stripes']) expect(suggestPreset(profileImage(img(id))).preset, id).toBe('logo');
  });
  it('ilustração com degradês → ilustração; foto → foto', () => {
    expect(suggestPreset(profileImage(img('illustration'))).preset).toBe('illustration');
    expect(suggestPreset(profileImage(img('gradients'))).preset).toBe('illustration');
    expect(suggestPreset(profileImage(img('photo'))).preset).toBe('photo');
  });
  it('ruído e JPEG não mudam a classificação (o perfil é medido na imagem filtrada)', () => {
    expect(suggestPreset(profileImage(deg('jpeg50').apply(img('logo')))).preset).toBe('logo');
    expect(suggestPreset(profileImage(deg('ruido10').apply(img('illustration')))).preset).toBe('illustration');
    expect(suggestPreset(profileImage(deg('ruido4').apply(img('text')))).preset).toBe('logo');
  });
  it('o nº de cores acompanha a complexidade e fica nos limites do preset', () => {
    const a = autoOptions(img('illustration')).options.maxColors, b = autoOptions(img('logo')).options.maxColors;
    expect(a).toBeGreaterThanOrEqual(12);
    expect(b).toBeLessThanOrEqual(10);
    expect(a).toBeGreaterThan(b);
  });
  it('o resultado automático não perde para o preset manual correspondente (SSIM)', () => {
    for (const id of ['text', 'illustration', 'gradients']) {
      const im = img(id), a = autoOptions(im);
      const hand = PRESETS.find((p) => p.id === CASES.find((c) => c.id === id)!.preset)!.options;
      const m = (o: typeof hand) => compare(im, renderSvg(toSVG(vectorize(im, o), o), im.width)).ssim;
      expect(m(a.options), id).toBeGreaterThanOrEqual(m(hand) - 0.003);
    }
  });
});
