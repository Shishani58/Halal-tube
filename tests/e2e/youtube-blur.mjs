import { chromium } from 'playwright';
import { resolve } from 'node:path';
// Manual blurring check on real YouTube (windowed browser): what the classifier sees, how fast,
// and how much of the video ends up blurred. YouTube may show a bot check to automated browsers —
// the script does not try to get around it.
// Usage: node tests/e2e/youtube-blur.mjs <url | search words> [seconds]
const dist = resolve('dist');
const ctx = await chromium.launchPersistentContext('/tmp/mr/yt-profile-blur', {
  channel: 'chromium', headless: false, viewport: { width: 1280, height: 800 }, locale: 'en-US',
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--autoplay-policy=no-user-gesture-required'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('console', (m) => { const t = m.text(); if (t.includes('music-remover')) console.log('[console]', t); });
await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
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
const secs = Number(process.argv[3] ?? 40);
const counts = {};
const tStart = Date.now();
let last = null;
while (Date.now() - tStart < secs * 1000) {
  await page.waitForTimeout(500);
  const r = await page.evaluate(() => {
    const v = document.querySelector('video.html5-main-video') ?? document.querySelector('video');
    if (v && v.paused) v.play().catch(() => {});
    document.querySelector('.ytp-ad-skip-button, .ytp-skip-ad-button, .ytp-ad-skip-button-modern')?.click();
    const d = window.__musicRemoverDebug?.info;
    return { t: v?.currentTime, res: v ? `${v.videoWidth}x${v.videoHeight}` : '', filter: v?.style.getPropertyValue('filter') ?? '', vis: d?.vision, music: d?.state };
  }).catch((e) => ({ err: e.message }));
  if (r.vis) counts[r.vis.state] = (counts[r.vis.state] ?? 0) + 1;
  last = r;
}
const s = last?.vis?.status;
console.log(`resolution ${last?.res}; states over ${secs}s (every 0.5 s): ${JSON.stringify(counts)}`);
console.log(`classifier: model=${s?.model}/${s?.backend} frames=${s?.frames} speed=${s?.speed?.toFixed(1)}× ahead=${s?.ahead?.toFixed(0)}s samples=${last?.vis?.samples} checked=${JSON.stringify(last?.vis?.checked)}`);
const rows = await page.evaluate(() => window.__musicRemoverDebug?.visionSamples?.() ?? []);
const flagged = rows.filter((x) => x[1] >= 0.3 || x[2] >= 0.4 || x[3] >= 0.5);
console.log(`frames flagged: ${flagged.length}/${rows.length}; examples: ${JSON.stringify(flagged.slice(0, 6))}`);
await page.screenshot({ path: '/tmp/mr/e2e/yt-blur.png' });
await ctx.close();
