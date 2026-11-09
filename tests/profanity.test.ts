import { applyCensor, padAndMerge, spanWeight, toMono16k, uncoveredSpeech } from '../src/core/censor';
import { findProfanity, isProfane, normalizeWord } from '../src/core/profanity';
import { assert, test } from './harness';

const RU_BAD = [
  // хуй
  'хуй', 'Хуй,', 'хуя', 'нахуя', 'нахуй', 'похуй', 'хуйня', 'хуёвый', 'хуево', 'охуеть', 'охуенно', 'ахуеть', 'нихуя', 'дохуя', 'хуесос', 'хуило', 'схуяли', 'охуительный', 'захуярить',
  // пизд
  'пизда', 'пиздец', 'Пиздец!', 'спиздил', 'распиздяй', 'пиздёж', 'опиздинеть', 'пиздато',
  // еб / ёб
  'ебать', 'ёбаный', 'ебаный', 'ебанутый', 'ебло', 'ебало', 'еблан', 'ебля', 'ебучий', 'ебёт', 'ебут', 'ебись', 'ёб', 'ебашить',
  'заебал', 'заебись', 'заёбанный', 'наебал', 'наебнулся', 'выебон', 'выебываться', 'уебок', 'уёбище', 'доебался', 'поебать', 'поебень',
  'приебался', 'проебал', 'переебать', 'недоебанный', 'съебался', 'съёбывай', 'отъебись', 'подъебка', 'разъебай', 'въебать', 'объебос', 'долбоёб', 'долбоеб', 'мозгоёб',
  'хитровыебанный', 'остоебенило',
  // бля
  'бля', 'Бля!', 'блядь', 'блять', 'блядство', 'выблядок', 'блядина',
  // сука (insult forms)
  'сука', 'Сука!', 'суки', 'суку', 'сучка', 'сучара', 'сукин',
  // others
  'мудак', 'мудила', 'мудачьё', 'мудозвон', 'пидор', 'пидар', 'пидорас', 'пидр', 'педик', 'педераст', 'залупа', 'залупаться', 'гандон', 'гондон', 'шлюха', 'шлюхи',
  'манда', 'хер', 'херня', 'нахер', 'похер', 'херово', 'нихера',
  // spelling tricks
  'xуй', 'пиздa', 'б**дь', 'ёб-твою-мать',
  // English in Cyrillic (Whisper in Russian mode)
  'фак', 'факинг', 'мазафака', 'мазерфакер',
];

const RU_GOOD = [
  'небо', 'нёбо', 'хлеб', 'хлебать', 'требовать', 'колебать', 'колебаться', 'ребёнок', 'себе', 'тебе', 'учебник', 'Глеб', 'лебедь', 'мебель', 'зебра', 'гребень', 'щебень', 'погребение', 'вебинар', 'жеребец', 'теребить', 'ребро',
  'стебаться', 'постебаться', 'стёб', 'убедить', 'пребывать', 'перебить',
  'тихую', 'сухую', 'плохую', 'глухую', 'бухую', 'страхую', 'застрахуйте', 'ухудшить', 'хуже', 'худой', 'художник', 'хутор', 'выхухоль', 'хулиган', 'Хуан',
  'сук', 'сукно', 'сукровица', 'сучок', 'сучья', 'сутки',
  'бляха', 'бляшка', 'блюдо', 'блин',
  'мудрый', 'мудрость', 'пиджак', 'педикюр', 'педиатр', 'педагог',
  'мандарин', 'мандат', 'мандолина', 'Херсон', 'херувим', 'херес', 'гандбол', 'шлюз', 'шлюпка', 'залп', 'Лупа',
  'оскорблять', 'потребовать', 'употреблять', 'хлебнуть', 'колебание', 'Ебург',
  'факт', 'факел', 'факультет', 'факс', 'фактор',
];

const EN_BAD = [
  'fuck', 'Fuck!', 'fucking', 'fuckin', 'motherfucker', 'clusterfuck', 'fucked', 'f***', 'f***ing', 'fck',
  'shit', 'bullshit', 'shitty', 'Shit.', 'horseshit', 'bitch', 'bitches', 'son-of-a-bitch', 'cunt', 'cunts', 'asshole', 'assholes', 'dumbass', 'jackass',
  'dick', 'dickhead', 'cocksucker', 'bastard', 'whore', 'slut', 'twat', 'wanker', 'pussy', 'faggot', 'bollocks', 's**t',
];

const EN_GOOD = [
  'ass', 'class', 'pass', 'bass', 'assume', 'assassin', 'passage', 'massive', 'cocktail', 'peacock', 'cockpit', 'Dick', 'Dickens', 'Dickinson', 'dictionary', 'Benedict', 'addict',
  'Scunthorpe', 'shiitake', 'mishit', 'Fukushima', 'Fukuoka', 'bitcoin', 'bastion', 'pussycat', 'title', 'analysis', 'hello', 'weather', 'shift', 'shirt', 'fun', 'duck', 'luck', 'puck',
];

test('profanity: Russian мат by roots, no false positives on look-alikes', () => {
  const missed = RU_BAD.filter((w) => !isProfane(w));
  assert(missed.length === 0, `missed: ${missed.join(', ')}`);
  const wrong = RU_GOOD.filter((w) => isProfane(w));
  assert(wrong.length === 0, `false positives: ${wrong.join(', ')}`);
});

test('profanity: English, no false positives on look-alikes and names', () => {
  const missed = EN_BAD.filter((w) => !isProfane(w));
  assert(missed.length === 0, `missed: ${missed.join(', ')}`);
  const wrong = EN_GOOD.filter((w) => isProfane(w));
  assert(wrong.length === 0, `false positives: ${wrong.join(', ')}`);
});

test('profanity: normalization and word lists from ASR output', () => {
  assert(normalizeWord(' Ёбаный,') === 'ебаный', 'ё → е, punctuation stripped');
  assert(normalizeWord('  [ __ ]') === '', 'YouTube caption mask is not a word');
  const words = [
    { text: ' What', start: 0, end: 0.2 },
    { text: ' the', start: 0.2, end: 0.3 },
    { text: ' fuck?', start: 0.3, end: 0.6 },
    { text: ' Это', start: 1, end: 1.2 },
    { text: ' небо', start: 1.2, end: 1.5 },
    { text: ' пиздец.', start: 1.5, end: 2 },
  ];
  const hits = findProfanity(words);
  assert(hits.length === 2 && hits[0].norm === 'fuck' && hits[1].norm === 'пиздец', `hits ${JSON.stringify(hits)}`);
});

test('censor: spans are padded, merged and weighted with short raised-cosine fades', () => {
  const m = padAndMerge(
    [
      { start: 1, end: 1.2 },
      { start: 1.25, end: 1.4 }, // within 2×pad → merged
      { start: 3, end: 3.3 },
    ],
    0.06,
  );
  assert(m.length === 2, `merged count ${m.length}`);
  assert(Math.abs(m[0].start - 0.94) < 1e-9 && Math.abs(m[0].end - 1.46) < 1e-9, `first ${JSON.stringify(m[0])}`);
  const sp = { start: 1, end: 2 };
  assert(spanWeight(0.999, sp, 0.01) === 0 && spanWeight(2.001, sp, 0.01) === 0, 'zero outside');
  assert(spanWeight(1.5, sp, 0.01) === 1, 'one inside');
  assert(Math.abs(spanWeight(1.005, sp, 0.01) - 0.5) < 1e-6, 'half way through the fade');
  assert(spanWeight(1.01, sp, 0.01) === 1, 'fade is 10 ms');
});

function tone(n: number, rate: number, hz: number, amp: number): Float32Array {
  return Float32Array.from({ length: n }, (_, i) => amp * Math.sin((2 * Math.PI * hz * i) / rate));
}
function rmsOf(x: Float32Array, a: number, b: number): number {
  let s = 0;
  for (let i = a; i < b; i++) s += x[i] * x[i];
  return Math.sqrt(s / Math.max(1, b - a));
}

test('censor: mute silences word + pads, leaves the rest untouched', () => {
  const R = 44100;
  const t0 = 10; // tile starts at media time 10 s
  const L = tone(R * 2, R, 220, 0.3);
  const Rt = tone(R * 2, R, 330, 0.3);
  const L0 = L.slice();
  const word = { start: 10.5, end: 10.8 };
  const spans = applyCensor([L, Rt], R, t0, [word], { mode: 'mute', pad: 0.06 });
  assert(spans.length === 1 && Math.abs(spans[0].start - 10.44) < 1e-9 && Math.abs(spans[0].end - 10.86) < 1e-9, `span ${JSON.stringify(spans)}`);
  const i = (t: number) => Math.round((t - t0) * R);
  assert(rmsOf(L, i(10.45), i(10.85)) === 0 && rmsOf(Rt, i(10.45), i(10.85)) === 0, 'word and most of the pad are silent');
  let maxDiff = 0;
  for (let k = 0; k < L.length; k++) if (k < i(10.44) - 1 || k > i(10.86) + 1) maxDiff = Math.max(maxDiff, Math.abs(L[k] - L0[k]));
  assert(maxDiff === 0, `outside the span untouched (max diff ${maxDiff})`);
  // the fade is smooth: no step bigger than the signal's own slope allows
  let maxStep = 0;
  for (let k = i(10.43); k < i(10.46); k++) maxStep = Math.max(maxStep, Math.abs(L[k + 1] - L[k]));
  assert(maxStep < 0.02, `no click at the fade (max step ${maxStep.toFixed(4)})`);
});

test('censor: default padding is wider before the word (recognized starts run late)', () => {
  const R = 8000;
  const L = new Float32Array(R * 2).fill(0.2);
  const [sp] = applyCensor([L], R, 0, [{ start: 1, end: 1.3 }], { mode: 'mute' });
  assert(Math.abs(sp.start - 0.9) < 1e-9 && Math.abs(sp.end - 1.38) < 1e-9, `default span ${JSON.stringify(sp)}`);
});

test('censor: beep replaces the word at speech loudness, phase-continuous across tiles', () => {
  const R = 44100;
  const amp = 0.2;
  const speech = () => tone(R * 2, R, 180, amp); // RMS 0.141
  const A = [speech(), speech()];
  const word = { start: 11.7, end: 12.3 }; // crosses the tile seam at 12 s
  applyCensor(A, R, 10, [word], { mode: 'beep' });
  const B = [speech(), speech()];
  applyCensor(B, R, 12, [word], { mode: 'beep' });
  const i = (t: number, t0: number) => Math.round((t - t0) * R);
  const r = rmsOf(A[0], i(11.75, 10), i(12, 10));
  assert(Math.abs(r - amp / Math.SQRT2) / (amp / Math.SQRT2) < 0.05, `beep RMS ${r.toFixed(3)} ≈ speech RMS ${(amp / Math.SQRT2).toFixed(3)}`);
  // 1 kHz: count zero crossings over 0.2 s → ~400
  let zc = 0;
  for (let k = i(11.75, 10); k < i(11.95, 10); k++) if (A[0][k] <= 0 !== A[0][k + 1] <= 0) zc++;
  assert(Math.abs(zc - 400) <= 4, `beep frequency (zero crossings ${zc})`);
  // seam: last sample of tile A and first of tile B continue the same sine
  const last = A[0][A[0].length - 1];
  const first = B[0][0];
  const expectStep = 2 * Math.PI * 1000 * (amp * Math.SQRT2 / Math.SQRT2) / R; // max slope of the beep per sample
  assert(Math.abs(first - last) <= expectStep * 1.5 + 1e-3, `no jump at the tile seam (${last.toFixed(4)} → ${first.toFixed(4)})`);
});

test('censor: beep level follows the word loudness, clamped for silence', () => {
  const R = 16000;
  const quiet = [tone(R, R, 200, 0.05), tone(R, R, 200, 0.05)];
  applyCensor(quiet, R, 0, [{ start: 0.3, end: 0.6 }], { mode: 'beep' });
  const r = rmsOf(quiet[0], Math.round(0.35 * R), Math.round(0.55 * R));
  assert(Math.abs(r - 0.05 / Math.SQRT2) < 0.006, `quiet word → quiet beep (${r.toFixed(3)})`);
  const silent = [new Float32Array(R), new Float32Array(R)];
  applyCensor(silent, R, 0, [{ start: 0.3, end: 0.6 }], { mode: 'beep' });
  assert(rmsOf(silent[0], Math.round(0.35 * R), Math.round(0.55 * R)) > 0.01, 'silent span still gets an audible beep');
});

test('censor: speech not covered by recognized words is measured (second-language check)', () => {
  const R = 16000;
  const a = new Float32Array(R * 6);
  const speak = (t0: number, t1: number) => {
    for (let i = Math.round(t0 * R); i < Math.round(t1 * R); i++) a[i] = 0.3 * Math.sin(i * 0.2);
  };
  speak(0.5, 2); // recognized
  speak(3, 4.5); // not recognized (other language)
  const words = [{ start: 0.6, end: 1.9 }];
  const gap = uncoveredSpeech(a, R, words);
  assert(Math.abs(gap - 1.5) < 0.1, `uncovered ${gap.toFixed(2)} s ≈ 1.5 s`);
  assert(uncoveredSpeech(a, R, [...words, { start: 3.1, end: 4.4 }]) < 0.05, 'all covered');
});

test('censor: 16 kHz mono downmix keeps speech band, rejects aliasing', () => {
  const R = 48000;
  const low = tone(R, R, 1000, 0.5);
  const high = tone(R, R, 12000, 0.5); // above 8 kHz: must not fold back to 4 kHz
  const a = toMono16k(low, low, R);
  const b = toMono16k(high, high, R);
  assert(a.length === 16000, `length ${a.length}`);
  assert(Math.abs(rmsOf(a, 200, 15800) - 0.5 / Math.SQRT2) < 0.01, 'passband level kept');
  assert(rmsOf(b, 200, 15800) < 0.005, `alias rejected (${rmsOf(b, 200, 15800).toFixed(4)})`);
});
