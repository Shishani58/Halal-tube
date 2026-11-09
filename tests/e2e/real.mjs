// Runs the full extension on a real narrated video with music (no ground truth):
// streams it through the local MSE player, then dumps original vs clean audio for inspection.
// Usage: node tests/e2e/real.mjs <dir with audio.webm + video.webm> [seconds]
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync, writeFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';

const MEDIA = process.argv[2];
const seconds = Number(process.argv[3] ?? 70);
const SITE = resolve('tests/e2e/site');
const server = createServer((req, res) => {
  const name = (req.url ?? '/').split('?')[0].replace(/^\//, '') || 'player.html';
  const file = name.endsWith('.webm') ? `${MEDIA}/${name}` : `${SITE}/${name}`;
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': extname(file) === '.html' ? 'text/html' : 'video/webm' });
    res.end(body);
  } catch { res.writeHead(404).end(); }
}).listen(8766);

const dist = resolve('dist-test');
const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium', headless: true,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
await page.goto('http://localhost:8766/player.html');
await page.evaluate(() => localStorage.setItem('__mr_debug', '1'));
await page.reload();
await page.waitForFunction(() => window.__musicRemoverDebug, null, { timeout: 10000 });
await page.evaluate(() => document.getElementById('v').play());

const got = new Map();
const t0 = Date.now();
while (Date.now() - t0 < seconds * 1000) {
  await page.waitForTimeout(2000);
  const i = await page.evaluate(() => window.__musicRemoverDebug.info);
  for (const k of i.tiles) if (!got.has(k)) got.set(k, await page.evaluate((kk) => window.__musicRemoverDebug.tile(kk), k));
  console.log(`t=${i.time.toFixed(1)} state=${i.state} model=${i.worker?.model}/${i.worker?.backend} rtf=${i.worker?.rtf?.toFixed(2)} tiles=${got.size} drift=${(i.lastDrift * 1000).toFixed(0)}ms max=${(i.maxDrift * 1000).toFixed(0)}ms`);
}
await ctx.close();
server.close();

const ks = [...got.keys()].sort((a, b) => a - b);
const cat = (key) => {
  const parts = ks.map((k) => got.get(k)[key]);
  const out = new Int16Array(parts.reduce((a, p) => a + p.length, 0));
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
};
const wav = (s) => {
  const b = Buffer.alloc(44 + s.length * 2);
  b.write('RIFF', 0); b.writeUInt32LE(36 + s.length * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
  b.writeUInt32LE(44100, 24); b.writeUInt32LE(88200, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(s.length * 2, 40);
  Buffer.from(s.buffer).copy(b, 44);
  return b;
};
const mix = cat('mix'), clean = cat('clean');
writeFileSync(`${MEDIA}/../out_mix.wav`, wav(mix));
writeFileSync(`${MEDIA}/../out_clean.wav`, wav(clean));
const resid = Int16Array.from(mix, (x, i) => Math.max(-32768, Math.min(32767, x - clean[i])));
writeFileSync(`${MEDIA}/../out_removed.wav`, wav(resid));
const db = (a) => 10 * Math.log10(a.reduce((s, x) => s + x * x, 0) / a.length + 1e-9);
console.log(`tiles ${ks[0]}..${ks[ks.length - 1]} (${(mix.length / 44100).toFixed(1)} s): mix ${db(mix).toFixed(1)} dB, clean ${db(clean).toFixed(1)} dB, removed ${db(resid).toFixed(1)} dB`);
