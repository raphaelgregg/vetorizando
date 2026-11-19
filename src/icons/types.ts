import type { SvgColors } from '../engine/svg';

export type Platform = 'web' | 'android' | 'ios';

export interface IconSettings {
  appName: string;
  shortName: string;
  themeColor: string; // #rrggbb
  /** fundo dos ícones opacos (iOS, Android legado, maskable, apple-touch) e do adaptive icon */
  backgroundColor: string;
  /** margem interna 0–0,3 (fração do lado) nos ícones raster */
  padding: number;
  platforms: Record<Platform, boolean>;
  /** modo de cor do icon.svg (hex / currentColor / classes) */
  svgColors: SvgColors;
}

export const DEFAULT_ICON_SETTINGS: IconSettings = {
  appName: 'Meu App',
  shortName: 'App',
  themeColor: '#6d5efc',
  backgroundColor: '#ffffff',
  padding: 0.06,
  platforms: { web: true, android: true, ios: true },
  svgColors: { mode: 'hex' },
};

export interface AssetFile {
  /** caminho dentro do pacote, ex.: `android/res/mipmap-hdpi/ic_launcher.png` */
  path: string;
  platform: Platform;
  kind: 'png' | 'ico' | 'svg' | 'xml' | 'json' | 'txt' | 'html';
  data: Uint8Array | string;
  /** lado em pixels (PNG) */
  size?: number;
  note: string;
}

/** Rasteriza um SVG quadrado `size`×`size` em RGBA (navegador: canvas; testes/Node: resvg). */
export type Renderer = (svg: string, size: number) => Promise<{ data: Uint8ClampedArray | Uint8Array; width: number; height: number }>;
