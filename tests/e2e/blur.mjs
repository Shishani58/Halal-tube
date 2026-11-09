// Blurring end-to-end in Chromium on the local YouTube-like MSE player, with a video of known
// content (tests/e2e/blur/timeline.json: 6 s stills of landscapes, women, men).
// Prereqs: npm run build:test, sh tests/e2e/make-media.sh, sh tests/e2e/make-blur-media.sh
// Checks: frames get classified ahead of playback; women / men / scenes are blurred or not as
// expected; strict mode blurs unchecked frames; a jump to an unbuffered spot recovers; the
// "women" option off leaves women unblurred; turning the feature off removes the blur.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';

const headed = process.argv.includes('--headed');
const SITE = resolve('tests/e2e/site');
const MEDIA = '/tmp/mr/site';
// BLUR_FIXTURE=nasa: 1080p VP9 clip of a NASA broadcast (tests/e2e/make-blur-media.sh nasa)
const FIX = process.env.BLUR_FIXTURE === 'nasa' ? { video: 'video-nasa1080.webm', truth: 'nasa.json' } : { video: 'video-people.webm', truth: 'timeline.json' };
const truth = JSON.parse(readFileSync(`tests/e2e/blur/${FIX.truth}`, 'utf8'));
// segments: [start, end, kind]
const segs = truth.spans ?? truth.content.map((k, i) => [i * truth.segment, (i + 1) * truth.segment, k]);
const segAt = (t) => segs.findIndex(([a, b]) => t >= a && t < b);
const kindAt = (t) => segs[segAt(t)]?.[2];

const server = createServer((req, res) => {
  let name = (req.url ?? '/').split('?')[0].replace(/^\//, '') || 'player.html';
  if (name === 'video.webm') name = FIX.video;
  const file = name.endsWith('.webm') ? `${MEDIA}/${name}` : `${SITE}/${name}`;
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': extname(file) === '.html' ? 'text/html' : 'video/webm' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(8791);

const dist = resolve('dist-test');
const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: !headed,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
page.on('console', (m) => m.text().includes('music-remover') && console.log(`[console.${m.type()}] ${m.text()}`));
page.on('pageerror', (e) => console.log('[pageerror]', e.message));

let sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
const setSettings = (s) => sw.evaluate((x) => chrome.storage.sync.set(x), s);
await setSettings({ enabled: false, blur: true, blurWomen: true, blurStrict: true }); // isolate blurring

await page.goto('http://localhost:8791/player.html');
await page.evaluate(() => localStorage.setItem('__mr_debug', '1'));
await page.reload();
await page.waitForFunction(() => window.__musicRemoverDebug, null, { timeout: 10000 });

const play = async () => {
  for (let i = 0; i < 50; i++) {
    const ok = await page.evaluate(() => document.getElementById('v').play().then(() => true, () => false));
    if (ok) return;
    await page.waitForTimeout(200);
  }
  throw new Error('video would not play');
};
const snap = () =>
  page.evaluate(() => {
    const v = document.getElementById('v');
    const i = window.__musicRemoverDebug.info;
    return { t: v.currentTime, filter: v.style.getPropertyValue('filter'), vision: i.vision, paused: v.paused };
  });

// ── time to the first checked frame, from a cold start (model load included) ──
const t0 = Date.now();
await play();
let firstChecked = null;
const early = [];
while (Date.now() - t0 < 20000) {
  await page.waitForTimeout(100);
  const s = await snap();
  early.push(`${s.t.toFixed(1)}:${s.vision.state}${s.filter ? '(blur)' : ''}`);
  if (s.vision.state !== 'checking' && s.vision.state !== 'no-video') {
    firstChecked = (Date.now() - t0) / 1000;
    break;
  }
}
console.log(`cold start → first checked frame after ${firstChecked}s; meanwhile: ${early.slice(0, 12).join(' ')}`);
const st0 = (await snap()).vision.status;
console.log(`model=${st0?.model}/${st0?.backend}`);

// ── play through and compare with ground truth, sampling 5×/s ──
const rows = [];
const tPlay = Date.now();
while (Date.now() - tPlay < 50000) {
  await page.waitForTimeout(200);
  const s = await snap();
  rows.push(s);
  if (s.t >= 47.5 || (s.paused && s.t > 1)) break;
}
const st = (await snap()).vision.status;
console.log(`classifier: ${st.frames} frames, ${st.speed.toFixed(1)}× real time, checked ahead ${st.ahead.toFixed(0)} s; spans ${JSON.stringify((await snap()).vision.checked)}`);

const dumpRows = await page.evaluate(() => window.__musicRemoverDebug.visionSamples());
console.log('scores every 2 s [t, nude, skin, female]:', JSON.stringify(dumpRows.filter((_, i) => i % 8 === 0)));
let wrong = 0, total = 0;
const seg = {};
for (const r of rows) {
  const kind = kindAt(r.t);
  const k = segAt(r.t);
  if (k < 0) continue;
  // ignore the margins around cuts: blur deliberately starts 0.6 s early and ends 1 s late
  if (r.t < segs[k][0] + 1.1 || r.t > segs[k][1] - 0.7) continue;
  const blurred = !!r.filter;
  const want = kind === 'woman';
  total++;
  if (blurred !== want) wrong++;
  seg[k] ??= { kind, n: 0, blurred: 0, states: new Set() };
  seg[k].n++;
  seg[k].blurred += blurred ? 1 : 0;
  seg[k].states.add(r.vision.state);
}
console.table(Object.entries(seg).map(([k, v]) => ({ seg: `${segs[k][0]}-${segs[k][1]}s`, kind: v.kind, blurred: `${v.blurred}/${v.n}`, states: [...v.states].join(',') })));
console.log(`women/men/scenes: ${total - wrong}/${total} samples as expected`);

// ── "women" off: same spot stays clear (nudity-only mode) ──
await page.evaluate((t) => {
  const v = document.getElementById('v');
  v.pause();
  v.currentTime = t;
}, FIX.truth === 'nasa.json' ? 30 : 9);
await page.waitForTimeout(800);
const withWomen = await snap();
await setSettings({ blurWomen: false });
await page.waitForTimeout(500);
const withoutWomen = await snap();
console.log(`woman on screen: women on → ${withWomen.vision.state} ${withWomen.filter || 'no blur'}; women off → ${withoutWomen.vision.state} ${withoutWomen.filter || 'no blur'}`);
await setSettings({ blurWomen: true });

// ── jump into an unchecked region: strict blur until checked ──
await page.reload();
await page.waitForFunction(() => window.__musicRemoverDebug, null, { timeout: 10000 });
await play();
await page.waitForFunction(() => window.__musicRemoverDebug.info.vision.state !== 'checking', null, { timeout: 20000 });
const jumpTo = 38.5; // a woman is on screen there in both fixtures
await page.evaluate((t) => (document.getElementById('v').currentTime = t), jumpTo);
const tj = Date.now();
let afterJump = null;
const jumpStates = [];
while (Date.now() - tj < 15000) {
  await page.waitForTimeout(100);
  const s = await snap();
  jumpStates.push(`${s.vision.state}${s.filter ? '*' : ''}`);
  if (s.t >= jumpTo && s.vision.state !== 'checking') {
    afterJump = { s: (Date.now() - tj) / 1000, state: s.vision.state, blurred: !!s.filter };
    break;
  }
}
console.log(`jump to ${jumpTo} s (unbuffered) → checked after ${afterJump?.s}s, state=${afterJump?.state} blurred=${afterJump?.blurred}; unchecked frames blurred: ${jumpStates.filter((x) => x.startsWith('checking')).every((x) => x.endsWith('*'))}`);
await page.screenshot({ path: '/tmp/mr/e2e/blur-woman.png', clip: { x: 0, y: 0, width: 700, height: 460 } });

// ── feature off: blur removed ──
await setSettings({ blur: false });
await page.waitForTimeout(500);
const off = await snap();
console.log(`blur off → state=${off.vision.state} filter="${off.filter}"`);

// popup
const extId = new URL(sw.url()).host;
await setSettings({ blur: true });
const pop = await ctx.newPage();
await pop.setViewportSize({ width: 320, height: 640 });
await pop.goto(`chrome-extension://${extId}/popup/popup.html`);
await pop.waitForTimeout(800);
await pop.screenshot({ path: '/tmp/mr/e2e/popup-blur.png' });
await setSettings({ enabled: true });
await ctx.close();
server.close();
