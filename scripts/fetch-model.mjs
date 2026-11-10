// Downloads the models into models/:
//  • UVR MDX-Net "Kim Vocal 2" (~64 MB): voice / music separation;
//  • NudeNet v3 320n (~12 MB, YOLOv8n): nudity + face detector for blurring
//    (from the official PyPI wheel: the GitHub release asset now requires signing in);
//  • InsightFace genderage (~1.3 MB, 96×96): man / woman classifier for detected faces
//    (from the official buffalo_l release);
//  • MobileCLIP-S0 image encoder (~45 MB, 256×256, Apple, via Xenova's ONNX export): are there
//    women in the frame at all, for figures the face pipeline can't see.
// Kim Vocal 2 is also converted to fp16 (models/Kim_Vocal_2.fp16.onnx, ~33 MB; scripts/make-fp16.py
// in a Python venv under node_modules/.cache): on GPUs with shader-f16 it runs ~25% faster. Without
// Python the extension uses the fp32 model everywhere.
// Files inside zip archives are fetched with HTTP Range requests: only the central directory
// and the one entry are downloaded, not the whole archive.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, renameSync, writeFileSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { inflateRawSync } from 'node:zlib';

const MODELS = [
  {
    name: 'Kim_Vocal_2.onnx',
    url: 'https://github.com/TRvlvr/model_repo/releases/download/all_public_uvr_models/Kim_Vocal_2.onnx',
    size: 66759214,
  },
  {
    name: 'nudenet-320n.onnx',
    url: 'https://files.pythonhosted.org/packages/1c/ee/1aa02d44ba958cc77e16ff1e41a0aac5e721037db7bf62b9c9d124917f87/nudenet-3.4.2-py3-none-any.whl',
    zipEntry: 'nudenet/320n.onnx',
    size: 12150158,
    sha256: 'c15d8273adad2d0a92f014cc69ab2d6c311a06777a55545f2c4eb46f51911f0f',
  },
  {
    name: 'genderage.onnx',
    url: 'https://github.com/deepinsight/insightface/releases/download/v0.7/buffalo_l.zip',
    zipEntry: 'genderage.onnx',
    size: 1322532,
    sha256: '4fde69b1c810857b88c64a335084f1c3fe8f01246c9a191b48c7bb756d6652fb',
  },
  {
    // image encoder only; the prompt embeddings are in src/core/clip-text.ts (scripts/make-clip-text.mjs)
    name: 'mobileclip-s0-vision.onnx',
    url: 'https://huggingface.co/Xenova/mobileclip_s0/resolve/main/onnx/vision_model.onnx',
    size: 45543630,
    sha256: '17d3c037b1d488c10c50e09f6009ea5a198caef4e0e8f4ea5617b7cb2d067ac0',
  },
];

async function range(url, from, to) {
  const res = await fetch(url, { headers: { Range: `bytes=${from}-${to}` } });
  if (res.status !== 206) throw new Error(`Range request not honoured (HTTP ${res.status})`);
  return Buffer.from(await res.arrayBuffer());
}

/** One file out of a remote zip, fetching only its central directory and the entry. */
async function remoteZipEntry(url, name) {
  const head = await fetch(url, { method: 'HEAD' });
  const total = Number(head.headers.get('content-length'));
  if (!head.ok || !total) throw new Error(`HEAD ${url}: HTTP ${head.status}`);
  const tail = await range(url, Math.max(0, total - 65557), total - 1);
  let eocd = tail.length - 22;
  while (eocd >= 0 && tail.readUInt32LE(eocd) !== 0x06054b50) eocd--;
  if (eocd < 0) throw new Error('zip end record not found');
  const cdSize = tail.readUInt32LE(eocd + 12);
  const cdOff = tail.readUInt32LE(eocd + 16);
  const cd = await range(url, cdOff, cdOff + cdSize - 1);
  for (let p = 0; p + 46 <= cd.length; ) {
    const method = cd.readUInt16LE(p + 10);
    const csize = cd.readUInt32LE(p + 20);
    const nlen = cd.readUInt16LE(p + 28), xlen = cd.readUInt16LE(p + 30), clen = cd.readUInt16LE(p + 32);
    const local = cd.readUInt32LE(p + 42);
    const entry = cd.toString('utf8', p + 46, p + 46 + nlen);
    if (entry === name || entry.endsWith(`/${name}`)) {
      const lh = await range(url, local, local + 29);
      const start = local + 30 + lh.readUInt16LE(26) + lh.readUInt16LE(28);
      const data = await range(url, start, start + csize - 1);
      return method === 0 ? data : inflateRawSync(data);
    }
    p += 46 + nlen + xlen + clen;
  }
  throw new Error(`${name} not found in ${url}`);
}

mkdirSync('models', { recursive: true });
for (const m of MODELS) {
  const out = `models/${m.name}`;
  if (existsSync(out) && statSync(out).size === m.size) {
    console.log(`✓ ${out} already present`);
    continue;
  }
  console.log(`Downloading ${m.zipEntry ? `${m.zipEntry} from ` : ''}${m.url} …`);
  if (m.zipEntry) {
    writeFileSync(`${out}.part`, await remoteZipEntry(m.url, m.zipEntry));
  } else {
    const res = await fetch(m.url);
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(`${out}.part`));
  }
  const size = statSync(`${out}.part`).size;
  if (size !== m.size) throw new Error(`${m.name}: unexpected size ${size}`);
  if (m.sha256) {
    const h = createHash('sha256').update(readFileSync(`${out}.part`)).digest('hex');
    if (h !== m.sha256) throw new Error(`${m.name}: checksum mismatch ${h}`);
  }
  renameSync(`${out}.part`, out);
  console.log(`✓ saved ${out} (${(size / 1e6).toFixed(1)} MB)`);
}

// fp16 variants (optional)
const FP16 = [['Kim_Vocal_2.onnx', 'Kim_Vocal_2.fp16.onnx']];
const venv = 'node_modules/.cache/onnx-venv';
const py = `${venv}/bin/python`;
for (const [src, dst] of FP16) {
  const out = `models/${dst}`;
  if (existsSync(out) && statSync(out).mtimeMs >= statSync(`models/${src}`).mtimeMs) {
    console.log(`✓ ${out} already present`);
    continue;
  }
  try {
    if (!existsSync(py)) {
      console.log(`Setting up ${venv} (onnx, onnxconverter-common) for the fp16 conversion …`);
      execFileSync('python3', ['-m', 'venv', venv], { stdio: 'inherit' });
      execFileSync(py, ['-m', 'pip', 'install', '-q', 'onnx', 'onnxconverter-common'], { stdio: 'inherit' });
    }
    execFileSync(py, ['-I', 'scripts/make-fp16.py', `models/${src}`, `${out}.part`], { stdio: ['ignore', 'inherit', 'ignore'] });
    renameSync(`${out}.part`, out);
    console.log(`✓ saved ${out} (${(statSync(out).size / 1e6).toFixed(1)} MB)`);
  } catch (e) {
    console.warn(`⚠ ${dst} not made (${e instanceof Error ? e.message.split('\n')[0] : e}): the fp32 model will be used everywhere.`);
  }
}
