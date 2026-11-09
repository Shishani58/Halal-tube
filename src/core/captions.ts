/**
 * YouTube caption tracks (timedtext "json3") → words with media times, for the profanity filter.
 *
 * Auto-generated (ASR) tracks carry a start time for every word: event.tStartMs + seg.tOffsetMs.
 * A word ends where the next one starts, capped by a length-based estimate so a word before a
 * pause isn't stretched over the silence. Uploaded tracks only time whole lines: words are spread
 * over the line by length and marked approximate (the censor pads them more).
 */
import type { Word } from './profanity';

export interface CaptionWord extends Word {
  /** Timing estimated from the line, not measured per word. */
  approx?: boolean;
}

interface Json3Seg {
  utf8?: string;
  tOffsetMs?: number;
}
interface Json3Event {
  tStartMs?: number;
  dDurationMs?: number;
  aAppend?: number;
  segs?: Json3Seg[];
}

/** Longest a word can plausibly last, seconds (≈ 70 ms per letter + attack/release). */
export function maxWordDuration(text: string): number {
  return Math.min(1.5, 0.15 + 0.07 * [...text].length);
}

/** Speaker marks (">>"), sound tags ("[смех]", "[music]") and punctuation removed; split into words. */
export function captionWords(text: string): string[] {
  return text
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/>>/g, ' ')
    .split(/\s+/)
    .map((w) => w.replace(/^[^\p{L}\p{N}*]+|[^\p{L}\p{N}*]+$/gu, ''))
    .filter((w) => w.length > 0);
}

/** Extra margin on each side of an approximately timed word, seconds. */
export const APPROX_MARGIN = 0.25;

export function parseJson3(src: string | { events?: Json3Event[] }): CaptionWord[] {
  const j = typeof src === 'string' ? (JSON.parse(src) as { events?: Json3Event[] }) : src;
  const events = (j.events ?? []).filter((e) => e.segs && e.segs.length && !e.aAppend && e.tStartMs !== undefined);
  // Word-timed when segments carry offsets (ASR); the first segment of a line has none (= 0).
  const timed = events.some((e) => e.segs!.some((s) => s.tOffsetMs !== undefined));
  const out: CaptionWord[] = [];
  if (timed) {
    // Each segment: one word (sometimes a few) starting at its offset.
    const pieces: { text: string; start: number; lineEnd: number }[] = [];
    for (const e of events) {
      const t0 = e.tStartMs! / 1000;
      const lineEnd = t0 + (e.dDurationMs ?? 0) / 1000;
      for (const s of e.segs!) {
        const text = s.utf8 ?? '';
        if (!captionWords(text).length) continue;
        pieces.push({ text, start: t0 + (s.tOffsetMs ?? 0) / 1000, lineEnd });
      }
    }
    pieces.sort((a, b) => a.start - b.start);
    for (let i = 0; i < pieces.length; i++) {
      const p = pieces[i];
      const next = i + 1 < pieces.length ? pieces[i + 1].start : Infinity;
      const ws = captionWords(p.text);
      const cap = ws.reduce((s, w) => s + maxWordDuration(w), 0);
      const end = Math.max(p.start + 0.12, Math.min(next, p.lineEnd > p.start ? p.lineEnd : Infinity, p.start + cap));
      spread(ws, p.start, end, false, out);
    }
  } else {
    for (const e of events) {
      const t0 = e.tStartMs! / 1000;
      const ws = captionWords(e.segs!.map((s) => s.utf8 ?? '').join(''));
      if (ws.length) spread(ws, t0, t0 + Math.max(0.2, (e.dDurationMs ?? 0) / 1000), true, out);
    }
  }
  return out;
}

/** Words over [start, end] in proportion to their length. */
function spread(ws: string[], start: number, end: number, approx: boolean, out: CaptionWord[]): void {
  const weights = ws.map((w) => [...w].length + 1);
  const total = weights.reduce((a, b) => a + b, 0);
  let t = start;
  for (let i = 0; i < ws.length; i++) {
    const d = ((end - start) * weights[i]) / total;
    const w: CaptionWord = { text: ws[i], start: t, end: t + d };
    if (approx || ws.length > 1) {
      w.approx = true;
      w.start = Math.max(0, w.start - APPROX_MARGIN);
      w.end += APPROX_MARGIN;
    }
    out.push(w);
    t += d;
  }
}

/** Words overlapping [from, to] of a list sorted by start. */
export function wordsIn(words: Word[], from: number, to: number, maxLen = 3): Word[] {
  let lo = 0;
  let hi = words.length;
  const first = from - maxLen; // a word starting this early can't reach `from`
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].start < first) lo = mid + 1;
    else hi = mid;
  }
  const out: Word[] = [];
  for (let i = lo; i < words.length && words[i].start <= to; i++) if (words[i].end >= from) out.push(words[i]);
  return out;
}
