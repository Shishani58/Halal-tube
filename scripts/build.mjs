// Bundles the extension into dist/ (load it in chrome://extensions → "Load unpacked").
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIcons } from './icons.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const test = process.argv.includes('--test');
const dist = join(root, test ? 'dist-test' : 'dist');
const watch = process.argv.includes('--watch');

const MODELS = ['Kim_Vocal_2.onnx', 'nudenet-320n.onnx', 'genderage.onnx'];
const ORT_FILES = ['ort.webgpu.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];

function copyStatic() {
  cpSync(join(root, 'static'), dist, { recursive: true });
  mkdirSync(join(dist, 'ort'), { recursive: true });
  for (const f of ORT_FILES) copyFileSync(join(root, 'node_modules/onnxruntime-web/dist', f), join(dist, 'ort', f));
  mkdirSync(join(dist, 'models'), { recursive: true });
  for (const name of MODELS) {
    const model = join(root, 'models', name);
    if (!existsSync(model)) {
      console.error(`\n✗ ${name} not found. Run: npm run fetch-model\n`);
      process.exit(1);
    }
    const target = join(dist, 'models', name);
    if (!existsSync(target) || statSync(target).size !== statSync(model).size) copyFileSync(model, target);
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
  { entryPoints: { background: 'src/background.ts', 'processor/offscreen': 'src/processor/offscreen.ts', 'processor/worker': 'src/processor/worker.ts', 'processor/vision-worker': 'src/processor/vision-worker.ts', 'popup/popup': 'src/popup/popup.ts', 'bench/bench': 'src/bench/bench.ts' }, format: 'esm' },
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
