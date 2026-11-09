import { ReplayLog } from '../src/content/replay-log';
import { assert, test } from './harness';

const names = (l: ReplayLog<string>) => l.all.map((e) => e.wire).join(',');

test('ReplayLog: media evicted by size, setup kept; orphan init segments dropped', () => {
  const l = new ReplayLog<string>(100);
  l.add({ wire: 'sb', session: 1, sb: 1, bytes: 0, pinned: true });
  l.add({ wire: 'i1', session: 1, sb: 1, bytes: 10, pinned: true, init: true });
  l.add({ wire: 'm1', session: 1, sb: 1, bytes: 60, pinned: false });
  // re-appended init (seek) while m1 is still there: both inits needed
  l.add({ wire: 'i2', session: 1, sb: 1, bytes: 10, pinned: true, init: true });
  assert(names(l) === 'sb,i1,m1,i2', names(l));
  // another init right after i2, no media in between: i2 is useless
  l.add({ wire: 'i3', session: 1, sb: 1, bytes: 10, pinned: true, init: true });
  assert(names(l) === 'sb,i1,m1,i3', names(l));
  // m2 pushes the log over 100 bytes: m1 goes, pinned entries stay
  l.add({ wire: 'm2', session: 1, sb: 1, bytes: 60, pinned: false });
  assert(names(l) === 'sb,i1,i3,m2', names(l));
  // next init: i1 no longer has media after it
  l.add({ wire: 'i4', session: 1, sb: 1, bytes: 10, pinned: true, init: true });
  assert(names(l) === 'sb,i3,m2,i4', names(l));
  l.clearMedia();
  assert(names(l) === 'sb,i3,i4', names(l));
});

test('ReplayLog: keeps only the last sessions; inits of other SourceBuffers untouched', () => {
  const l = new ReplayLog<string>(1000, 2);
  l.add({ wire: 'a-i', session: 1, sb: 1, bytes: 1, pinned: true, init: true });
  l.add({ wire: 'a-v', session: 1, sb: 2, bytes: 1, pinned: true, init: true });
  l.add({ wire: 'a-i2', session: 1, sb: 1, bytes: 1, pinned: true, init: true });
  assert(names(l) === 'a-v,a-i2', names(l));
  l.add({ wire: 'b', session: 2, sb: 3, bytes: 1, pinned: false });
  l.add({ wire: 'c', session: 3, sb: 4, bytes: 1, pinned: false });
  assert(names(l) === 'b,c', names(l));
});
