import { chromium } from 'playwright';
import { resolve } from 'node:path';
const dist = resolve('/Users/ayub/Developer/music-remover-extension/dist');
// Manual check on real YouTube (windowed browser). YouTube may show a bot check to automated
// browsers — the script does not try to get around it.
// Usage: node tests/e2e/youtube.mjs <url | search words> [iterations]
const ctx = await chromium.launchPersistentContext('/tmp/mr/yt-profile', {
  channel: 'chromium', headless: false, viewport: { width: 1280, height: 800 }, locale: 'en-US',
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--autoplay-policy=no-user-gesture-required'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('console', (m) => { const t = m.text(); if (t.includes('music-remover')) console.log('[console]', t); });
await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(3000);
const rej = page.getByRole('button', { name: /reject all/i }).first();
if (await rej.isVisible().catch(() => false)) { await rej.click(); await page.waitForTimeout(3000); }
await page.evaluate(() => localStorage.setItem('__mr_debug', '1'));
let url = process.argv[2];
if (!/^https?:/.test(url)) {
  await page.goto(`https://www.youtube.com/results?search_query=${encodeURIComponent(url)}`, { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('a#video-title[href*="/watch"]', { timeout: 30000 });
  url = new URL(await page.$eval('a#video-title[href*="/watch"]', (a) => a.getAttribute('href')), 'https://www.youtube.com').href.split('&')[0];
}
console.log('video', url);
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(4000);
console.log('title', await page.title());
const N = Number(process.argv[3] ?? 8);
for (let i = 0; i < N; i++) {
  await page.waitForTimeout(3000);
  const r = await page.evaluate(() => {
    const v = document.querySelector('video');
    if (v && v.paused) v.play().catch(() => {});
    document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern')?.click();
    const d = window.__musicRemoverDebug?.info;
    return d ? { state: d.state, t: d.time, tiles: d.tiles, hook: d.hookStats, log: d.hookLog, src: d.videoSrc, rs: d.readyState, paused: d.paused, w: d.worker, drift: d.maxDrift } : { noDebug: true, url: location.href, v: !!v };
  }).catch((e) => ({ err: e.message }));
  console.log(JSON.stringify(r));
}
await page.screenshot({ path: '/tmp/mr/e2e/yt.png' });
// dump the most recent complete tile (mix vs clean) for inspection
const info = await page.evaluate(() => window.__musicRemoverDebug?.info).catch(() => null);
const k = info?.tiles?.filter((x) => x >= 2).slice(-2)[0] ?? info?.tiles?.[0];
if (k !== undefined) {
  const tile = await page.evaluate((kk) => window.__musicRemoverDebug.tile(kk), k);
  const { writeFileSync } = await import('node:fs');
  const wav = (samples) => {
    const n = samples.length, b = Buffer.alloc(44 + n * 2);
    b.write('RIFF', 0); b.writeUInt32LE(36 + n * 2, 4); b.write('WAVEfmt ', 8); b.writeUInt32LE(16, 16); b.writeUInt16LE(1, 20); b.writeUInt16LE(1, 22);
    b.writeUInt32LE(44100, 24); b.writeUInt32LE(88200, 28); b.writeUInt16LE(2, 32); b.writeUInt16LE(16, 34); b.write('data', 36); b.writeUInt32LE(n * 2, 40);
    samples.forEach((x, i) => b.writeInt16LE(x, 44 + i * 2));
    return b;
  };
  writeFileSync('/tmp/mr/e2e/yt_clean.wav', wav(tile.clean));
  if (tile.mix) writeFileSync('/tmp/mr/e2e/yt_mix.wav', wav(tile.mix));
  console.log('dumped tile', k, 'start', tile.start);
}
await ctx.close();
