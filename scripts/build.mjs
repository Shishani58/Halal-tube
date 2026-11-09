// Bundles the extension into dist/ (load it in chrome://extensions → "Load unpacked").
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIcons } from './icons.mjs';
import { ASR_DEFAULT, ASR_MODELS } from './asr-models.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const test = process.argv.includes('--test');
const dist = join(root, test ? 'dist-test' : 'dist');
const watch = process.argv.includes('--watch');

const MODEL = 'Kim_Vocal_2.onnx';
const ORT_FILES = ['ort.webgpu.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];

function copyStatic() {
  cpSync(join(root, 'static'), dist, { recursive: true });
  mkdirSync(join(dist, 'ort'), { recursive: true });
  for (const f of ORT_FILES) copyFileSync(join(root, 'node_modules/onnxruntime-web/dist', f), join(dist, 'ort', f));
  const model = join(root, 'models', MODEL);
  if (!existsSync(model)) {
    console.error(`\n✗ ${MODEL} not found. Run: npm run fetch-model\n`);
    process.exit(1);
  }
  mkdirSync(join(dist, 'models'), { recursive: true });
  const target = join(dist, 'models', MODEL);
  if (!existsSync(target) || statSync(target).size !== statSync(model).size) copyFileSync(model, target);
  // speech recognition for the profanity filter (optional: without it the filter reports an error)
  // ASR_BENCH=1 also ships the other downloaded sizes, for the benchmark page.
  const asrNames = process.env.ASR_BENCH ? Object.keys(ASR_MODELS) : [ASR_DEFAULT];
  for (const name of asrNames) {
    const src = join(root, 'models', name);
    const missing = ASR_MODELS[name].files.filter((f) => !existsSync(join(src, f)));
    if (missing.length) {
      if (name === ASR_DEFAULT) console.warn(`\n⚠ ${name} not found: the profanity filter will not work. Run: npm run fetch-asr-model\n`);
      continue;
    }
    for (const f of ASR_MODELS[name].files) {
      const target = join(dist, 'models', name, f);
      mkdirSync(dirname(target), { recursive: true });
      if (!existsSync(target) || statSync(target).size !== statSync(join(src, f)).size) copyFileSync(join(src, f), target);
    }
  }
  makeIcons(join(dist, 'icons'));
  if (test) {
    // test build: also run on the local MSE test page
    const mf = join(dist, 'manifest.json');
    const m = JSON.parse(readFileSync(mf, 'utf8'));
    for (const cs of m.content_scripts) cs.matches.push('http://localhost/*');
    writeFileSync(mf, JSON.stringify(m, null, 2));
  }
}

const common = {
  bundle: true,
  target: 'chrome116',
  sourcemap: 'linked',
  minify: !watch,
  logLevel: 'info',
  legalComments: 'none',
};

const builds = [
  { entryPoints: { 'content/main': 'src/content/main.ts', 'content/bridge': 'src/content/bridge.ts', }, format: 'iife' },
  // transformers.js (speech recognition), loaded by the worker only when the profanity filter is on;
  // it reuses the ONNX Runtime the worker already loaded (see src/processor/ort-shim.ts)
  {
    entryPoints: { 'processor/asr-lib': 'src/processor/asr-lib.ts' },
    format: 'esm',
    alias: { 'onnxruntime-web/webgpu': './src/processor/ort-shim.ts', 'onnxruntime-common': './src/processor/ort-shim.ts' },
  },
  { entryPoints: { background: 'src/background.ts', 'processor/offscreen': 'src/processor/offscreen.ts', 'processor/worker': 'src/processor/worker.ts', 'popup/popup': 'src/popup/popup.ts', 'bench/bench': 'src/bench/bench.ts', 'bench/asr-bench': 'src/bench/asr-bench.ts' }, format: 'esm' },
];

if (!watch) rmSync(dist, { recursive: true, force: true });
mkdirSync(dist, { recursive: true });
copyStatic();

for (const b of builds) {
  const opts = { ...common, ...b, outdir: dist, absWorkingDir: root };
  if (watch) {
    const ctx = await esbuild.context(opts);
    await ctx.watch();
  } else {
    await esbuild.build(opts);
  }
}
if (!watch) console.log(`\n✓ Built to ${dist}`);
