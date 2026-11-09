import type * as Ort from 'onnxruntime-web';
import type { RunModel } from '../core/tiles';

export interface LoadedModel {
  run: RunModel;
  backend: string;
  release: () => Promise<void>;
}

export interface LoadOptions {
  /** Extension root URL, e.g. chrome-extension://id/ */
  base: string;
  modelFile: string;
  shape: [number, number, number, number];
  /** Force a backend (benchmarking); default tries WebGPU then WASM. */
  backend?: 'webgpu' | 'wasm';
}

let ortPromise: Promise<typeof Ort> | null = null;

async function loadOrt(base: string): Promise<typeof Ort> {
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

export async function loadModel(opts: LoadOptions): Promise<LoadedModel> {
  const ort = await loadOrt(opts.base);
  const res = await fetch(`${opts.base}models/${opts.modelFile}`);
  if (!res.ok) throw new Error(`model fetch failed: ${res.status}`);
  const bytes = new Uint8Array(await res.arrayBuffer());

  const tryBackends: ('webgpu' | 'wasm')[] = opts.backend ? [opts.backend] : ['webgpu', 'wasm'];
  let lastErr: unknown = null;
  for (const backend of tryBackends) {
    try {
      if (backend === 'webgpu') {
        const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
        if (!gpu) throw new Error('WebGPU unavailable');
        const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
        if (!adapter) throw new Error('No WebGPU adapter');
      }
      const session = await ort.InferenceSession.create(bytes, {
        executionProviders: [backend],
        graphOptimizationLevel: 'all',
      });
      const inName = session.inputNames[0];
      const outName = session.outputNames[0];
      const run: RunModel = async (input) => {
        const tensor = new ort.Tensor('float32', input, opts.shape);
        const out = await session.run({ [inName]: tensor });
        const t = out[outName];
        const data = (await t.getData()) as Float32Array;
        return data;
      };
      // warm-up compiles shaders so the first real tile isn't slow
      await run(new Float32Array(opts.shape.reduce((a, b) => a * b, 1)));
      return { run, backend, release: () => session.release() };
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}
