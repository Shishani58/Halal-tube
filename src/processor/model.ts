import type * as Ort from 'onnxruntime-web';
import type { RunModel } from '../core/tiles';

export interface LoadedModel {
  run: RunModel;
  backend: string;
  /** The half-precision variant of the model was loaded. */
  fp16: boolean;
  release: () => Promise<void>;
}

export interface LoadOptions {
  /** Extension root URL, e.g. chrome-extension://id/ */
  base: string;
  modelFile: string;
  /**
   * Same model with fp16 weights and fp32 inputs/outputs (scripts/make-fp16.py): used on WebGPU
   * when the GPU has `shader-f16` and the file was shipped; otherwise `modelFile`.
   */
  fp16File?: string;
  /** Default input shape (warm-up, and calls that don't pass one). */
  shape: [number, number, number, number];
  /** Force a backend (benchmarking); default tries WebGPU then WASM. */
  backend?: 'webgpu' | 'wasm';
}

let ortPromise: Promise<typeof Ort> | null = null;

export async function loadOrt(base: string): Promise<typeof Ort> {
  if (!ortPromise) {
    ortPromise = (async () => {
      const url = `${base}ort/ort.webgpu.min.mjs`;
      const ort = (await import(/* webpackIgnore: true */ url)) as typeof Ort;
      ort.env.wasm.wasmPaths = `${base}ort/`;
      ort.env.wasm.numThreads = 1; // extension iframes aren't cross-origin isolated
      ort.env.logLevel = 'error';
      return ort;
    })();
  }
  return ortPromise;
}

async function fetchModel(base: string, file: string): Promise<Uint8Array | null> {
  const res = await fetch(`${base}models/${file}`).catch(() => null);
  return res?.ok ? new Uint8Array(await res.arrayBuffer()) : null;
}

export async function loadModel(opts: LoadOptions): Promise<LoadedModel> {
  const ort = await loadOrt(opts.base);
  let fp32: Uint8Array | null = null;
  const tryBackends: ('webgpu' | 'wasm')[] = opts.backend ? [opts.backend] : ['webgpu', 'wasm'];
  let lastErr: unknown = null;
  for (const backend of tryBackends) {
    let fp16 = false;
    try {
      let bytes: Uint8Array | null = null;
      if (backend === 'webgpu') {
        const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
        if (!gpu) throw new Error('WebGPU unavailable');
        const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) throw new Error('No WebGPU adapter');
        // fp16 weights: half the download, ~25% faster on the GPU, same output to −45 dB
        if (opts.fp16File && adapter.features.has('shader-f16')) {
          bytes = await fetchModel(opts.base, opts.fp16File);
          fp16 = !!bytes;
        }
      }
      if (!bytes) {
        fp32 ??= await fetchModel(opts.base, opts.modelFile);
        if (!fp32) throw new Error(`model fetch failed: ${opts.modelFile}`);
        bytes = fp32;
      }
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: [backend],
        graphOptimizationLevel: 'all',
      });
      const inName = session.inputNames[0];
      const outName = session.outputNames[0];
      const run: RunModel = async (input, shape = opts.shape) => {
        const tensor = new ort.Tensor('float32', input.length === size(shape) ? input : input.subarray(0, size(shape)), shape);
        const out = await session.run({ [inName]: tensor });
        const t = out[outName];
        const data = (await t.getData()) as Float32Array;
        return data;
      };
      // warm-up compiles shaders so the first real tile isn't slow
      await run(new Float32Array(size(opts.shape)));
      return { run, backend, fp16, release: () => session.release() };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

const size = (shape: readonly number[]) => shape.reduce((a, b) => a * b, 1);
