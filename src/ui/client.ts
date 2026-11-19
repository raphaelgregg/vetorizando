import type { WorkerRequest } from '../engine/worker';
import type { Options, ProgressFn, RawImage, VDoc } from '../engine/types';

/** Executa o motor em Web Worker; uma nova execução cancela a anterior. */
export class EngineClient {
  private worker: Worker | null = null;
  private seq = 0;
  private reject: ((e: Error) => void) | null = null;

  private spawn(): Worker {
    this.worker?.terminate();
    this.worker = new Worker(new URL('../engine/worker.ts', import.meta.url), { type: 'module' });
    return this.worker;
  }

  run(image: RawImage, options: Options, onProgress: ProgressFn): Promise<VDoc> {
    this.reject?.(new Error('cancelled'));
    const id = ++this.seq;
    const w = this.spawn();
    return new Promise<VDoc>((resolve, reject) => {
      this.reject = reject;
      w.onmessage = (ev) => {
        const m = ev.data;
        if (m.id !== id) return;
        if (m.type === 'progress') onProgress(m.fraction, m.label);
        else if (m.type === 'done') { this.reject = null; resolve(m.doc); }
        else { this.reject = null; reject(new Error(m.message)); }
      };
      w.onerror = (e) => { this.reject = null; reject(new Error(e.message || 'Falha no processamento')); };
      const req: WorkerRequest = { id, image: { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height }, options };
      w.postMessage(req);
    });
  }
}
