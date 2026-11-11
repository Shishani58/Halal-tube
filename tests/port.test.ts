import { fromMessagePort } from '../src/shared/port';
import { assert, test } from './harness';

const tick = () => new Promise((r) => setTimeout(r, 20));

test('port: messages cross the channel, disconnect reaches the other side once', async () => {
  const ch = new MessageChannel();
  const a = fromMessagePort(ch.port1 as unknown as MessagePort);
  const b = fromMessagePort(ch.port2 as unknown as MessagePort);
  const got: unknown[] = [];
  let bGone = 0;
  let aGone = 0;
  b.onMessage.addListener((m) => got.push(m));
  b.onDisconnect.addListener(() => bGone++);
  a.onDisconnect.addListener(() => aGone++);
  a.postMessage({ type: 'x', n: 1 });
  a.postMessage({ type: 'x', n: 2 });
  await tick();
  assert(JSON.stringify(got) === '[{"type":"x","n":1},{"type":"x","n":2}]', JSON.stringify(got));
  a.disconnect();
  a.disconnect();
  await tick();
  assert(aGone === 1, `own disconnect fired ${aGone} times`);
  assert(bGone === 1, `peer disconnect fired ${bGone} times`);
  assert(got.length === 2, 'the bye message is not delivered as data');
  ch.port1.close();
  ch.port2.close();
});
