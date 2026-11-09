/**
 * End-to-end separation check on synthetic speech + music using onnxruntime-node.
 * Run: npx tsx tests/separation.node.ts   (needs models/Kim_Vocal_2.onnx and /tmp/mr fixtures)
 */
import { readFileSync, writeFileSync } from 'node:fs';
import * as ort from 'onnxruntime-node';
import { KIM_VOCAL_2, MdxProcessor } from '../src/core/mdx';
import { Tiling, separateWindow } from '../src/core/tiles';

const mdx = new MdxProcessor(KIM_VOCAL_2);
const tiling = new Tiling(mdx);

function readStereo(path: string): [Float32Array, Float32Array] {
  const buf = readFileSync(path);
  const f = new Float32Array(buf.buffer, buf.byteOffset, buf.byteLength / 4);
  const n = f.length / 2;
  const l = new Float32Array(n), r = new Float32Array(n);
  for (let i = 0; i < n; i++) { l[i] = f[2 * i]; r[i] = f[2 * i + 1]; }
  return [l, r];
}

function writeWav(path: string, l: Float32Array, r: Float32Array, rate = 44100) {
  const n = l.length;
  const b = Buffer.alloc(44 + n * 4);
  b.write('RIFF', 0); b.writeUInt32LE(36 + n * 4, 4); b.write('WAVEfmt ', 8);
  b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(2, 22);
  b.writeUInt32LE(rate, 24); b.writeUInt32LE(rate * 4, 28); b.writeUInt16LE(4, 32); b.writeUInt16LE(16, 34);
  b.write('data', 36); b.writeUInt32LE(n * 4, 40);
  for (let i = 0; i < n; i++) {
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(l[i] * 32767))), 44 + i * 4);
    b.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(r[i] * 32767))), 46 + i * 4);
  }
  writeFileSync(path, b);
}

function sdr(ref: Float32Array, est: Float32Array): number {
  let s = 0, e = 0;
  for (let i = 0; i < ref.length; i++) { s += ref[i] ** 2; e += (ref[i] - est[i]) ** 2; }
  return 10 * Math.log10(s / Math.max(e, 1e-12));
}

const [sl, sr] = readStereo('/tmp/mr/speech.f32');
const [ml, mr] = readStereo('/tmp/mr/music.f32');
const n = sl.length;
const xl = new Float32Array(n), xr = new Float32Array(n);
for (let i = 0; i < n; i++) { xl[i] = sl[i] + ml[i]; xr[i] = sr[i] + mr[i]; }

const session = await ort.InferenceSession.create('models/Kim_Vocal_2.onnx');
console.log('inputs', session.inputNames, 'outputs', session.outputNames);
const inName = session.inputNames[0], outName = session.outputNames[0];
const run = async (spec: Float32Array) => {
  const res = await session.run({ [inName]: new ort.Tensor('float32', spec, mdx.tensorShape) });
  return res[outName].data as Float32Array;
};

const outL = new Float32Array(n), outR = new Float32Array(n);
const tiles = Math.ceil(n / tiling.genSize);
for (let k = 0; k < tiles; k++) {
  const start = k * tiling.genSize - tiling.trim;
  const wl = new Float32Array(tiling.chunkSize), wr = new Float32Array(tiling.chunkSize);
  for (let j = 0; j < tiling.chunkSize; j++) {
    const i = start + j;
    if (i >= 0 && i < n) { wl[j] = xl[i]; wr[j] = xr[i]; }
  }
  const t0 = performance.now();
  const [ol, or] = await separateWindow(mdx, run, wl, wr);
  console.log(`tile ${k}: ${(performance.now() - t0).toFixed(0)} ms for ${tiling.tileSeconds.toFixed(2)} s`);
  for (let j = 0; j < tiling.genSize && k * tiling.genSize + j < n; j++) {
    outL[k * tiling.genSize + j] = ol[j];
    outR[k * tiling.genSize + j] = or[j];
  }
}

console.log(`SDR(speech | mix)    = ${sdr(sl, xl).toFixed(2)} dB`);
console.log(`SDR(speech | output) = ${sdr(sl, outL).toFixed(2)} dB`);
// music leakage in the tail where speech is silent (last 2 s)
let musicE = 0, outE = 0;
for (let i = n - 2 * 44100; i < n; i++) { musicE += ml[i] ** 2; outE += outL[i] ** 2; }
console.log(`Music-only tail: residual ${(10 * Math.log10(outE / musicE)).toFixed(1)} dB relative to music`);
writeWav('/tmp/mr/mix.wav', xl, xr);
writeWav('/tmp/mr/vocals.wav', outL, outR);
