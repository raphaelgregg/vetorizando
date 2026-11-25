import { EnhanceParams, OutputSpec, enhance, fitToSize } from './ops';
import type { RawImage } from '../engine/types';

export interface EnhanceRequest {
  id: number;
  image: RawImage;
  params: EnhanceParams;
  out?: OutputSpec;
  /** também devolve a imagem SEM melhorias, no mesmo enquadramento (comparação antes/depois) */
  withBefore?: boolean;
}

export interface EnhanceResponse { id: number; type: 'done' | 'error'; image?: RawImage; before?: RawImage; message?: string }

self.onmessage = (ev: MessageEvent<EnhanceRequest>) => {
  const { id, image, params, out, withBefore } = ev.data;
  const post = (m: EnhanceResponse, t: Transferable[] = []) => (self as unknown as Worker).postMessage(m, t);
  try {
    const result = enhance(image, params, out);
    const before = withBefore ? (out ? fitToSize(image, out.width, out.height, out.fit, out.fx, out.fy, out.background) : image) : undefined;
    const tr: Transferable[] = [result.data.buffer];
    if (before && before.data.buffer !== result.data.buffer && before.data.buffer !== image.data.buffer) tr.push(before.data.buffer);
    post({ id, type: 'done', image: result, before: before && (before.data.buffer === image.data.buffer ? { ...before, data: new Uint8ClampedArray(before.data) } : before) }, tr);
  } catch (e) {
    post({ id, type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
