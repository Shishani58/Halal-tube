// Opens the extension's benchmark page in Chromium with the extension loaded.
import { chromium } from 'playwright';
import { resolve } from 'node:path';
const dist = resolve('dist');
const headless = !process.argv.includes('--headed');
const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--enable-unsafe-webgpu'],
});
let [sw] = ctx.serviceWorkers();
if (!sw) sw = await ctx.waitForEvent('serviceworker');
const id = new URL(sw.url()).host;
const page = await ctx.newPage();
page.on('console', (m) => m.type() === 'error' && console.log('console:', m.text()));
await page.goto(`chrome-extension://${id}/bench/bench.html?backends=${process.argv[2] ?? 'webgpu'}&iters=4${process.argv[3] ? `&model=${process.argv[3]}` : ''}`);
await page.waitForFunction(() => window.__bench, null, { timeout: 600000 });
console.log(await page.textContent('#out'));
await ctx.close();
