/**
 * Hidden iframe (chrome-extension:// origin) embedded into the video page.
 * Relays messages between the page's MAIN-world script and the processing worker,
 * so heavy work (WASM / WebGPU / WebCodecs) runs outside the page's CSP.
 */
import { MSG_NS, type FromWorker, type ToWorker } from '../shared/messages';

const parentOrigin = location.ancestorOrigins?.[0] ?? '*';
const worker = new Worker(new URL('./worker.js', location.href), { type: 'module' });

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window.parent) return;
  const d = e.data as { ns?: string; msg?: ToWorker };
  if (!d || d.ns !== MSG_NS || !d.msg) return;
  const msg = d.msg;
  worker.postMessage(msg, msg.type === 'append' ? [msg.data] : []);
});

worker.onmessage = (e: MessageEvent<FromWorker>) => {
  const msg = e.data;
  const transfer: Transferable[] = msg.type === 'tile' ? [msg.left.buffer, msg.right.buffer] : [];
  if (msg.type === 'tile' && msg.mixLeft) transfer.push(msg.mixLeft.buffer);
  window.parent.postMessage({ ns: MSG_NS, from: 'processor', msg }, parentOrigin, transfer);
};

worker.onerror = (e) => {
  console.error('[music-remover] worker error', e.message);
  window.parent.postMessage(
    {
      ns: MSG_NS,
      from: 'processor',
      msg: {
        type: 'status',
        status: { model: 'error', backend: '-', error: e.message, rtf: 0, tilesDone: 0, ahead: 0, inputAhead: 0 },
      },
    },
    parentOrigin,
  );
};
