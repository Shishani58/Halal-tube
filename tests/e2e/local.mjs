// Full pipeline test against a local YouTube-like MSE player with known ground truth.
// Prereqs: npm run build:test, tests/e2e/make-media.sh
// Measures: time to first clean audio, separation SDR vs. the true voice track,
// timeline alignment (lag), drift, recovery after seek.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
mkdirSync('/tmp/mr/e2e', { recursive: true });
import { resolve, extname } from 'node:path';

const headed = process.argv.includes('--headed');
const SITE = resolve('tests/e2e/site');
const MEDIA = '/tmp/mr/site';
const server = createServer((req, res) => {
  const name = (req.url ?? '/').split('?')[0].replace(/^\//, '') || 'player.html';
  const file = name.endsWith('.webm') ? `${MEDIA}/${name}` : `${SITE}/${name}`;
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': extname(file) === '.html' ? 'text/html' : 'video/webm' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(8765);

const dist = resolve('dist-test');
const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: !headed,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('console', (m) => m.text().includes('music-remover') && console.log(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

await page.goto('http://localhost:8765/player.html');
await page.evaluate(() => localStorage.setItem('__mr_debug', '1'));
await page.reload();
await page.waitForFunction(() => window.__musicRemoverDebug, null, { timeout: 10000 });

const info = () => page.evaluate(() => window.__musicRemoverDebug.info);
const fmt = (i) =>
  `t=${i.time?.toFixed(1)} state=${i.state} ctx=${i.ctxState} model=${i.worker?.model}/${i.worker?.backend} rtf=${i.worker?.rtf?.toFixed(2)} ` +
  `tiles=[${i.tiles}] sched=[${i.scheduled}] ahead=${i.worker?.ahead?.toFixed(0)}s in=${i.worker?.inputAhead?.toFixed(0)}s ` +
  `drift=${(i.lastDrift * 1000).toFixed(0)}ms max=${(i.maxDrift * 1000).toFixed(0)}ms reanchors=${i.reanchors}`;

const tStart = Date.now();
await page.evaluate(() => document.getElementById('v').play());
let firstClean = null;
const states = [];
while (Date.now() - tStart < 14000) {
  await page.waitForTimeout(1000);
  const i = await info();
  states.push(i.state);
  if (i.state === 'clean' && firstClean === null) firstClean = (Date.now() - tStart) / 1000;
  console.log(`${((Date.now() - tStart) / 1000).toFixed(0).padStart(3)}s ${fmt(i)}`);
}

// ── separation quality & alignment against ground truth ──
const truth = (() => {
  const b = readFileSync('/tmp/mr/speech45.f32');
  const f = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  const l = new Float32Array(f.length / 2);
  for (let i = 0; i < l.length; i++) l[i] = f[2 * i];
  return l;
})();
const musicTruth = (() => {
  const b = readFileSync('/tmp/mr/music45.f32');
  const f = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  const l = new Float32Array(f.length / 2);
  for (let i = 0; i < l.length; i++) l[i] = f[2 * i];
  return l;
})();
const results = [];
for (const k of (await info()).tiles) {
  const tile = await page.evaluate((kk) => window.__musicRemoverDebug.tile(kk), k);
  const s0 = Math.round(tile.start * 44100);
  const clean = Float32Array.from(tile.clean, (x) => x / 32767);
  const mix = Float32Array.from(tile.mix, (x) => x / 32767);
  const ref = truth.subarray(s0, s0 + clean.length);
  writeFileSync(`/tmp/mr/e2e/tile${k}_mix.f32`, Buffer.from(mix.buffer));
  writeFileSync(`/tmp/mr/e2e/tile${k}_clean.f32`, Buffer.from(clean.buffer));
  if (ref.length < clean.length) continue;
  const sdr = (est, lag = 0) => {
    let s = 0, e = 0;
    for (let i = 2000; i < ref.length - 2000; i++) {
      const r = ref[i];
      const x = est[i + lag] ?? 0;
      s += r * r;
      e += (r - x) ** 2;
    }
    return 10 * Math.log10(s / Math.max(e, 1e-12));
  };
  let best = { lag: 0, v: -Infinity };
  for (let lag = -100; lag <= 100; lag += 1) {
    const v = sdr(clean, lag);
    if (v > best.v) best = { lag, v };
  }
  // coarse lag search (±3 s) of the decoded mix against the true mix, to detect timeline offsets
  const mixTrue = (i) => truth[i] + musicTruth[i];
  let coarse = { lag: 0, v: -Infinity };
  for (let lag = -3 * 4410; lag <= 3 * 4410; lag++) {
    let c = 0, n1 = 0, n2 = 0;
    for (let i = 0; i < mix.length; i += 10) {
      const j = s0 + i + lag * 10;
      if (j < 0 || j >= truth.length) continue;
      const a = mix[i], b = mixTrue(j);
      c += a * b; n1 += a * a; n2 += b * b;
    }
    const v = c / Math.sqrt(n1 * n2 + 1e-12);
    if (v > coarse.v) coarse = { lag, v };
  }
  results.push({ mixLagMs: ((coarse.lag * 10) / 44.1).toFixed(1), mixCorr: coarse.v.toFixed(2), k, start: tile.start.toFixed(2), sdrMix: sdr(mix).toFixed(1), sdrClean: sdr(clean).toFixed(1), bestLagMs: ((best.lag / 44100) * 1000).toFixed(1) });
}
console.table(results);

// ── seek forward ──
await page.evaluate(() => (document.getElementById('v').currentTime = 30));
const tSeek = Date.now();
let recovered = null;
while (Date.now() - tSeek < 25000) {
  await page.waitForTimeout(500);
  const i = await info();
  if (i.state === 'clean' && i.time > 30) {
    recovered = (Date.now() - tSeek) / 1000;
    console.log(`after seek: ${fmt(i)}`);
    break;
  }
}
// ── pause / resume ──
await page.evaluate(() => document.getElementById('v').pause());
await page.waitForTimeout(1200);
const paused = await info();
await page.evaluate(() => document.getElementById('v').play());
await page.waitForTimeout(1500);
const resumed = await info();

// ── 1.5× speed (pitch-preserving stretch) ──
await page.evaluate(() => (document.getElementById('v').playbackRate = 1.5));
const fast = [];
for (let i = 0; i < 5; i++) {
  await page.waitForTimeout(1000);
  const x = await info();
  fast.push(x.state);
  console.log(`1.5x: ${fmt(x)}`);
}
await page.evaluate(() => (document.getElementById('v').playbackRate = 1));

// ── processor killed mid-playback: must come back by itself (replay of headers + recent audio) ──
{
  const swk = ctx.serviceWorkers()[0];
  await swk.evaluate(() => chrome.offscreen.closeDocument());
  const tk = Date.now();
  let back = null;
  await page.evaluate(() => { const v = document.getElementById('v'); v.currentTime = 12; });
  while (Date.now() - tk < 20000) {
    await page.waitForTimeout(500);
    const x = await info();
    if (x.state === 'clean' && Date.now() - tk > 1500) { back = (Date.now() - tk) / 1000; break; }
  }
  await page.waitForTimeout(2000);
  const xr = await info();
  console.log(`processor restart → clean again after ${back}s; new worker: model=${xr.worker?.model} tilesDone=${xr.worker?.tilesDone} inputAhead=${xr.worker?.inputAhead?.toFixed(0)}s (replayed audio)`);
}

// ── badge screenshot, then disable via storage (as the popup does) ──
await page.screenshot({ path: '/tmp/mr/e2e/local-player.png', clip: { x: 0, y: 0, width: 700, height: 460 } });
const sw = ctx.serviceWorkers()[0];
await sw.evaluate(() => chrome.storage.sync.set({ enabled: false }));
await page.waitForTimeout(1500);
const off = await info();
const origGain = await page.evaluate(() => document.getElementById('v').muted);
console.log(`disabled: state=${off.state} sched=[${off.scheduled}] videoMuted=${origGain}`);
await sw.evaluate(() => chrome.storage.sync.set({ enabled: true }));
await page.waitForTimeout(1500);
console.log(`re-enabled: state=${(await info()).state}`);
// popup render
const extId = new URL(sw.url()).host;
const pop = await ctx.newPage();
await pop.setViewportSize({ width: 320, height: 470 });
await pop.goto(`chrome-extension://${extId}/popup/popup.html`);
await pop.waitForTimeout(800);
await pop.screenshot({ path: '/tmp/mr/e2e/popup.png' });

console.log(`\n1.5× states: ${fast.join(',')}`);
console.log(`\nfirst clean audio after ${firstClean}s`);
console.log(`seek → clean again after ${recovered}s`);
console.log(`paused: state=${paused.state} sched=[${paused.scheduled}] | resumed: state=${resumed.state} sched=[${resumed.scheduled}]`);
console.log(`max drift ${(resumed.maxDrift * 1000).toFixed(0)} ms, re-anchors ${resumed.reanchors}`);
await ctx.close();
server.close();
