// Downloads the speech-recognition model used by the profanity filter (Whisper with
// cross-attention outputs for word timestamps, ONNX export by onnx-community) into models/.
//   node scripts/fetch-asr-model.mjs            → the model the extension uses
//   node scripts/fetch-asr-model.mjs --all      → also the other sizes (for benchmarking)
import { createWriteStream, existsSync, mkdirSync, statSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { ASR_MODELS, ASR_DEFAULT } from './asr-models.mjs';

const HF = 'https://huggingface.co';
const names = process.argv.includes('--all') ? Object.keys(ASR_MODELS) : [process.argv[2] && !process.argv[2].startsWith('-') ? process.argv[2] : ASR_DEFAULT];

for (const name of names) {
  const m = ASR_MODELS[name];
  if (!m) throw new Error(`unknown model ${name}; known: ${Object.keys(ASR_MODELS).join(', ')}`);
  for (const f of m.files) {
    const out = `models/${name}/${f}`;
    if (existsSync(out) && statSync(out).size > 0) continue;
    mkdirSync(dirname(out), { recursive: true });
    const url = `${HF}/${m.repo}/resolve/${m.revision}/${f}`;
    process.stdout.write(`${url} … `);
    const res = await fetch(url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status} for ${url}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(`${out}.part`));
    renameSync(`${out}.part`, out);
    console.log(`${(statSync(out).size / 1e6).toFixed(1)} MB`);
  }
  console.log(`✓ models/${name}`);
}
