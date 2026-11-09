import { DEFAULT_SETTINGS, type Settings } from './shared/messages';

async function refreshBadge(): Promise<void> {
  const s = (await chrome.storage.sync.get(DEFAULT_SETTINGS)) as Settings;
  await chrome.action.setBadgeBackgroundColor({ color: '#0f9d76' });
  await chrome.action.setBadgeText({ text: s.enabled ? 'ON' : '' });
}

chrome.runtime.onInstalled.addListener(async () => {
  const s = await chrome.storage.sync.get(null);
  await chrome.storage.sync.set({ ...DEFAULT_SETTINGS, ...s });
  await refreshBadge();
});

chrome.runtime.onStartup.addListener(() => void refreshBadge());
chrome.storage.onChanged.addListener((_c, area) => {
  if (area === 'sync') void refreshBadge();
});
