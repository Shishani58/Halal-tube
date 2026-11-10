import { assert, test } from './harness';
import { HOLD_GIVE_UP_MS, HoldGate, type HoldInput, type HoldPart } from '../src/core/hold';

const part = (kind: HoldPart['kind'], now: boolean, ahead = 0): HoldPart => ({ kind, now, ahead });
const base: HoldInput = { now: 0, enabled: true, paused: false, ended: false, time: 10, remaining: 100, parts: [] };
const at = (o: Partial<HoldInput>): HoldInput => ({ ...base, ...o });

test('hold: playing video with a part not ready is paused, then resumed with a reserve', () => {
  const g = new HoldGate();
  assert(g.update(at({ parts: [part('audio', false)] })) === 'pause', 'pause when the sound is not ready');
  assert(g.held && g.waiting.join() === 'audio', 'waiting for audio');
  // we paused it: now paused, still not ready
  assert(g.update(at({ now: 100, paused: true, parts: [part('audio', false)] })) === 'none', 'stays held');
  // ready under the playhead but no reserve yet: keep holding (no stutter)
  assert(g.update(at({ now: 200, paused: true, parts: [part('audio', true, 1)] })) === 'none' && g.held, 'no reserve yet');
  assert(g.update(at({ now: 300, paused: true, parts: [part('audio', true, 3.5)] })) === 'resume' && !g.held, 'resume with 3 s ahead');
});

test('hold: both sound and blur must be ready', () => {
  const g = new HoldGate();
  assert(g.update(at({ parts: [part('audio', true, 9), part('blur', false)] })) === 'pause', 'blur not ready → pause');
  assert(g.waiting.join() === 'blur', 'only blur is awaited');
  assert(g.update(at({ paused: true, parts: [part('audio', true, 9), part('blur', true, 4)] })) === 'resume', 'both ready → resume');
});

test('hold: a video the user paused is left alone', () => {
  const g = new HoldGate();
  assert(g.update(at({ paused: true, parts: [part('audio', false)] })) === 'none' && !g.held, 'no hold on a paused video');
  assert(g.update(at({ ended: true, parts: [part('audio', false)] })) === 'none', 'no hold at the end');
});

test('hold: play pressed while held pauses again', () => {
  const g = new HoldGate();
  g.update(at({ parts: [part('blur', false)] }));
  assert(g.update(at({ now: 50, paused: false, parts: [part('blur', false)] })) === 'pause', 'pause again');
});

test('hold: reserve shrinks near the end of the video', () => {
  const g = new HoldGate();
  g.update(at({ remaining: 1, parts: [part('audio', false)] }));
  assert(g.update(at({ paused: true, remaining: 1, parts: [part('audio', true, 1)] })) === 'resume', '1 s left, 1 s ready is enough');
});

test('hold: switched off or nothing to wait for releases the video', () => {
  const g = new HoldGate();
  g.update(at({ parts: [part('audio', false)] }));
  assert(g.update(at({ paused: true, enabled: false, parts: [part('audio', false)] })) === 'resume' && !g.held, 'setting turned off');
  g.update(at({ parts: [part('audio', false)] }));
  assert(g.update(at({ paused: true, parts: [] })) === 'resume', 'no parts (error, ad) → resume');
  assert(g.update(at({ paused: true, parts: [] })) === 'none', 'and only once');
});

test('hold: gives up after a long wait, until things are ready again', () => {
  const g = new HoldGate();
  g.update(at({ now: 0, parts: [part('audio', false)] }));
  assert(g.update(at({ now: HOLD_GIVE_UP_MS - 1, paused: true, parts: [part('audio', false)] })) === 'none', 'still waiting');
  assert(g.update(at({ now: HOLD_GIVE_UP_MS + 1, paused: true, parts: [part('audio', false)] })) === 'resume' && g.gaveUp, 'gave up');
  assert(g.update(at({ now: HOLD_GIVE_UP_MS + 2, parts: [part('audio', false)] })) === 'none', 'not held again while still unready');
  g.update(at({ now: HOLD_GIVE_UP_MS + 3, parts: [part('audio', true, 5)] }));
  assert(g.update(at({ now: HOLD_GIVE_UP_MS + 4, parts: [part('audio', false)] })) === 'pause', 'holds again after a ready moment');
});

test('hold: a seek restarts the give-up timer', () => {
  const g = new HoldGate();
  g.update(at({ now: 0, time: 10, parts: [part('audio', false)] }));
  g.update(at({ now: HOLD_GIVE_UP_MS - 10, paused: true, time: 500, parts: [part('audio', false)] }));
  assert(g.update(at({ now: HOLD_GIVE_UP_MS + 5, paused: true, time: 500, parts: [part('audio', false)] })) === 'none', 'timer restarted by the seek');
});
