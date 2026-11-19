import { pathData } from '../engine/svg';
import { suggestCurrentColor } from '../engine/palette';
import type { Options, VDoc } from '../engine/types';
import type { SvgColors } from '../engine/svg';
import { paintMode } from '../export/groups';

export const DENSITIES = [
  { name: 'mdpi', scale: 1, launcher: 48 },
  { name: 'hdpi', scale: 1.5, launcher: 72 },
  { name: 'xhdpi', scale: 2, launcher: 96 },
  { name: 'xxhdpi', scale: 3, launcher: 144 },
  { name: 'xxxhdpi', scale: 4, launcher: 192 },
] as const;

const n2 = (v: number) => String(Math.round(v * 100) / 100);
/** #rrggbb → #AARRGGBB (formato de cor do Android) */
export const argb = (hex: string) => '#FF' + hex.slice(1).toUpperCase();
const ANDROID_NS = 'xmlns:android="http://schemas.android.com/apk/res/android"';

export interface VectorOptions {
  /** tamanho em dp e viewport (px do viewport = unidades do desenho) */
  dp: number;
  viewport: number;
  /** ajusta o desenho (contain) dentro de `box`×`box` unidades centrado no viewport; omitido = ocupa o viewport todo */
  box?: number;
  /** todas as camadas numa cor só (#rrggbb) — camada monocromática do ícone temático (Android 13+) */
  forceColor?: string;
  colors?: SvgColors;
}

/**
 * Android Vector Drawable (`<vector>`) do documento: caminhos `M/L/C/A/Z`, uma `<path>` por camada, com o mesmo
 * preenchimento de fendas (traços abaixo dos preenchimentos, recortados pela união em bordas abertas).
 * Com `colors.mode = 'currentColor'` o desenho usa `android:tint="?attr/colorControlNormal"` (herda a cor do tema).
 */
export function vectorDrawable(doc: VDoc, o: Options, v: VectorOptions): string {
  const { fill, gap } = paintMode(o);
  const k = v.box ? Math.min(v.box / doc.width, v.box / doc.height) : Math.min(v.viewport / doc.width, v.viewport / doc.height);
  const tx = (v.viewport - doc.width * k) / 2, ty = (v.viewport - doc.height * k) / 2;
  const cc = v.colors?.mode === 'currentColor' ? v.colors.currentColor ?? suggestCurrentColor(doc) : undefined;
  const colorOf = (hex: string) => (v.forceColor ? argb(v.forceColor) : cc && hex === cc ? '#FF000000' : argb(hex));
  const sc = String(Math.round(k * 10000) / 10000);
  const tint = !v.forceColor && cc ? ' android:tint="?attr/colorControlNormal"' : '';
  const lines: string[] = [
    '<?xml version="1.0" encoding="utf-8"?>',
    `<vector ${ANDROID_NS}`,
    `    android:width="${n2(v.dp)}dp"`,
    `    android:height="${n2(v.dp)}dp"`,
    `    android:viewportWidth="${n2(v.viewport)}"`,
    `    android:viewportHeight="${n2(v.viewport)}"${tint}>`,
    `  <group android:translateX="${n2(tx)}" android:translateY="${n2(ty)}" android:scaleX="${sc}" android:scaleY="${sc}">`,
  ];
  const dOf = (paths: typeof doc.layers[number]['paths']) => paths.map(pathData).join('');
  if (gap && !v.forceColor) {
    lines.push('    <group>');
    if (doc.openBoundary) lines.push(`      <clip-path android:pathData="${doc.layers.map((l) => dOf(l.paths)).join('')}"/>`);
    for (const l of doc.layers) {
      const d = dOf(l.paths.filter((p) => !p.thin));
      if (d) lines.push(`      <path android:strokeColor="${colorOf(l.color)}" android:strokeWidth="${n2(o.gapStrokeWidth)}" android:strokeLineJoin="round" android:pathData="${d}"/>`);
    }
    lines.push('    </group>');
  }
  for (const l of doc.layers) {
    const d = dOf(l.paths);
    lines.push(fill || v.forceColor
      ? `    <path android:fillColor="${colorOf(l.color)}" android:pathData="${d}"/>`
      : `    <path android:strokeColor="${colorOf(l.color)}" android:strokeWidth="1" android:pathData="${d}"/>`);
  }
  lines.push('  </group>', '</vector>', '');
  return lines.join('\n');
}

export const adaptiveIconXml = (monochrome: boolean) => `<?xml version="1.0" encoding="utf-8"?>
<adaptive-icon ${ANDROID_NS}>
    <background android:drawable="@color/ic_launcher_background"/>
    <foreground android:drawable="@drawable/ic_launcher_foreground"/>${monochrome ? '\n    <monochrome android:drawable="@drawable/ic_launcher_monochrome"/>' : ''}
</adaptive-icon>
`;

export const backgroundColorXml = (hex: string) => `<?xml version="1.0" encoding="utf-8"?>
<resources>
    <color name="ic_launcher_background">${hex.toUpperCase()}</color>
</resources>
`;
