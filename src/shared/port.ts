/**
 * Channel between a page's bridge content script and the processor.
 *  - Chrome: a runtime Port to the offscreen document (JSON-serialized messages).
 *  - Safari (no offscreen documents): a MessageChannel to a hidden extension iframe inside the
 *    page, which runs the same offscreen.ts. The iframe lives and dies with the page.
 * Both carry the same wire messages (src/shared/wire.ts), so the processor code is shared.
 */

export interface PortLike {
  postMessage(m: unknown): void;
  onMessage: { addListener(fn: (m: never) => void): void };
  onDisconnect: { addListener(fn: () => void): void };
  disconnect(): void;
}

declare const __SAFARI__: boolean;

/** Wraps one end of a MessageChannel as a runtime-Port-like object ('bye' stands in for onDisconnect). */
export function fromMessagePort(mp: MessagePort): PortLike {
  const onMsg: Array<(m: never) => void> = [];
  const onDisc: Array<() => void> = [];
  let closed = false;
  const end = (): void => {
    if (closed) return;
    closed = true;
    for (const f of onDisc) f();
  };
  mp.onmessage = (e: MessageEvent) => {
    if ((e.data as { mr?: string } | null)?.mr === 'bye') end();
    else for (const f of onMsg) f(e.data as never);
  };
  return {
    postMessage: (m) => mp.postMessage(m),
    onMessage: { addListener: (f) => void onMsg.push(f) },
    onDisconnect: { addListener: (f) => void onDisc.push(f) },
    disconnect: () => {
      if (closed) return;
      try {
        mp.postMessage({ mr: 'bye' });
      } catch {
        /* peer gone */
      }
      mp.close();
      end();
    },
  };
}

let frame: Promise<HTMLIFrameElement> | null = null;
/**
 * Secret shared with the processor frame right after it loads. The frame sits in the page's DOM, so page
 * scripts could otherwise open channels to it; only connections that carry this key are accepted.
 */
let frameKey = '';

function processorFrame(): Promise<HTMLIFrameElement> {
  frame ??= new Promise((resolve, reject) => {
    const f = document.createElement('iframe');
    f.src = chrome.runtime.getURL('processor/offscreen.html');
    // not display:none: hidden frames get throttled harder, and the processor needs the GPU
    f.style.cssText = 'position:fixed;width:1px;height:1px;border:0;opacity:0;pointer-events:none;left:0;top:0';
    f.setAttribute('aria-hidden', 'true');
    f.onload = () => {
      frameKey = crypto.randomUUID();
      f.contentWindow!.postMessage({ mr: 'init', key: frameKey }, '*');
      resolve(f);
    };
    f.onerror = () => reject(new Error('processor frame failed to load'));
    (document.documentElement ?? document).appendChild(f);
  });
  frame.catch(() => {
    frame = null; // try again on the next connect
  });
  return frame;
}

/** Opens the channel named 'mr-proc' (audio) or 'mr-vis' (frames) to the processor. */
export async function connectProcessor(name: 'mr-proc' | 'mr-vis'): Promise<PortLike> {
  if (__SAFARI__) {
    const f = await processorFrame();
    const ch = new MessageChannel();
    f.contentWindow!.postMessage({ mr: 'connect', name, key: frameKey }, '*', [ch.port2]);
    return fromMessagePort(ch.port1);
  }
  await chrome.runtime.sendMessage({ type: 'ensure-offscreen' });
  return chrome.runtime.connect({ name }) as unknown as PortLike;
}
