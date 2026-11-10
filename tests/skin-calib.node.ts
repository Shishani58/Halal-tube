// Calibration of the bare-torso ("skin") signal on ordinary photos: what NudeNet's MALE_BREAST_EXPOSED /
// BELLY_EXPOSED boxes look like next to the face boxes. Usage:
//   npx tsx tests/skin-calib.node.ts <dir of .jpg> [more dirs…]   (needs ffmpeg; each photo is
//   letterboxed to 320×320 top-left, as the extension does)
import * as ort from 'onnxruntime-node';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { GROUPS, NUDENET_INPUT, NUDENET_LABELS, detectBoxes, detectFaces, rgbaToChw, scoreFrames, type Box } from '../src/core/nudenet';

const det = await ort.InferenceSession.create('models/nudenet-320n.onnx');
const N = NUDENET_INPUT;

function load(path: string): { rgba: Uint8Array; dw: number; dh: number } {
  const dims = execFileSync('ffprobe', ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'csv=p=0', path]).toString().trim().split(',').map(Number);
  const s = N / Math.max(dims[0], dims[1]);
  const dw = Math.max(1, Math.round(dims[0] * s)), dh = Math.max(1, Math.round(dims[1] * s));
  const rgba = execFileSync('ffmpeg', ['-v', 'error', '-i', path, '-vf', `scale=${dw}:${dh}:flags=bilinear,pad=${N}:${N}:0:0:black,format=rgba`, '-f', 'rawvideo', '-'], { maxBuffer: 1 << 26 });
  return { rgba: new Uint8Array(rgba), dw, dh };
}

const f2 = (x: number) => x.toFixed(2);
const bx = (b: Box, dw: number, dh: number) => `[${f2(b.x / dw)},${f2(b.y / dh)} ${f2(b.w / dw)}×${f2(b.h / dh)} @${f2(b.score)}]`;

for (const dir of process.argv.slice(2)) {
  console.log(`== ${dir}`);
  for (const f of readdirSync(dir).filter((x) => /\.jpe?g$/i.test(x)).sort()) {
    const { rgba, dw, dh } = load(`${dir}/${f}`);
    const chw = new Float32Array(3 * N * N);
    rgbaToChw(rgba, N, chw);
    const o = (await det.run({ images: new ort.Tensor('float32', chw, [1, 3, N, N]) })).output0.data as Float32Array;
    const sc = scoreFrames(o, 1)[0];
    const faces = detectFaces(o, 1, 0);
    const skin = detectBoxes(o, 1, 0, GROUPS.skin, 0.25, 3);
    // explicit-nudity classes one by one: which class fires, and where
    const nudes = GROUPS.nude.flatMap((c) => detectBoxes(o, 1, 0, [c], 0.2, 2).map((b) => `${NUDENET_LABELS[c]}${bx(b, dw, dh)}`));
    console.log(
      f.padEnd(10),
      `nude=${f2(sc.nude)} skin=${f2(sc.skin)}`,
      `faces=${faces.map((b) => bx(b, dw, dh)).join('')}`,
      nudes.length ? `nudeBoxes=${nudes.join(' ')}` : '',
      skin.length ? `skinBoxes=${skin.map((b) => bx(b, dw, dh)).join('')}` : '',
    );
  }
}
