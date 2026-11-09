import { captionWords, parseJson3, wordsIn } from '../src/core/captions';
import { findProfanity } from '../src/core/profanity';
import { assert, test } from './harness';

const near = (a: number, b: number, eps = 1e-6) => Math.abs(a - b) < eps;

// Shape of a YouTube auto-generated (ASR) json3 track: one word per segment, offsets from the
// line start, roll-up lines overlapping in time, newline-only "aAppend" events in between.
const ASR = {
  wireMagic: 'pb3',
  events: [
    { tStartMs: 0, dDurationMs: 200000, id: 1, wpWinPosId: 1 },
    { tStartMs: 3760, dDurationMs: 4280, wWinId: 1, segs: [{ utf8: 'Я' }, { utf8: ' думаю,', tOffsetMs: 240 }, { utf8: ' блять,', tOffsetMs: 700 }] },
    { tStartMs: 4590, dDurationMs: 10, wWinId: 1, aAppend: 1, segs: [{ utf8: '\n' }] },
    { tStartMs: 4600, dDurationMs: 3880, wWinId: 1, segs: [{ utf8: 'что' }, { utf8: ' [смех]', tOffsetMs: 300 }, { utf8: ' >> всё', tOffsetMs: 900 }] },
  ],
};

test('captions: ASR words get start = line start + offset, end = next word start', () => {
  const w = parseJson3(JSON.stringify(ASR));
  assert(w.map((x) => x.text).join(' ') === 'Я думаю блять что всё', w.map((x) => x.text).join(' '));
  assert(near(w[0].start, 3.76) && near(w[1].start, 4.0) && near(w[2].start, 4.46), JSON.stringify(w));
  assert(near(w[1].end, 4.46), `end at next word: ${w[1].end}`);
  assert(w.every((x) => !x.approx), 'measured timing');
});

test('captions: a word before a pause is not stretched over the silence', () => {
  const w = parseJson3(ASR);
  const bl = w.find((x) => x.text === 'блять')!;
  // next word starts at 4.6 here; long gaps are capped by the length estimate
  assert(bl.end <= 4.6 + 1e-6 && bl.end - bl.start >= 0.12, JSON.stringify(bl));
  const last = w[w.length - 1];
  assert(last.end - last.start < 0.6, `last word capped: ${last.end - last.start}`);
});

test('captions: uploaded tracks spread words over the line and mark them approximate', () => {
  const w = parseJson3({ events: [{ tStartMs: 10000, dDurationMs: 2000, segs: [{ utf8: 'Ну ты и сука, конечно' }] }] });
  assert(w.length === 5 && w.every((x) => x.approx), JSON.stringify(w));
  const s = w.find((x) => x.text === 'сука')!;
  assert(s.start > 10 && s.end < 12.3, JSON.stringify(s));
  assert(findProfanity(w).length === 1, 'matcher sees the word');
});

test('captions: speaker marks, sound tags and punctuation are dropped', () => {
  assert(captionWords('>> [музыка] Привет, мир!').join('|') === 'Привет|мир', captionWords('>> [музыка] Привет, мир!').join('|'));
  assert(captionWords('[ __ ]').length === 0, 'censored placeholder carries no word');
});

test('captions: wordsIn finds words overlapping a range', () => {
  const words = Array.from({ length: 1000 }, (_, i) => ({ text: `w${i}`, start: i * 0.5, end: i * 0.5 + 0.4 }));
  const r = wordsIn(words, 100.2, 101.1);
  assert(r.map((x) => x.text).join(',') === 'w200,w201,w202', r.map((x) => x.text).join(','));
  assert(wordsIn([], 0, 10).length === 0, 'empty');
});
