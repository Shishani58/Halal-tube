// Where the blur pipeline spends its time: plays the blur fixture to the end and prints the vision
// worker's per-stage timers (status.timings). Prereqs: npm run build:test, make-media.sh,
// make-blur-media.sh [nasa]. BLUR_FIXTURE=nasa for the 1080p clip. Add --headed to watch.
import { chromium } from 'playwright';
import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';

const headed = process.argv.includes('--headed');
const SITE = resolve('tests/e2e/site');
const MEDIA = '/tmp/mr/site';
const nasa = process.env.BLUR_FIXTURE === 'nasa';
const video = nasa ? 'video-nasa1080.webm' : 'video-people.webm';
const DURATION = nasa ? 44 : 47;

const server = createServer((req, res) => {
  let name = (req.url ?? '/').split('?')[0].replace(/^\//, '') || 'player.html';
  if (name === 'video.webm') name = video;
  const file = name.endsWith('.webm') ? `${MEDIA}/${name}` : `${SITE}/${name}`;
  try {
    const body = readFileSync(file);
    res.writeHead(200, { 'content-type': extname(file) === '.html' ? 'text/html' : 'video/webm' });
    res.end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(8793);

const dist = resolve('dist-test');
const ctx = await chromium.launchPersistentContext('', {
  channel: 'chromium',
  headless: !headed,
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`, '--enable-unsafe-webgpu', '--autoplay-policy=no-user-gesture-required'],
});
const page = ctx.pages()[0] ?? (await ctx.newPage());
const sw = ctx.serviceWorkers()[0] ?? (await ctx.waitForEvent('serviceworker'));
await sw.evaluate((x) => chrome.storage.sync.set(x), { enabled: true, musicRemoval: false, profanity: 'off', blur: true, blurWomen: true, blurStrict: true });
await page.goto('http://localhost:8793/player.html');
await page.evaluate(() => localStorage.setItem('__mr_debug', '1'));
await page.reload();
await page.waitForFunction(() => window.__musicRemoverDebug, null, { timeout: 10000 });
for (let i = 0; i < 50; i++) {
  if (await page.evaluate(() => document.getElementById('v').play().then(() => true, () => false))) break;
  await page.waitForTimeout(200);
}
const status = () => page.evaluate(() => window.__musicRemoverDebug.info.vision?.status);
const t0 = Date.now();
let st = null;
while (Date.now() - t0 < 90000) {
  await page.waitForTimeout(500);
  st = await status();
  const t = await page.evaluate(() => document.getElementById('v').currentTime);
  if (process.env.VERBOSE) console.log(`t=${t.toFixed(1)} frames=${st?.frames} ahead=${st?.ahead?.toFixed(0)} decoded=${st?.timings?.decodedFrames} model=${st?.model} backend=${st?.backend} err=${st?.error ?? ''}`);
  if (t >= DURATION) break;
}
// let the analysis finish: the status stops changing
for (let last = -1, same = 0; same < 6 && Date.now() - t0 < 120000; ) {
  await page.waitForTimeout(500);
  st = await status();
  same = st.timings?.decodedFrames === last ? same + 1 : 0;
  last = st.timings?.decodedFrames;
}
st = await status();
if (process.env.DUMP) {
  // frame scores and cuts, to replay budgets offline: DUMP=/path/out.json
  const { writeFileSync } = await import('node:fs');
  const dump = await page.evaluate(() => ({ samples: window.__musicRemoverDebug.visionSamples(), cuts: window.__musicRemoverDebug.visionCuts() }));
  writeFileSync(process.env.DUMP, JSON.stringify(dump));
  console.log(`dumped ${dump.samples.length} frames, ${dump.cuts.length} cuts → ${process.env.DUMP}`);
}
const T = st.timings;
const sec = (k) => (T[k] ?? 0) / 1000;
console.log(`fixture=${video} backend=${st.backend} classified=${st.frames} frames, speed=${st.speed.toFixed(1)}x`);
console.log(`decoded frames=${T.decodedFrames} classify calls=${T.classifyCalls} (frames ${T.classifyFrames}) gender crops=${T.genderCrops} CLIP looks=${T.clipLooks ?? 'n/a'} skipped=${T.clipSkipped ?? 'n/a'}`);
const total = sec('analyse');
const rows = [
  ['decode+thumbnail draw (frameCb)', sec('frameCb')],
  ['thumbnail readback', sec('thumbReadback')],
  ['shot tracking (CPU)', sec('shotTrack')],
  ['detector input prep+readback', sec('detPrep')],
  ['detector run (NudeNet)', sec('detRun')],
  ['MobileCLIP (scene)', sec('clip')],
  ['face crops prep+readback', sec('facePrep')],
  ['genderage run (CPU)', sec('gender')],
  ['post-processing', sec('post')],
];
const named = rows.reduce((a, [, v]) => a + v, 0);
rows.push(['other (decoder wait, scheduling)', Math.max(0, total - named)]);
console.log(`analysis wall time total: ${total.toFixed(2)} s`);
console.table(rows.map(([stage, s]) => ({ stage, seconds: +s.toFixed(2), share: `${((100 * s) / total).toFixed(0)}%` })));
await ctx.close();
server.close();
