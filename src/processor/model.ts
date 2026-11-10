import type * as Ort from 'onnxruntime-web';
import type { RunModel } from '../core/tiles';
import { compareSamples, sampleOutput, testInput, type SelfTestRef } from '../core/selftest';

export interface LoadedModel {
  run: RunModel;
  backend: string;
  /** The half-precision variant of the model was loaded. */
  fp16: boolean;
  /**
   * WebGPU self-test (core/selftest.ts): 'passed' · 'skipped' (no reference for this model, or not
   * on the GPU) · 'fell back' (the GPU computed wrong numbers: this is the next variant or the CPU).
   */
  selfTest: 'passed' | 'skipped' | 'fell back';
  /** Error of the self-test run, share of the reference (set when it ran). */
  selfTestErr?: number;
  /** Milliseconds spent per loading phase: ort (runtime import), adapter, fetch, create (session), warm (first run, shaders + self-test). */
  timings?: Record<string, number>;
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
  /** Builds the self-test input of a model whose reference is made from a real-looking signal (SelfTestRef.kind 'audio'). */
  selfTestInput?: (ref: SelfTestRef) => Float32Array;
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

let refs: Promise<Record<string, SelfTestRef>> | null = null;

/** The CPU reference outputs shipped with the extension (empty when missing: the test is skipped). */
function loadRefs(base: string): Promise<Record<string, SelfTestRef>> {
  refs ??= fetch(`${base}selftest.json`)
    .then((r) => (r.ok ? (r.json() as Promise<Record<string, SelfTestRef>>) : {}))
    .catch(() => ({}));
  return refs;
}

/** Milliseconds of the last fetchModel: until the response started, and to read its body. */
const fetchMs = { head: 0, body: 0 };

async function fetchModel(base: string, file: string): Promise<Uint8Array | null> {
  const t0 = performance.now();
  const res = await fetch(`${base}models/${file}`).catch(() => null);
  const t1 = performance.now();
  const bytes = res?.ok ? new Uint8Array(await res.arrayBuffer()) : null;
  fetchMs.head = Math.round(t1 - t0);
  fetchMs.body = Math.round(performance.now() - t1);
  return bytes;
}

export async function loadModel(opts: LoadOptions): Promise<LoadedModel> {
  const timings: Record<string, number> = {};
  let mark = performance.now();
  const lap = (k: string) => {
    const now = performance.now();
    timings[k] = Math.round((timings[k] ?? 0) + now - mark);
    mark = now;
  };
  const ort = await loadOrt(opts.base);
  const ref = (await loadRefs(opts.base))[opts.modelFile];
  lap('ort');
  let fp32: Uint8Array | null = null;
  const tryBackends: ('webgpu' | 'wasm')[] = opts.backend ? [opts.backend] : ['webgpu', 'wasm'];
  let lastErr: unknown = null;
  let fellBack = false;
  for (const backend of tryBackends) {
    // WebGPU: the fp16 variant first (faster), then fp32; the next one when a variant computes wrong numbers
    const variants: boolean[] = [false];
    try {
      if (backend === 'webgpu') {
        const gpu = (navigator as Navigator & { gpu?: GPU }).gpu;
        if (!gpu) throw new Error('WebGPU unavailable');
        const adapter = await gpu.requestAdapter({ powerPreference: 'high-performance' });
        lap('adapter');
        if (!adapter) throw new Error('No WebGPU adapter');
        // fp16 weights: half the download, ~25% faster on the GPU, same output to −45 dB
        if (opts.fp16File && adapter.features.has('shader-f16')) variants.unshift(true);
      }
    } catch (e) {
      lastErr = e;
      continue;
    }
    for (const wantFp16 of variants) {
      try {
        let bytes: Uint8Array | null = null;
        let fp16 = false;
        if (wantFp16) {
          bytes = await fetchModel(opts.base, opts.fp16File!);
          fp16 = !!bytes;
        }
        if (!bytes) {
          fp32 ??= await fetchModel(opts.base, opts.modelFile);
          if (!fp32) throw new Error(`model fetch failed: ${opts.modelFile}`);
          bytes = fp32;
        }
        lap('fetch');
        timings.fetchHead = fetchMs.head;
        timings.fetchBody = fetchMs.body;
        const session = await ort.InferenceSession.create(bytes, {
          executionProviders: [backend],
          graphOptimizationLevel: 'all',
        });
        lap('create');
        const inName = session.inputNames[0];
        const outName = session.outputNames[0];
        const run: RunModel = async (input, shape = opts.shape) => {
          const tensor = new ort.Tensor('float32', input.length === size(shape) ? input : input.subarray(0, size(shape)), shape);
          const out = await session.run({ [inName]: tensor });
          const t = out[outName];
          const data = (await t.getData()) as Float32Array;
          return data;
        };
        // The warm-up (compiles shaders so the first real tile isn't slow) is also the self-test: on
        // the GPU it runs the reference input and the result must match the CPU's.
        let test = backend === 'webgpu' && ref && ref.shape.join() === opts.shape.join() ? ref : null;
        const input = test ? (test.kind === 'audio' ? opts.selfTestInput?.(test) : testInput(test.shape, test.seed, test.range)) : undefined;
        if (test && !input) test = null; // the caller can't build this model's input: no test
        let selfErr = 0;
        mark = performance.now();
        const out = await run(input ?? new Float32Array(size(opts.shape)));
        if (test) {
          const r = compareSamples(sampleOutput(out, test.ref.length), test.ref);
          selfErr = r.err;
          if (!r.ok) {
            console.warn(`[music-remover] WebGPU self-test failed for ${fp16 ? opts.fp16File : opts.modelFile}: ${r.why}; using ${fp16 ? 'the fp32 model' : 'the CPU'} instead`);
            await session.release().catch(() => undefined);
            fellBack = true;
            lastErr = new Error(`WebGPU computes wrong results (${r.why})`);
            continue;
          }
        }
        if (test) console.debug(`[music-remover] WebGPU self-test passed for ${fp16 ? opts.fp16File : opts.modelFile}: error ${(selfErr * 100).toFixed(3)} % of the reference`);
        return { run, backend, fp16, selfTest: test ? 'passed' : fellBack ? 'fell back' : 'skipped', selfTestErr: test ? selfErr : undefined, timings: (lap('warm'), timings), release: () => session.release() };
      } catch (e) {
        lastErr = e;
      }
    }
  }
  throw lastErr instanceof Error ? lastErr : new Error(String(lastErr));
}

/** One-line result of the self-test, for status displays. */
export function describeSelfTest(m: Pick<LoadedModel, 'selfTest' | 'selfTestErr'>): string {
  return m.selfTestErr === undefined ? m.selfTest : `${m.selfTest} (${(m.selfTestErr * 100).toFixed(3)} %)`;
}

const size = (shape: readonly number[]) => shape.reduce((a, b) => a * b, 1);
