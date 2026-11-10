import { chromium } from 'playwright';
import { resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
// Manual check of thumbnail blurring on real YouTube: which thumbnails get a verdict, whether a
// woman gets boxes (not a whole-picture blur), and a screenshot. YouTube may show a bot check to
// automated browsers — the script does not try to get around it.
// Usage: node tests/e2e/youtube-thumbs.mjs <watch url> [seconds]
const dist = resolve('dist');
mkdirSync('/tmp/mr/e2e', { recursive: true });
const ctx = await chromium.launchPersistentContext('/tmp/mr/yt-profile-thumbs', {
  channel: 'chromium', headless: false, viewport: { width: 1400, height: 900 }, locale: 'en-US',
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--autoplay-policy=no-user-gesture-required'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('console', (m) => { const t = m.text(); if (t.includes('music-remover')) console.log('[console]', t); });
await page.goto('https://www.youtube.com/', { waitUntil: 'domcontentloaded', timeout: 90000 });
await page.waitForTimeout(3000);
const rej = page.getByRole('button', { name: /reject all/i }).first();
if (await rej.isVisible().catch(() => false)) { await rej.click(); await page.waitForTimeout(3000); }
await page.goto(process.argv[2], { waitUntil: 'domcontentloaded' });
const secs = Number(process.argv[3] ?? 40);
await page.waitForTimeout(secs * 1000);
const rows = await page.evaluate(() => [...document.querySelectorAll('[data-mr-key]')].map((el) => {
  const host = el.parentElement;
  const boxes = host ? [...host.querySelectorAll(':scope > [data-mr-box]')].filter((b) => b.style.display !== 'none').length : 0;
  return { key: el.getAttribute('data-mr-key').split('/').slice(-2).join('/'), verdict: el.getAttribute('data-mr-thumb'), boxes };
}));
console.table(rows);
await page.screenshot({ path: '/tmp/mr/e2e/yt-thumbs.png' });
console.log('screenshot /tmp/mr/e2e/yt-thumbs.png');
await ctx.close();
