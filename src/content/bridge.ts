/**
 * ISOLATED-world content script: injects the processor iframe, relays settings from
 * chrome.storage to the MAIN-world script, and answers popup status queries.
 */
import { DEFAULT_SETTINGS, MSG_NS, PROC_IFRAME_ID, type PageStatus, type Settings } from '../shared/messages';

let settings: Settings = { ...DEFAULT_SETTINGS };
let lastStatus: PageStatus | null = null;

function pushSettings(): void {
  window.postMessage({ ns: MSG_NS, from: 'bridge', kind: 'settings', settings }, '*');
}

function ensureIframe(): void {
  if (document.getElementById(PROC_IFRAME_ID)) return;
  const root = document.documentElement;
  if (!root) return;
  const f = document.createElement('iframe');
  f.id = PROC_IFRAME_ID;
  f.src = chrome.runtime.getURL('processor/processor.html');
  f.setAttribute('aria-hidden', 'true');
  f.tabIndex = -1;
  Object.assign(f.style, {
    position: 'fixed',
    width: '1px',
    height: '1px',
    left: '-10px',
    top: '-10px',
    border: '0',
    opacity: '0',
    pointerEvents: 'none',
  });
  root.appendChild(f);
}

chrome.storage.sync.get(DEFAULT_SETTINGS as unknown as Record<string, unknown>, (s) => {
  settings = { ...DEFAULT_SETTINGS, ...(s as unknown as Settings) };
  pushSettings();
});

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'sync') return;
  let changed = false;
  for (const [k, v] of Object.entries(changes)) {
    if (k in settings) {
      (settings as unknown as Record<string, unknown>)[k] = v.newValue;
      changed = true;
    }
  }
  if (changed) pushSettings();
});

window.addEventListener('message', (e: MessageEvent) => {
  if (e.source !== window) return;
  const d = e.data as { ns?: string; from?: string; kind?: string; status?: PageStatus };
  if (!d || d.ns !== MSG_NS || d.from !== 'main') return;
  if (d.kind === 'get-settings') pushSettings();
  else if (d.kind === 'status' && d.status) lastStatus = d.status;
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'get-status') return false;
  const hasVideo = lastStatus && lastStatus.state !== 'no-video';
  if (hasVideo) {
    sendResponse(lastStatus);
    return false;
  }
  if (window === window.top) {
    // let frames that actually play a video answer first
    setTimeout(() => sendResponse(lastStatus), 150);
    return true;
  }
  return false;
});

ensureIframe();
// YouTube is an SPA and rarely touches <html> children, but re-check cheaply.
setInterval(ensureIframe, 3000);
