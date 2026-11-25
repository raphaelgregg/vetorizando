import type { RawImage } from '../engine/types';

export const MAX_BYTES = 20 * 1024 * 1024;
export const MAX_DIM = 1400; // lado maior no espaço de processamento
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif', 'image/bmp'];

export interface Loaded {
  /** arquivo original (para decodificar em resolução total ao melhorar/exportar) */
  file: File;
  name: string;
  url: string; // imagem exibida (já no espaço de processamento)
  image: RawImage;
  origWidth: number;
  origHeight: number;
}

export class LoadError extends Error {}

export async function loadFile(file: File): Promise<Loaded> {
  if (!TYPES.includes(file.type)) throw new LoadError('Formato não suportado. Use PNG, JPG, WebP, GIF ou BMP.');
  if (file.size > MAX_BYTES) throw new LoadError('Arquivo muito grande (máximo 20 MB).');
  let bmp: ImageBitmap;
  try {
    bmp = await createImageBitmap(file);
  } catch {
    throw new LoadError('Não foi possível ler a imagem. O arquivo pode estar corrompido.');
  }
  const k = Math.min(1, MAX_DIM / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.drawImage(bmp, 0, 0, w, h);
  const id = ctx.getImageData(0, 0, w, h);
  const blob = await new Promise<Blob>((res, rej) => c.toBlob((b) => (b ? res(b) : rej(new LoadError('Falha ao preparar a imagem'))), 'image/png'));
  const out: Loaded = {
    file,
    name: file.name.replace(/\.[^.]+$/, '') || 'imagem',
    url: URL.createObjectURL(blob),
    image: { data: id.data, width: w, height: h },
    origWidth: bmp.width,
    origHeight: bmp.height,
  };
  bmp.close();
  return out;
}

export const MAX_FULL = 4096; // lado maior ao decodificar a imagem original para melhoria/exportação

/** Decodifica o arquivo em resolução total (limitada a `MAX_FULL`); respeita a orientação EXIF. */
export async function decodeFull(file: File, maxSide = MAX_FULL): Promise<RawImage> {
  const bmp = await createImageBitmap(file);
  const k = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * k)), h = Math.max(1, Math.round(bmp.height * k));
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true })!;
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bmp, 0, 0, w, h);
  const id = ctx.getImageData(0, 0, w, h);
  bmp.close();
  return { data: id.data, width: w, height: h };
}
