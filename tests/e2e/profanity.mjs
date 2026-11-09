// Profanity filter end-to-end: the extension in Chromium plays the local MSE player with the
// profanity fixture (English + Russian speech with swear words at known times, mixed with
// music) and we check, per configuration, that the swear words are muted / beeped at the right
// times and nothing else is cut.
// Prereqs: sh tests/e2e/make-media.sh && node tests/e2e/make-profanity-media.mjs && npm run build:test
//   node tests/e2e/profanity.mjs [--headed] [beep+music mute+music beep mute]
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';

const SITE = resolve('tests/e2e/site');
const MEDIA = '/tmp/mr/site';
const PORT = 8766;
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
}).listen(PORT);

const R = 44100;
const truth = JSON.parse(readFileSync('/tmp/mr/prof/truth.json', 'utf8'));
const readLeft = (f) => {
  const b = readFileSync(f);
  const x = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  return Float32Array.from({ length: x.length / 2 }, (_, i) => x[2 * i]);
};
const speech = readLeft('/tmp/mr/prof/speech.f32');
const music = readLeft('/tmp/mr/music45.f32');
const mixRef = Float32Array.from(speech, (s, i) => s + 0.8 * (music[i] ?? 0));

const CONFIGS = {
  'beep+music': { profanity: 'beep', musicRemoval: true },
  'mute+music': { profanity: 'mute', musicRemoval: true },
  beep: { profanity: 'beep', musicRemoval: false },
  mute: { profanity: 'mute', musicRemoval: false },
  // no filtering: saves the separated voice to /tmp/mr/prof/vocals.f32 (to benchmark recognition on it)
  capture: { profanity: 'off', musicRemoval: true },
};
const wanted = process.argv.slice(2).filter((a) => !a.startsWith('-'));
const runs = wanted.length ? wanted : Object.keys(CONFIGS).filter((c) => c !== 'capture');

const dist = resolve('dist-test');
const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: !process.argv.includes('--headed'),
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
// settings are written from an extension page (the MV3 service worker may be asleep)
const extId = new URL(sw.url()).host;
const ext = await ctx.newPage();
await ext.goto(`chrome-extension://${extId}/popup/popup.html`);
const setSettings = (s) => ext.evaluate((x) => chrome.storage.sync.set(x), s);
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.bringToFront();
page.on('console', (m) => m.text().includes('music-remover') && console.log(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));
await page.goto(`http://localhost:${PORT}/player.html`);
await page.evaluate(() => localStorage.setItem('__mr_debug', '1'));

const FRAME = Math.round(0.01 * R);
const rmsAt = (x, i0) => {
  let s = 0;
  for (let i = i0; i < i0 + FRAME; i++) s += (x[i] ?? 0) ** 2;
  return Math.sqrt(s / FRAME);
};
/** Share of a 10 ms frame's energy at 1 kHz (Goertzel). */
const beepShare = (x, i0) => {
  const w = (2 * Math.PI * 1000) / R;
  let s1 = 0, s2 = 0, e = 0;
  for (let i = i0; i < i0 + FRAME; i++) {
    const v = x[i] ?? 0;
    const s0 = v + 2 * Math.cos(w) * s1 - s2;
    s2 = s1;
    s1 = s0;
    e += v * v;
  }
  const p = s1 * s1 + s2 * s2 - 2 * Math.cos(w) * s1 * s2;
  return e > 1e-9 ? (2 * p) / (FRAME * e) : 0;
};

const summary = [];
for (const name of runs) {
  const cfg = CONFIGS[name];
  await setSettings({ enabled: true, mode: 'strict', ...cfg });
  await page.goto(`http://localhost:${PORT}/player.html?audio=audio_prof.webm`);
  await page.waitForFunction(() => window.__musicRemoverDebug, null, { timeout: 10000 });
  const info = () => page.evaluate(() => window.__musicRemoverDebug.info);
  await page.evaluate(() => document.getElementById('v').play());

  // collect every tile as it arrives (the page drops tiles behind the playhead)
  const out = new Float32Array(45 * R);
  const have = new Uint8Array(45 * R); // samples covered by a received tile
  const got = new Map();
  const t0 = Date.now();
  let firstClean = null;
  let stalls = 0;
  let lastState = '';
  let lastReceived = -1;
  while (Date.now() - t0 < 80000) {
    await page.waitForTimeout(400);
    const i = await info();
    if (i.state === 'clean' && firstClean === null) firstClean = (Date.now() - t0) / 1000;
    if (firstClean !== null && i.state === 'waiting' && lastState !== 'waiting') stalls++;
    lastState = i.state;
    if (process.argv.includes('--verbose')) console.log(`t=${i.time?.toFixed(1)} state=${i.state} model=${i.worker?.model} asr=${i.worker?.asr} tiles=[${i.tiles}] proc=${i.procConnected}`);
    // a tile can arrive again, re-censored, when the next tile finds a word on their seam
    const refetch = i.tilesReceived !== lastReceived;
    lastReceived = i.tilesReceived;
    for (const k of i.tiles) {
      if (got.has(k) && !refetch) continue;
      const tile = await page.evaluate((kk) => window.__musicRemoverDebug.tile(kk), k);
      if (!tile || tile.cfg !== `${cfg.musicRemoval ? 'v' : 'm'}:${cfg.profanity}`) continue;
      if (tile.profanity?.input) {
        // what the recognizer heard (debug builds send it), for offline comparison
        writeFileSync(`/tmp/mr/prof/asr-input-${name}-${k}.f32`, Buffer.from(Float32Array.from(tile.profanity.input, (x) => x / 32767).buffer));
        delete tile.profanity.input;
      }
      got.set(k, tile);
      const s0 = Math.round(tile.start * R);
      for (let j = 0; j < tile.clean.length && s0 + j < out.length; j++) {
        out[s0 + j] = tile.clean[j] / 32767;
        have[s0 + j] = 1;
      }
    }
    if (await page.evaluate(() => document.getElementById('v').ended)) break;
  }
  const ws = (await info()).worker;
  if (name === 'capture') {
    writeFileSync('/tmp/mr/prof/vocals.f32', Buffer.from(out.buffer));
    console.log(`saved /tmp/mr/prof/vocals.f32 (tiles ${[...got.keys()]})`);
    continue;
  }
  const reports = [...got.values()].map((t) => t.profanity).filter(Boolean);
  const ref = cfg.musicRemoval ? speech : mixRef;

  const masked = (i0) => {
    const r = rmsAt(ref, i0);
    if (r < 0.01) return null; // too quiet to tell
    if (!have[i0] || !have[i0 + FRAME - 1]) return null; // no tile here (playback outran processing)
    return cfg.profanity === 'beep' ? beepShare(out, i0) > 0.6 : rmsAt(out, i0) < 0.1 * r;
  };
  const frames = (s, e) => {
    const res = [];
    for (let i = Math.round(s * R); i + FRAME <= Math.round(e * R); i += FRAME) res.push({ t: i / R, m: masked(i) });
    return res.filter((f) => f.m !== null);
  };

  // detection & coverage of each swear word, measured on the output audio
  let found = 0;
  const cover = [];
  const edges = [];
  for (const p of truth.profane) {
    const f = frames(p.start, p.end);
    const share = f.length ? f.filter((x) => x.m).length / f.length : 0;
    cover.push(share);
    if (share >= 0.5) found++;
    // timing of the masked region around the word (−: starts before the word / +: ends after)
    const around = frames(p.start - 0.4, p.end + 0.4).filter((x) => x.m);
    const hit = reports.flatMap((r) => r.hits).filter((h) => h.end > p.start - 0.2 && h.start < p.end + 0.2);
    const hs = hit.length ? Math.min(...hit.map((h) => h.start)) : NaN;
    const he = hit.length ? Math.max(...hit.map((h) => h.end)) : NaN;
    if (around.length) edges.push({ word: p.text, at: p.start, coverage: share.toFixed(2), maskStartMs: Math.round((around[0].t - p.start) * 1000), maskEndMs: Math.round((around.at(-1).t + 0.01 - p.end) * 1000), asrStartErrMs: Math.round((hs - p.start) * 1000), asrEndErrMs: Math.round((he - p.end) * 1000) });
    else edges.push({ word: p.text, at: p.start, coverage: '0.00', maskStartMs: '-', maskEndMs: '-', asrStartErrMs: '-', asrEndErrMs: '-' });
  }
  // collateral: masked frames in other speech, away from the swear words (pad + timing error)
  const nearBad = (t) => truth.profane.some((p) => t > p.start - 0.2 && t < p.end + 0.2);
  let otherFrames = 0;
  let otherMasked = 0;
  for (const ph of truth.phrases) {
    if (truth.profane.includes(ph)) continue;
    for (const f of frames(ph.start, ph.end)) {
      if (nearBad(f.t)) continue;
      otherFrames++;
      if (f.m) otherMasked++;
    }
  }
  const lookalikes = truth.clean.map((c) => {
    const f = frames(c.start, c.end);
    return `${c.text}:${(f.filter((x) => x.m).length / Math.max(1, f.length)).toFixed(2)}`;
  });
  const fps = reports.flatMap((r) => r.hits).filter((h) => !truth.profane.some((p) => h.end > p.start - 0.2 && h.start < p.end + 0.2));
  const uniqFp = [...new Map(fps.map((h) => [`${h.text}@${h.start.toFixed(1)}`, h])).values()];

  console.log(`\n── ${name} ──  tiles ${[...got.keys()].sort((a, b) => a - b)}  first clean ${firstClean}s, stalls after start: ${stalls}`);
  console.log(`worker: rtf ${ws?.rtf?.toFixed(2)} (${(1 / ws?.rtf).toFixed(1)}× real time), ASR ${ws?.asrMs?.toFixed(0)} ms/tile, asr=${ws?.asr}`);
  for (const r of reports.sort((a, b) => a.words[0]?.start - b.words[0]?.start)) console.log(`  ${r.lang} p=${r.langProb.toFixed(2)} ×${r.passes} ctx=${r.context} ${r.asrMs.toFixed(0)} ms | ${r.words.map((w) => w.text).join('').trim()}`);
  console.table(edges);
  console.log(`look-alike words masked share: ${lookalikes.join(' ')}`);
  console.log(`false-positive hits: ${uniqFp.map((h) => `${h.text.trim()}@${h.start.toFixed(2)}`).join(', ') || 'none'}`);
  summary.push({
    config: name,
    found: `${found}/${truth.profane.length}`,
    meanCoverage: (cover.reduce((a, b) => a + b, 0) / cover.length).toFixed(2),
    otherSpeechMaskedPct: ((100 * otherMasked) / Math.max(1, otherFrames)).toFixed(1),
    falsePos: uniqFp.length,
    rtf: ws?.rtf?.toFixed(2),
    asrMs: ws?.asrMs?.toFixed(0),
    firstCleanS: firstClean,
    stalls,
  });
}
console.log('\nSummary');
console.table(summary);
await setSettings({ profanity: 'off', musicRemoval: true });
await ctx.close();
server.close();
