// Fixture for the profanity filter: 45 s of English and Russian speech (macOS `say`, voices
// Samantha and Milena) with swear words at known times, mixed with the synthetic music of
// make-media.sh. Sentences are assembled from separately spoken pieces, so the exact span of
// every word of interest is known.
//   /tmp/mr/site/audio_prof.webm   mix as DASH WebM/Opus (served by the local player)
//   /tmp/mr/prof/speech.f32        clean speech, stereo 44.1 kHz float32
//   /tmp/mr/prof/truth.json        { profane: [{text,start,end}], clean: [...], phrases: [...] }
// Prereq: sh tests/e2e/make-media.sh (for /tmp/mr/music45.f32 and video.webm).
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';

const DIR = '/tmp/mr/prof';
mkdirSync(DIR, { recursive: true });
mkdirSync('/tmp/mr/site', { recursive: true });
const RATE = 44100;
const DUR = 45;

// Each line: [voice, start time (s), pieces]; a piece is "text" or ["word", kind] where kind is
// 'p' (profane, must be filtered) or 'c' (clean look-alike, must stay).
const EN = 'Samantha';
const RU = 'Milena';
const SCRIPT = [
  [EN, 0.6, ['This is a normal sentence about the weather.']],
  [EN, 3.6, ['What the', ['fuck', 'p'], 'is going on here?']],
  // straddles the tile boundary at 11.494 s
  [EN, 10.2, ['That was complete', ['bullshit', 'p'], 'if you ask me.']],
  [EN, 14.6, ['I bought fresh bread and a new', ['dictionary', 'c'], 'today.']],
  [EN, 18.4, ['Shut up, you stupid', ['bitch', 'p'], '.']],
  [RU, 22.6, ['Сегодня хорошая погода,', ['небо', 'c'], 'голубое, и', ['хлеб', 'c'], 'свежий.']],
  // straddles the tile boundary at 28.735 s
  [RU, 27.3, ['Это просто полный', ['пиздец', 'p'], ', ребята.']],
  [RU, 31.6, ['Какого', ['хуя', 'p'], 'ты опоздал?']],
  [RU, 35.0, ['Он меня', ['заебал', 'p'], 'своими вопросами.']],
  [RU, 38.8, ['Нужно', ['требовать', 'c'], ', а не', ['колебаться', 'c'], '.']],
  [RU, 42.0, [['Блять', 'p'], ', опять дождь.']],
];

function speak(voice, text, name) {
  const aiff = `${DIR}/${name}.aiff`;
  const f32 = `${DIR}/${name}.f32`;
  execFileSync('say', ['-v', voice, '-o', aiff, text]);
  execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', aiff, '-ar', String(RATE), '-ac', '1', '-f', 'f32le', f32]);
  const b = readFileSync(f32);
  let x = new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4);
  // trim leading/trailing silence so the piece's extent is the word itself
  const thr = 0.004;
  let a = 0;
  while (a < x.length && Math.abs(x[a]) < thr) a++;
  let e = x.length - 1;
  while (e > a && Math.abs(x[e]) < thr) e--;
  return x.slice(Math.max(0, a - 44), Math.min(x.length, e + 45));
}

const speech = new Float32Array(DUR * RATE);
const truth = { profane: [], clean: [], phrases: [] };
let n = 0;
const GAP = 0.07; // between pieces of one sentence
for (const [voice, t0, pieces] of SCRIPT) {
  let t = t0;
  for (const p of pieces) {
    const [text, kind] = Array.isArray(p) ? p : [p, null];
    if (/^[.,!?]$/.test(text.trim())) continue;
    const x = speak(voice, text, `piece${n++}`);
    const i0 = Math.round(t * RATE);
    for (let i = 0; i < x.length && i0 + i < speech.length; i++) speech[i0 + i] += x[i] * 0.8;
    const span = { text, start: +t.toFixed(3), end: +(t + x.length / RATE).toFixed(3), voice };
    truth.phrases.push(span);
    if (kind === 'p') truth.profane.push(span);
    if (kind === 'c') truth.clean.push(span);
    t += x.length / RATE + GAP;
  }
  const last = truth.phrases[truth.phrases.length - 1];
  if (last.end > (SCRIPT.find((s) => s[1] > t0)?.[1] ?? DUR)) throw new Error(`line at ${t0} overruns into the next (ends ${last.end})`);
}

const stereo = new Float32Array(speech.length * 2);
for (let i = 0; i < speech.length; i++) stereo[2 * i] = stereo[2 * i + 1] = speech[i];
writeFileSync(`${DIR}/speech.f32`, Buffer.from(stereo.buffer));
writeFileSync(`${DIR}/truth.json`, JSON.stringify(truth, null, 1));

if (!existsSync('/tmp/mr/music45.f32')) throw new Error('run tests/e2e/make-media.sh first');
execFileSync('ffmpeg', [
  '-loglevel', 'error', '-y',
  '-f', 'f32le', '-ar', String(RATE), '-ac', '2', '-i', `${DIR}/speech.f32`,
  '-f', 'f32le', '-ar', String(RATE), '-ac', '2', '-i', '/tmp/mr/music45.f32',
  '-filter_complex', '[1:a]volume=0.8[m];[0:a][m]amix=inputs=2:normalize=0',
  '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-f', 'webm', '-dash', '1', '-cluster_time_limit', '2000',
  '/tmp/mr/site/audio_prof.webm',
]);
// 16 kHz mono clean speech, for the ASR benchmark
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'f32le', '-ar', String(RATE), '-ac', '2', '-i', `${DIR}/speech.f32`, '-ar', '16000', '-ac', '1', '-f', 'f32le', `${DIR}/speech16k.f32`]);
execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-i', '/tmp/mr/site/audio_prof.webm', '-ar', '16000', '-ac', '1', '-f', 'f32le', `${DIR}/mix16k.f32`]);
console.log(`profanity fixture ready: ${truth.profane.length} profane, ${truth.clean.length} look-alikes`);
for (const p of truth.phrases) console.log(`  ${p.start.toFixed(2).padStart(6)}–${p.end.toFixed(2).padEnd(6)} ${p.text}`);
