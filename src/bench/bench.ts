/** Diagnostics page: measures how fast this computer separates audio. */
import { KIM_VOCAL_2, MdxProcessor } from '../core/mdx';
import { loadModel } from '../processor/model';

const out = document.getElementById('out')!;
const log = (s: string) => {
  out.textContent += s + '\n';
};

async function bench(backend: 'webgpu' | 'wasm', iters: number) {
  const mdx = new MdxProcessor(KIM_VOCAL_2);
  const base = new URL('../', location.href).href;
  log(`\n[${backend}] loading model…`);
  const t0 = performance.now();
  const model = await loadModel({ base, modelFile: 'Kim_Vocal_2.onnx', shape: mdx.tensorShape, backend });
  log(`[${backend}] loaded + warm-up in ${((performance.now() - t0) / 1000).toFixed(1)} s`);
  const L = new Float32Array(mdx.chunkSize).map(() => (Math.random() - 0.5) * 0.2);
  const R = new Float32Array(mdx.chunkSize).map(() => (Math.random() - 0.5) * 0.2);
  const times: number[] = [];
  for (let i = 0; i < iters; i++) {
    const a = performance.now();
    const spec = mdx.stft(L, R);
    const b = performance.now();
    const pred = await model.run(spec);
    const c = performance.now();
    mdx.istftTrimmed(pred);
    const d = performance.now();
    times.push(d - a);
    log(`[${backend}] window ${i + 1}: stft ${(b - a).toFixed(0)} ms, model ${(c - b).toFixed(0)} ms, istft ${(d - c).toFixed(0)} ms`);
  }
  const avg = times.slice(1).reduce((x, y) => x + y, 0) / Math.max(1, times.length - 1);
  const audio = (mdx.genSize / 44100) * 1000;
  const speed = audio / avg;
  log(`[${backend}] average ${avg.toFixed(0)} ms per ${(audio / 1000).toFixed(2)} s of audio → ${speed.toFixed(1)}× real time`);
  return { backend: model.backend, avgMs: avg, speed };
}

const params = new URLSearchParams(location.search);
const backends = (params.get('backends') ?? 'webgpu').split(',') as ('webgpu' | 'wasm')[];
const iters = Number(params.get('iters') ?? 4);
const results: unknown[] = [];
(async () => {
  log(`WebGPU available: ${'gpu' in navigator}`);
  for (const b of backends) {
    try {
      results.push(await bench(b, iters));
    } catch (e) {
      log(`[${b}] failed: ${e instanceof Error ? e.message : String(e)}`);
      results.push({ backend: b, error: String(e) });
    }
  }
  (window as unknown as { __bench: unknown }).__bench = results;
  log('\ndone');
})();
