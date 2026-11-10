/**
 * Makes static/selftest.json: for each model that runs on WebGPU, samples of its output on a fixed
 * pseudo-random input, computed on the CPU (onnxruntime-node, the fp32 file). Run it when a model
 * file changes: npm run make-selftest. See src/core/selftest.ts.
 */
import { writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { KIM_VOCAL_2, MdxProcessor } from '../src/core/mdx';
import { NUDENET_BATCH, NUDENET_INPUT } from '../src/core/nudenet';
import { CLIP_INPUT, CLIP_VIEWS } from '../src/core/clip';
import { sampleOutput, testAudio, testInput, type SelfTestRef } from '../src/core/selftest';

const ort = createRequire(import.meta.url)('onnxruntime-node') as typeof import('onnxruntime-node');

const mdx = new MdxProcessor(KIM_VOCAL_2);
const models: Record<string, { shape: number[]; seed: number; range: [number, number]; kind?: 'audio' }> = {
  'Kim_Vocal_2.onnx': { shape: [...mdx.tensorShape], seed: 20240601, range: [0, 0], kind: 'audio' },
  'nudenet-320n.onnx': { shape: [NUDENET_BATCH, 3, NUDENET_INPUT, NUDENET_INPUT], seed: 20240602, range: [0, 1] },
  'mobileclip-s0-vision.onnx': { shape: [CLIP_VIEWS, 3, CLIP_INPUT, CLIP_INPUT], seed: 20240603, range: [-2, 2] },
};

const out: Record<string, SelfTestRef> = {};
for (const [file, m] of Object.entries(models)) {
  const t0 = Date.now();
  const session = await ort.InferenceSession.create(`models/${file}`, { executionProviders: ['cpu'] });
  const input = m.kind === 'audio' ? mdx.stft(...testAudio(mdx.chunkSize, 44100, m.seed)) : testInput(m.shape, m.seed, m.range);
  const res = await session.run({ [session.inputNames[0]]: new ort.Tensor('float32', input, m.shape) });
  const data = res[session.outputNames[0]].data as Float32Array;
  const ref = sampleOutput(data).map((v) => Math.round(v * 1e6) / 1e6);
  out[file] = { shape: m.shape, seed: m.seed, range: m.range, ref, ...(m.kind ? { kind: m.kind } : {}) };
  console.log(`${file}: output ${data.length} values, ${ref.length} samples, ${((Date.now() - t0) / 1000).toFixed(1)} s`);
  await session.release();
}
writeFileSync('static/selftest.json', JSON.stringify(out));
console.log('wrote static/selftest.json');
