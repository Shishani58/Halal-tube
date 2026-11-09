// Downloads the vocal-separation model (UVR MDX-Net "Kim Vocal 2", ~64 MB) into models/.
import { createWriteStream, existsSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const NAME = 'Kim_Vocal_2.onnx';
const URL_ = `https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/${NAME}`;
const EXPECTED = 66759214;
const out = `models/${NAME}`;

mkdirSync('models', { recursive: true });
if (existsSync(out) && statSync(out).size === EXPECTED) {
  console.log(`✓ ${out} already present`);
  process.exit(0);
}
console.log(`Downloading ${URL_} …`);
const res = await fetch(URL_);
if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
await pipeline(Readable.fromWeb(res.body), createWriteStream(`${out}.part`));
const size = statSync(`${out}.part`).size;
if (size !== EXPECTED) throw new Error(`unexpected size ${size}`);
renameSync(`${out}.part`, out);
console.log(`✓ saved ${out} (${(size / 1e6).toFixed(1)} MB)`);
