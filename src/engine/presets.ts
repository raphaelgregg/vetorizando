import { DEFAULT_OPTIONS, Options } from './types';

export interface Preset {
  id: string;
  label: string;
  hint: string;
  options: Options;
}

const o = (p: Partial<Options>): Options => ({ ...DEFAULT_OPTIONS, ...p });

export const PRESETS: Preset[] = [
  { id: 'logo', label: 'Logotipo / Ícone', hint: 'Poucas cores, bordas nítidas', options: o({ maxColors: 6, speckle: 10, lineFitTolerance: 0.5, smooth: 5, stacking: 'cutouts', gapFiller: true }) },
  { id: 'illustration', label: 'Ilustração', hint: 'Cores médias, camadas empilhadas', options: o({ maxColors: 16, speckle: 8, lineFitTolerance: 0.6, smooth: 4, stacking: 'stacked', gapFiller: false }) },
  { id: 'photo', label: 'Foto / Arte complexa', hint: 'Muitas cores, mais detalhe', options: o({ maxColors: 32, mergeDeltaE: 5, speckle: 6, lineFitTolerance: 0.9, smooth: 3, stacking: 'stacked', gapFiller: false }) },
  { id: 'cnc', label: 'Corte CNC / Laser', hint: 'Contornos, sem sobreposição', options: o({ maxColors: 3, speckle: 16, lineFitTolerance: 0.4, smooth: 4, stacking: 'cutouts', gapFiller: false, drawStyle: 'outline' }) },
];
