/// <reference lib="webworker" />
/**
 * MobileCLIP-S0 image encoder in a worker of its own, started by the vision worker. In the same
 * ONNX Runtime instance as NudeNet, WebGPU runs of the two made the detector hang or fail after a
 * few batches; a worker of its own has its own runtime and GPU device. WebGPU only: on the CPU it
 * takes ~1.6 s a frame, far too slow to keep up with the video.
 */
import { CLIP_INPUT as CS, CLIP_VIEWS, clipFrameWomen } from '../core/clip';
import { describeSelfTest, loadModel, type LoadedModel } from './model';

declare const self: DedicatedWorkerGlobalScope;

/** `views`: squares per frame in `input` (CLIP_VIEWS by default; 1 for a quick look at a whole picture). */
export type ToClip = { type: 'load' } | { type: 'run'; id: number; input: Float32Array; frames: number; views?: number } | { type: 'release' };
export type FromClip = { type: 'loaded'; ok: boolean; error?: string; selfTest?: string } | { type: 'result'; id: number; scores?: number[]; error?: string };

const base = new URL('../', self.location.href).href;
let model: LoadedModel | null = null;
/** All frames of a call in one run; dropped after a failure (in the vision worker's runtime a big batch once ran out of WASM memory). */
let batched = true;
const post = (m: FromClip) => self.postMessage(m);

self.onmessage = async (e: MessageEvent<ToClip>) => {
  const m = e.data;
  if (m.type === 'load') {
    try {
      model ??= await loadModel({ base, modelFile: 'mobileclip-s0-vision.onnx', shape: [CLIP_VIEWS, 3, CS, CS], backend: 'webgpu' });
      post({ type: 'loaded', ok: true, selfTest: describeSelfTest(model) });
    } catch (err) {
      post({ type: 'loaded', ok: false, error: err instanceof Error ? err.message : String(err) });
    }
  } else if (m.type === 'run') {
    try {
      if (!model) throw new Error('not loaded');
      const views = m.views ?? CLIP_VIEWS;
      const per = views * 3 * CS * CS;
      const scores: number[] = [];
      if (batched) {
        // every frame's views in one run: ~2.5× less time per frame than one run per frame
        try {
          const out = await model.run(m.input.subarray(0, m.frames * per), [m.frames * views, 3, CS, CS]);
          for (let j = 0; j < m.frames; j++) scores.push(clipFrameWomen(out, j * views, views));
        } catch (err) {
          console.warn('[music-remover] batched scene run failed, one frame at a time from now on', err);
          batched = false;
          scores.length = 0;
        }
      }
      if (!batched)
        for (let j = 0; j < m.frames; j++) scores.push(clipFrameWomen(await model.run(m.input.subarray(j * per, (j + 1) * per), [views, 3, CS, CS]), 0, views));
      post({ type: 'result', id: m.id, scores });
    } catch (err) {
      post({ type: 'result', id: m.id, error: err instanceof Error ? err.message : String(err) });
    }
  } else if (m.type === 'release') {
    const md = model;
    model = null;
    await md?.release().catch(() => undefined);
  }
};
