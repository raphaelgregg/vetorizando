import type { EnhanceRequest, EnhanceResponse } from '../enhance/worker';
import type { EnhanceParams, OutputSpec } from '../enhance/ops';
import type { RawImage } from '../engine/types';

/** Executa a melhoria em Web Worker; uma nova execução cancela a anterior (cada cliente tem o seu trabalho). */
export class EnhanceClient {
  private worker: Worker | null = null;
  private seq = 0;
  private reject: ((e: Error) => void) | null = null;

  run(image: RawImage, params: EnhanceParams, out?: OutputSpec, withBefore = false): Promise<{ image: RawImage; before?: RawImage }> {
    this.reject?.(new Error('cancelled'));
    this.worker?.terminate();
    const w = (this.worker = new Worker(new URL('../enhance/worker.ts', import.meta.url), { type: 'module' }));
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.reject = reject;
      w.onmessage = (ev: MessageEvent<EnhanceResponse>) => {
        const m = ev.data;
        if (m.id !== id) return;
        this.reject = null;
        if (m.type === 'done') resolve({ image: m.image!, before: m.before }); else reject(new Error(m.message));
      };
      w.onerror = (e) => { this.reject = null; reject(new Error(e.message || 'Falha no processamento')); };
      const req: EnhanceRequest = { id, image: { data: new Uint8ClampedArray(image.data), width: image.width, height: image.height }, params, out, withBefore };
      w.postMessage(req);
    });
  }

  cancel(): void { this.reject?.(new Error('cancelled')); this.reject = null; this.worker?.terminate(); this.worker = null; }
}
