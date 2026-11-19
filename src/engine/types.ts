export interface Pt {
  x: number;
  y: number;
}

/** Reta, Bézier cúbica, arco circular (A) ou arco elíptico (E); flags e `rot` (graus) no padrão SVG. */
export type Seg =
  | { t: 'L'; p: Pt }
  | { t: 'C'; c1: Pt; c2: Pt; p: Pt }
  | { t: 'A'; r: number; large: 0 | 1; sweep: 0 | 1; p: Pt }
  | { t: 'E'; rx: number; ry: number; rot: number; large: 0 | 1; sweep: 0 | 1; p: Pt };

/** Caminho fechado: começa em `start` e termina (implicitamente) nele. */
export interface VPath {
  start: Pt;
  segs: Seg[];
  /** contorno de traço fino (largura ≲ 4 px): não recebe traço de preenchimento de fendas (vazaria nos pixels de borda) */
  thin?: boolean;
}

export interface Layer {
  color: string; // #rrggbb
  paths: VPath[];
}

export interface VDoc {
  width: number; // dimensões do espaço de processamento
  height: number;
  layers: Layer[]; // ordem de desenho: fundo → frente
  /** há bordas com “nada” (transparência/fundo removido): o preenchimento de fendas deve ser recortado pela união das regiões */
  openBoundary: boolean;
  stats: {
    nodes: number; // nós finais (segmentos)
    paths: number;
    colors: number;
    ms: number;
    rawPoints: number; // pontos de contorno antes do ajuste ("antes")
    lines: number;
    arcs: number;
    ellipses: number;
    curves: number;
    recolored: number; // pixels de transição (anti-aliasing) corrigidos
  };
}

export interface RawImage {
  data: Uint8ClampedArray; // RGBA
  width: number;
  height: number;
}

export type Stacking = 'cutouts' | 'stacked';
export type DrawStyle = 'fill' | 'outline';
export type GroupBy = 'none' | 'color' | 'layer';

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
  edgeDelta: number; // limpeza de anti-aliasing (ΔE); 0 = desligado
  contourBlur: number; // sigma da suavização subpixel do contorno
  arcs: boolean; // permitir arcos circulares
  ellipses: boolean; // permitir arcos elípticos
}

export const DEFAULT_OPTIONS: Options = {
  maxColors: 8,
  mergeDeltaE: 8,
  speckle: 8,
  lineFitTolerance: 0.5,
  cornerThreshold: 60,
  smooth: 5,
  stacking: 'cutouts',
  gapFiller: true,
  gapStrokeWidth: 0.6,
  drawStyle: 'fill',
  groupBy: 'none',
  removeBackground: false,
  edgeDelta: 8,
  contourBlur: 0,
  arcs: true,
  ellipses: true,
};

export type ProgressFn = (fraction: number, label: string) => void;
