import { DEFAULT_SETTINGS, type Settings } from './shared/messages';

async function refreshBadge(): Promise<void> {
  const s = (await chrome.storage.sync.get(DEFAULT_SETTINGS)) as Settings;
  try {
    await chrome.action.setBadgeBackgroundColor({ color: '#0f9d76' });
    await chrome.action.setBadgeText({ text: s.enabled ? 'ON' : '' });
  } catch {
    /* no toolbar badge here (Safari on iPhone) */
  }
}

chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.sync.get(null);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...s });
  await refreshBadge();
});

/** Keyboard shortcuts (chrome://extensions/shortcuts): flip a switch the popup also shows. */
chrome.commands?.onCommand.addListener(async (command) => {
  const s = (await chrome.storage.sync.get(DEFAULT_SETTINGS)) as Settings;
  if (command === 'toggle-enabled') await chrome.storage.sync.set({ enabled: !s.enabled });
  else if (command === 'toggle-blur') await chrome.storage.sync.set({ blur: !s.blur });
});

chrome.runtime.onStartup.addListener(() => void refreshBadge());
chrome.storage.onChanged.addListener((_c, area) => {
  if (area === 'sync') void refreshBadge();
});

// ───────────── offscreen processor (WebGPU model + decoding), shared by all tabs ─────────────
let creating: Promise<void> | null = null;
async function ensureOffscreen(): Promise<void> {
  const url = chrome.runtime.getURL('processor/offscreen.html');
  const existing = await chrome.runtime.getContexts({ contextTypes: [chrome.runtime.ContextType.OFFSCREEN_DOCUMENT], documentUrls: [url] });
  if (existing.length) return;
  if (!creating) {
    creating = chrome.offscreen
      .createDocument({
        url: 'processor/offscreen.html',
        reasons: [chrome.offscreen.Reason.WORKERS],
        justification: 'Runs the voice/music separation model on audio, and the frame classifier for blurring on video, of the video being watched.',
      })
      .finally(() => {
        creating = null;
      });
  }
  await creating;
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type !== 'ensure-offscreen') return false;
  ensureOffscreen().then(
    () => sendResponse({ ok: true }),
    (e) => sendResponse({ ok: false, error: String(e) }),
  );
  return true;
});
