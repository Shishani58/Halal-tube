import { DEFAULT_SETTINGS, type PageStatus, type Settings } from '../shared/messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const enabledEl = $<HTMLInputElement>('enabled');
const badgeEl = $<HTMLInputElement>('showBadge');
const modeEls = Array.from(document.querySelectorAll<HTMLInputElement>('input[name=mode]'));
const blurEls = (['blur', 'blurWomen', 'blurStrict'] as const).map((k) => [k, $<HTMLInputElement>(k)] as const);

async function load(): Promise<void> {
  const s = (await chrome.storage.sync.get(DEFAULT_SETTINGS)) as Settings;
  enabledEl.checked = s.enabled;
  badgeEl.checked = s.showBadge;
  for (const m of modeEls) m.checked = m.value === s.mode;
  for (const [k, el] of blurEls) el.checked = s[k];
}

enabledEl.addEventListener('change', () => void chrome.storage.sync.set({ enabled: enabledEl.checked }));
badgeEl.addEventListener('change', () => void chrome.storage.sync.set({ showBadge: badgeEl.checked }));
for (const m of modeEls) m.addEventListener('change', () => m.checked && void chrome.storage.sync.set({ mode: m.value }));
for (const [k, el] of blurEls) el.addEventListener('change', () => void chrome.storage.sync.set({ [k]: el.checked }));

const VISION_TEXT = {
  off: 'Выключено',
  'no-video': 'Видео не найдено',
  checking: 'Проверяется…',
  hidden: 'Размыт',
  clear: 'Чистый',
} as const;

const STATE_TEXT: Record<PageStatus['state'], string> = {
  disabled: 'Выключено',
  'no-video': 'Видео не найдено',
  waiting: 'Обработка…',
  clean: 'Играет без музыки',
  paused: 'Пауза (готово)',
  suspended: 'Нажмите на страницу',
};

async function refresh(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  let st: PageStatus | null = null;
  if (tab?.id !== undefined) {
    try {
      st = (await chrome.tabs.sendMessage(tab.id, { type: 'get-status' })) as PageStatus | null;
    } catch {
      st = null;
    }
  }
  const set = (id: string, text: string) => ($(id).textContent = text);
  if (!st) {
    set('st-state', tab?.url?.includes('youtube') ? 'Обновите страницу' : 'Откройте YouTube');
    set('st-model', '—');
    set('st-speed', '—');
    set('st-ahead', '—');
    set('vs-state', '—');
    set('vs-ahead', '—');
    return;
  }
  const vis = st.vision;
  const vw = vis?.status;
  set(
    'vs-state',
    !vis ? '—' : vw?.model === 'error' ? `Ошибка: ${vw.error ?? ''}` : vw?.model === 'loading' && vis.state !== 'off' ? 'Загрузка модели…' : VISION_TEXT[vis.state],
  );
  set('vs-ahead', vw && vis?.state !== 'off' ? `${Math.round(vw.ahead)} с${vw.speed > 0 ? ` (${vw.speed.toFixed(0)}× реального времени)` : ''}` : '—');
  set('st-state', STATE_TEXT[st.state] ?? st.state);
  const w = st.worker;
  if (!w) {
    set('st-model', '—');
  } else if (w.model === 'ready') {
    set('st-model', w.backend === 'webgpu' ? 'Готова (GPU)' : 'Готова (CPU, медленно)');
  } else if (w.model === 'error') {
    set('st-model', `Ошибка: ${w.error ?? ''}`);
  } else {
    set('st-model', w.model === 'loading' ? 'Загрузка…' : 'Не загружена');
  }
  set('st-speed', w && w.rtf > 0 ? `${(1 / w.rtf).toFixed(1)}× быстрее реального времени` : '—');
  set('st-ahead', w ? `${Math.round(w.ahead)} с (аудио загружено на ${Math.round(w.inputAhead)} с)` : '—');
}

void load();
void refresh();
setInterval(() => void refresh(), 1000);
