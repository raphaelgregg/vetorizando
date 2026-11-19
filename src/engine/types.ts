export interface Pt {
  x: number;
  y: number;
}

export type Seg = { t: 'L'; p: Pt } | { t: 'C'; c1: Pt; c2: Pt; p: Pt };

/** Caminho fechado: começa em `start` e termina (implicitamente) nele. */
export interface VPath {
  start: Pt;
  segs: Seg[];
}

export interface Layer {
  color: string; // #rrggbb
  paths: VPath[];
}

export interface VDoc {
  width: number; // dimensões do espaço de processamento
  height: number;
  layers: Layer[]; // ordem de desenho: fundo → frente
  stats: { nodes: number; paths: number; colors: number; ms: number };
}

export interface RawImage {
  data: Uint8ClampedArray; // RGBA
  width: number;
  height: number;
}

export type Stacking = 'cutouts' | 'stacked';
export type DrawStyle = 'fill' | 'outline';
export type GroupBy = 'none' | 'color';

export interface Options {
  maxColors: number;
  mergeDeltaE: number; // mescla de tons próximos (CIE76)
  speckle: number; // área mínima (px) de regiões
  lineFitTolerance: number; // px
  cornerThreshold: number; // graus
  smooth: number; // raio de suavização de degraus (px)
  stacking: Stacking;
  gapFiller: boolean;
  gapStrokeWidth: number;
  drawStyle: DrawStyle;
  groupBy: GroupBy;
  removeBackground: boolean;
}

export const DEFAULT_OPTIONS: Options = {
  maxColors: 8,
  mergeDeltaE: 8,
  speckle: 8,
  lineFitTolerance: 0.5,
  cornerThreshold: 60,
  smooth: 2,
  stacking: 'cutouts',
  gapFiller: true,
  gapStrokeWidth: 0.6,
  drawStyle: 'fill',
  groupBy: 'none',
  removeBackground: false,
};

export type ProgressFn = (fraction: number, label: string) => void;
