import { vectorize } from './vectorize';
import type { Options, RawImage } from './types';

export interface WorkerRequest {
  id: number;
  image: RawImage;
  options: Options;
}

self.onmessage = (ev: MessageEvent<WorkerRequest>) => {
  const { id, image, options } = ev.data;
  try {
    const doc = vectorize(image, options, (fraction, label) => (self as unknown as Worker).postMessage({ id, type: 'progress', fraction, label }));
    (self as unknown as Worker).postMessage({ id, type: 'done', doc });
  } catch (e) {
    (self as unknown as Worker).postMessage({ id, type: 'error', message: e instanceof Error ? e.message : String(e) });
  }
};
