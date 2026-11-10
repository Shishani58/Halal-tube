// Calibration on real photos: NudeNet group scores + face boxes, then the gender classifier on
// each face crop. Usage: npx tsx tests/vision-calib.node.ts <dir of 640×640 letterboxed .rgba>
import * as ort from 'onnxruntime-node';
import { readFileSync, readdirSync } from 'node:fs';
import { GENDER_CROPS, GENDER_INPUT, detectFaces, faceCrop, femaleProb, rgbaToChw, rgbaToGenderInput, scoreFrames } from '../src/core/nudenet';

const dir = process.argv[2];
const HI = 640; // fixture resolution; detector input is a 2× downscale of it
const det = await ort.InferenceSession.create('models/nudenet-320n.onnx');
const gen = await ort.InferenceSession.create('models/genderage.onnx');

function resize(src: Uint8Array, sw: number, sx: number, sy: number, side: number, n: number): Uint8Array {
  const out = new Uint8Array(n * n * 4);
  for (let y = 0; y < n; y++)
    for (let x = 0; x < n; x++) {
      const fx = Math.min(sw - 1, Math.max(0, sx + ((x + 0.5) * side) / n - 0.5));
      const fy = Math.min(sw - 1, Math.max(0, sy + ((y + 0.5) * side) / n - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(sw - 1, x0 + 1), y1 = Math.min(sw - 1, y0 + 1);
      const ax = fx - x0, ay = fy - y0;
      for (let c = 0; c < 4; c++) {
        const p = (yy: number, xx: number) => src[(yy * sw + xx) * 4 + c];
        out[(y * n + x) * 4 + c] = (p(y0, x0) * (1 - ax) + p(y0, x1) * ax) * (1 - ay) + (p(y1, x0) * (1 - ax) + p(y1, x1) * ax) * ay;
      }
    }
  return out;
}

for (const f of readdirSync(dir).sort()) {
  const hi = new Uint8Array(readFileSync(`${dir}/${f}`));
  const lo = resize(hi, HI, 0, 0, HI, 320);
  const chw = new Float32Array(3 * 320 * 320);
  rgbaToChw(lo, 320, chw);
  const o = (await det.run({ images: new ort.Tensor('float32', chw, [1, 3, 320, 320]) })).output0.data as Float32Array;
  const sc = scoreFrames(o, 1)[0];
  const faces = detectFaces(o, 1, 0);
  const probs: string[] = [];
  for (const b of faces) {
    const n = GENDER_CROPS.length;
    const inp = new Float32Array(n * 3 * GENDER_INPUT * GENDER_INPUT);
    GENDER_CROPS.forEach((cr, i) => {
      const c = faceCrop(b, cr);
      rgbaToGenderInput(resize(hi, HI, c.x * 2, c.y * 2, c.side * 2, GENDER_INPUT), GENDER_INPUT, inp, i * 3 * GENDER_INPUT * GENDER_INPUT);
    });
    const g = (await gen.run({ data: new ort.Tensor('float32', inp, [n, 3, GENDER_INPUT, GENDER_INPUT]) })).fc1.data as Float32Array;
    probs.push(`${femaleProb(g, 0, n).toFixed(2)}(age ${Math.round(g[2] * 100)})`);
  }
  console.log(f.slice(0, 32).padEnd(33), `nude=${sc.nude.toFixed(2)} skin=${sc.skin.toFixed(2)} faces=${faces.length} P(woman)=[${probs.join(' ')}]`);
}
