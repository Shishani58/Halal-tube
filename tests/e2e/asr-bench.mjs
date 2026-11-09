// Speech recognition benchmark for the profanity filter: per-tile ASR time on WebGPU and
// detection of the swear words in the profanity fixture, for each downloaded Whisper size.
// Prereqs: node tests/e2e/make-profanity-media.mjs; ASR_BENCH=1 npm run build (npm run bench:asr does both builds)
//   node tests/e2e/asr-bench.mjs [model ...]
import { chromium } from 'playwright';
import { existsSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const dist = resolve(process.env.DIST ?? 'dist');
const all = ['whisper-tiny_timestamped', 'whisper-base_timestamped', 'whisper-small_timestamped'];
const models = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const list = (models.length ? models : all).filter((m) => existsSync(`${dist}/models/${m}/config.json`));
const truth = JSON.parse(readFileSync('/tmp/mr/prof/truth.json', 'utf8'));
const b64 = (f) => readFileSync(f).toString('base64');
const inputs = { speech: b64('/tmp/mr/prof/speech16k.f32'), mix: b64('/tmp/mr/prof/mix16k.f32') };

const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--enable-unsafe-webgpu'],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;
const page = await ctx.newPage();
page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
page.on('pageerror', (e) => console.log('pageerror:', e.message));
await page.goto(`chrome-extension://${id}/bench/asr.html`);
await page.waitForFunction(() => window.__asr, null, { timeout: 30000 });

const TILE = 253440 / 44100;
const summary = [];
for (const m of list) {
  const { loadMs } = await page.evaluate((n) => window.__asr.load(n), m);
  for (const [label, audio] of Object.entries(inputs)) {
    const res = await page.evaluate(([a, l]) => window.__asr.run(a, l, l === 'speech'), [audio, label]);
    const times = res.slice(1).map((r) => r.detectMs + r.transcribeMs); // first call includes shader compile
    const hits = res.flatMap((r) => r.hits);
    // a profane word counts as found if some hit overlaps it; timing error = |hit edge − truth edge|
    let found = 0;
    const errs = [];
    const signed = [];
    for (const p of truth.profane) {
      const h = hits.filter((x) => x.end > p.start - 0.1 && x.start < p.end + 0.1);
      if (!h.length) {
        console.log(`  [${m}/${label}] MISSED "${p.text}" at ${p.start}`);
        continue;
      }
      found++;
      const s = Math.min(...h.map((x) => x.start));
      const e = Math.max(...h.map((x) => x.end));
      errs.push(Math.abs(s - p.start), Math.abs(e - p.end));
      signed.push([s - p.start, e - p.end]);
    }
    const fp = hits.filter((x) => !truth.profane.some((p) => x.end > p.start - 0.1 && x.start < p.end + 0.1));
    for (const x of fp) console.log(`  [${m}/${label}] FALSE "${x.text}" at ${x.start.toFixed(2)}`);
    const avg = times.reduce((a, b) => a + b, 0) / times.length;
    summary.push({
      model: m.replace('_timestamped', ''),
      input: label,
      loadS: (loadMs / 1000).toFixed(1),
      msPerTile: avg.toFixed(0),
      detectMs: (res.slice(1).reduce((a, r) => a + r.detectMs, 0) / (res.length - 1)).toFixed(0),
      maxMs: Math.max(...times).toFixed(0),
      'tileRTF': (avg / 1000 / TILE).toFixed(2),
      found: `${found}/${truth.profane.length}`,
      falsePos: fp.length,
      edgeErrMs: errs.length ? ((errs.reduce((a, b) => a + b, 0) / errs.length) * 1000).toFixed(0) : '-',
      maxEdgeErrMs: errs.length ? (Math.max(...errs) * 1000).toFixed(0) : '-',
      // signed: start error (− = early), end error (+ = late), per word
      signedMs: signed.map(([a, b]) => `${(a * 1000).toFixed(0)}/${(b * 1000).toFixed(0)}`).join(' '),
    });
    for (const r of res) console.log(`  [${m}/${label}] tile ${r.k} ${r.lang} p=${r.langProb.toFixed(2)} ×${r.passes} ${(r.detectMs + r.transcribeMs).toFixed(0)} ms | ${r.text.trim()}`);
  }
}
console.table(summary);
await ctx.close();
