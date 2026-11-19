export interface IosIcon { idiom: 'iphone' | 'ipad' | 'ios-marketing'; size: number; scale: 1 | 2 | 3; pixels: number; filename: string }

const sz = (s: number) => (Number.isInteger(s) ? String(s) : String(s));

function icon(idiom: IosIcon['idiom'], size: number, scale: 1 | 2 | 3): IosIcon {
  return { idiom, size, scale, pixels: Math.round(size * scale), filename: `Icon-App-${sz(size)}x${sz(size)}@${scale}x.png` };
}

/** Conjunto padrão do Xcode para iPhone, iPad e App Store (ordem do Contents.json). */
export const IOS_ICONS: IosIcon[] = [
  icon('iphone', 20, 2), icon('iphone', 20, 3),
  icon('iphone', 29, 2), icon('iphone', 29, 3),
  icon('iphone', 40, 2), icon('iphone', 40, 3),
  icon('iphone', 60, 2), icon('iphone', 60, 3),
  icon('ipad', 20, 1), icon('ipad', 20, 2),
  icon('ipad', 29, 1), icon('ipad', 29, 2),
  icon('ipad', 40, 1), icon('ipad', 40, 2),
  icon('ipad', 76, 1), icon('ipad', 76, 2),
  icon('ipad', 83.5, 2),
  icon('ios-marketing', 1024, 1),
];

/** `AppIcon.appiconset/Contents.json` válido para o Xcode. */
export function contentsJson(): string {
  return JSON.stringify({
    images: IOS_ICONS.map((i) => ({ idiom: i.idiom, scale: `${i.scale}x`, size: `${sz(i.size)}x${sz(i.size)}`, filename: i.filename })),
    info: { author: 'xcode', version: 1 },
  }, null, 2) + '\n';
}
