export type Unit = 'px' | 'mm' | 'cm' | '%';

export interface SizeSpec {
  unit: Unit;
  /** Largura na unidade escolhida (em `%`: porcentagem do tamanho original). */
  width?: number;
  /** Altura; só usada se a largura não for informada (a proporção é sempre preservada). */
  height?: number;
  /** Resolução usada para converter pixels ↔ medidas físicas. */
  dpi: number;
}

export interface ResolvedSize {
  unit: 'px' | 'mm' | 'cm';
  width: number;
  height: number;
  scale: number; // unidades de saída por unidade do documento vetorial
  ptPerUnit: number; // pontos PDF/PostScript por unidade de saída
  widthPt: number;
  heightPt: number;
}

export const DEFAULT_SIZE: SizeSpec = { unit: 'px', dpi: 96 };

/** Calcula o tamanho final de exportação preservando a proporção. */
export function resolveSize(spec: SizeSpec, origW: number, origH: number, docW: number, docH: number): ResolvedSize {
  const dpi = spec.dpi > 0 ? spec.dpi : 96;
  const unit: 'px' | 'mm' | 'cm' = spec.unit === '%' ? 'px' : spec.unit;
  const pxPerUnit = unit === 'px' ? 1 : unit === 'mm' ? dpi / 25.4 : dpi / 2.54;
  const aspect = docH / docW;
  let width: number;
  if (spec.unit === '%') width = (origW * (spec.width && spec.width > 0 ? spec.width : 100)) / 100;
  else if (spec.width && spec.width > 0) width = spec.width;
  else if (spec.height && spec.height > 0) width = spec.height / aspect;
  else width = origW / pxPerUnit;
  const scale = width / docW;
  const height = docH * scale;
  const ptPerUnit = unit === 'px' ? 72 / dpi : unit === 'mm' ? 72 / 25.4 : 72 / 2.54;
  void origH;
  return { unit, width, height, scale, ptPerUnit, widthPt: width * ptPerUnit, heightPt: height * ptPerUnit };
}

/** Valores de exibição (largura, altura) ao trocar de unidade, mantendo o tamanho físico/relativo. */
export function sizeInUnit(unit: Unit, origW: number, origH: number, dpi: number): { width: number; height: number } {
  if (unit === '%') return { width: 100, height: 100 };
  const r = resolveSize({ unit, dpi }, origW, origH, origW, origH);
  return { width: r.width, height: r.height };
}

export function fmt(v: number, d = 3): string {
  const s = (Math.round(v * 10 ** d) / 10 ** d).toString();
  return s === '-0' ? '0' : s;
}
