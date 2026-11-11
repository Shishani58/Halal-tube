// Bundles the extension into dist/ (load it in chrome://extensions → "Load unpacked").
import * as esbuild from 'esbuild';
import { cpSync, existsSync, mkdirSync, rmSync, copyFileSync, statSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeIcons } from './icons.mjs';
import { ASR_DEFAULT, ASR_MODELS } from './asr-models.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const test = process.argv.includes('--test');
/** iPhone Safari build -> dist-safari/ (see docs/safari.md). */
const safari = process.argv.includes('--safari');
const dist = join(root, safari ? 'dist-safari' : test ? 'dist-test' : 'dist');
const watch = process.argv.includes('--watch');

const MODELS = ['Kim_Vocal_2.onnx', 'nudenet-320n.onnx', 'mobileclip-s0-vision.onnx'];
/**
 * The face gender classifier ships as models/gender.onnx in the build. Default: InsightFace genderage
 * (non-commercial weights). GENDER_MODEL=fairface: our own model trained on FairFace only (CC BY 4.0),
 * models/gender-fairface.onnx (scripts/gender/). Same input and output, so nothing else changes.
 */
const GENDER_SOURCE = process.env.GENDER_MODEL === 'fairface' ? 'gender-fairface.onnx' : 'genderage.onnx';
/** Faster fp16 variants, used when the GPU supports them (made by npm run fetch-model; optional). */
const OPTIONAL_MODELS = ['Kim_Vocal_2.fp16.onnx'];
const ORT_FILES = ['ort.webgpu.min.mjs', 'ort-wasm-simd-threaded.asyncify.mjs', 'ort-wasm-simd-threaded.asyncify.wasm'];

/** Safari (iPhone) has no offscreen documents and runs a non-persistent background script; the processor runs in an iframe of the video page. */
function adaptManifestForSafari() {
  const mf = join(dist, 'manifest.json');
  const m = JSON.parse(readFileSync(mf, 'utf8'));
  delete m.minimum_chrome_version;
  delete m.commands; // no keyboard on a phone
  m.name = 'Халал Туб';
  m.short_name = 'Халал Туб';
  m.permissions = m.permissions.filter((p) => p !== 'offscreen');
  m.background = { scripts: ['background.js'], persistent: false };
  m.web_accessible_resources = [{ resources: ['processor/offscreen.html'], matches: m.content_scripts[0].matches }];
  writeFileSync(mf, JSON.stringify(m, null, 2));
  rmSync(join(dist, 'bench'), { recursive: true, force: true });
  // the popup gets its own iPhone layout and look (same element ids, so src/popup/popup.ts is shared)
  cpSync(join(root, 'static/popup-ios'), join(dist, 'popup'), { recursive: true, force: true });
}

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
  {
    const src = join(root, 'models', GENDER_SOURCE);
    if (!existsSync(src)) {
      console.error(`\n✗ ${GENDER_SOURCE} not found. Run: npm run fetch-model (genderage) or see scripts/gender/ (fairface)\n`);
      process.exit(1);
    }
    const target = join(dist, 'models', 'gender.onnx');
    if (!existsSync(target) || statSync(target).size !== statSync(src).size) copyFileSync(src, target);
    console.log(`gender model: ${GENDER_SOURCE}`);
  }
  for (const name of OPTIONAL_MODELS) {
    const model = join(root, 'models', name);
    const target = join(dist, 'models', name);
    if (!existsSync(model)) console.warn(`\n⚠ ${name} not found: the slower fp32 model will be used. Run: npm run fetch-model\n`);
    else if (!existsSync(target) || statSync(target).size !== statSync(model).size) copyFileSync(model, target);
  }
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
    for (const cs of m.content_scripts) cs.matches.push('http://localhost/*', ...(safari ? ['http://localhost:*/*'] : [])); // Safari takes the port into account
    writeFileSync(mf, JSON.stringify(m, null, 2));
  }
  if (safari) adaptManifestForSafari();
}

const common = {
  bundle: true,
  target: safari ? 'safari17' : 'chrome116',
  sourcemap: 'linked',
  minify: !watch,
  logLevel: 'info',
  legalComments: 'none',
  // identifies this build: findings kept by the vision worker under another build are not trusted
  define: { __BUILD_ID__: JSON.stringify(String(Date.now())), __SAFARI_DEBUG__: String(safari), __SAFARI__: String(safari) },
};

const builds = [
  { entryPoints: { 'content/main': 'src/content/main.ts', 'content/bridge': 'src/content/bridge.ts' }, format: 'iife' },
  // transformers.js (speech recognition), loaded by the worker only when the profanity filter is on;
  // it reuses the ONNX Runtime the worker already loaded (see src/processor/ort-shim.ts)
  {
    entryPoints: { 'processor/asr-lib': 'src/processor/asr-lib.ts' },
    format: 'esm',
    alias: { 'onnxruntime-web/webgpu': './src/processor/ort-shim.ts', 'onnxruntime-common': './src/processor/ort-shim.ts' },
  },
  // Safari's background script is not a module: bundle it as a classic script
  ...(safari ? [{ entryPoints: { background: 'src/background.ts' }, format: 'iife' }] : []),
  { entryPoints: { ...(safari ? {} : { background: 'src/background.ts' }), 'processor/offscreen': 'src/processor/offscreen.ts', 'processor/worker': 'src/processor/worker.ts', 'processor/vision-worker': 'src/processor/vision-worker.ts', 'processor/clip-worker': 'src/processor/clip-worker.ts', 'popup/popup': 'src/popup/popup.ts', ...(safari ? {} : { 'bench/bench': 'src/bench/bench.ts', 'bench/asr-bench': 'src/bench/asr-bench.ts' }) }, format: 'esm' },
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
