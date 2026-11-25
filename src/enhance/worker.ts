import { Transform, prepare } from './crop';
import { EditOps, EnhanceParams, OutputSpec, enhance, enhanceBase, fitToSize } from './ops';
import type { RawImage } from '../engine/types';

export interface EnhanceRequest {
  id: number;
  image: RawImage;
  params: EnhanceParams;
  out?: OutputSpec;
  /** giro/espelho/endireitar e recorte */
  transform?: Transform;
  /** só aplica a transformação (sem recorte nem melhorias): imagem para ajustar o recorte */
  transformOnly?: boolean;
  /** remoções da varinha, formas e camada da imagem */
  edit?: EditOps;
  /** só a parte pesada (sem formas nem forma do recorte): a prévia compõe o resto no navegador, rápido */
  baseOnly?: boolean;
  /** também devolve a imagem SEM melhorias, no mesmo enquadramento (comparação antes/depois) */
  withBefore?: boolean;
}

export interface EnhanceResponse { id: number; type: 'done' | 'error'; image?: RawImage; before?: RawImage; message?: string }

self.onmessage = (ev: MessageEvent<EnhanceRequest>) => {
  const { id, image, params, out, withBefore, transform, transformOnly, edit, baseOnly } = ev.data;
  const post = (m: EnhanceResponse, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);
  try {
    if (transformOnly) {
      const r = transform ? prepare(image, { ...transform, crop: null }) : image;
      post({ id, type: 'done', image: r === image ? { ...r, data: new Uint8ClampedArray(r.data) } : r }, r === image ? [] : [r.data.buffer]);
      return;
    }
    const result = baseOnly ? enhanceBase(image, params, out, transform, edit) : enhance(image, params, out, transform, edit);
    const prepared = transform ? prepare(image, transform) : image;
    const before = withBefore ? (out ? fitToSize(prepared, out.width, out.height, out.fit, out.fx, out.fy, out.background) : prepared) : undefined;
    const tr: Transferable[] = [result.data.buffer];
    if (before && before.data.buffer !== result.data.buffer && before.data.buffer !== image.data.buffer) tr.push(before.data.buffer);
    if (before && before.data.buffer === image.data.buffer) tr.splice(0, tr.length, result.data.buffer);
    post({ id, type: 'done', image: result, before: before && (before.data.buffer === image.data.buffer ? { ...before, data: new Uint8ClampedArray(before.data) } : before) }, tr);
  } catch (e) {
    post({ id, type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
