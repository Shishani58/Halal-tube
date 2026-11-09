import { DEFAULT_SETTINGS, type PageStatus, type Settings } from '../shared/messages';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const enabledEl = $<HTMLInputElement>('enabled');
const badgeEl = $<HTMLInputElement>('showBadge');
const modeEls = Array.from(document.querySelectorAll<HTMLInputElement>('input[name=mode]'));
const blurEls = (['blur', 'blurWomen', 'blurStrict'] as const).map((k) => [k, $<HTMLInputElement>(k)] as const);
const musicEl = $<HTMLInputElement>('musicRemoval');
const profEls = Array.from(document.querySelectorAll<HTMLInputElement>('input[name=profanity]'));

async function load(): Promise<void> {
  const s = (await chrome.storage.sync.get(DEFAULT_SETTINGS)) as Settings;
  enabledEl.checked = s.enabled;
  badgeEl.checked = s.showBadge;
  for (const m of modeEls) m.checked = m.value === s.mode;
  for (const [k, el] of blurEls) el.checked = s[k];
  musicEl.checked = s.musicRemoval;
  for (const p of profEls) p.checked = p.value === s.profanity;
  hint(s);
}

/** Warn when both features are off: the extension then leaves the sound alone. */
function hint(s: Pick<Settings, 'musicRemoval' | 'profanity'>): void {
  const el = $('profanity-hint');
  const idle = !s.musicRemoval && s.profanity === 'off';
  el.textContent = idle ? 'Музыка и мат не фильтруются — звук не меняется.' : 'Русский и английский. Речь распознаётся на вашем компьютере.';
  el.classList.toggle('warn', idle);
}

function current(): Pick<Settings, 'musicRemoval' | 'profanity'> {
  return { musicRemoval: musicEl.checked, profanity: (profEls.find((p) => p.checked)?.value ?? 'off') as Settings['profanity'] };
}

enabledEl.addEventListener('change', () => void chrome.storage.sync.set({ enabled: enabledEl.checked }));
badgeEl.addEventListener('change', () => void chrome.storage.sync.set({ showBadge: badgeEl.checked }));
for (const m of modeEls) m.addEventListener('change', () => m.checked && void chrome.storage.sync.set({ mode: m.value }));
for (const [k, el] of blurEls) el.addEventListener('change', () => void chrome.storage.sync.set({ [k]: el.checked }));

musicEl.addEventListener('change', () => {
  hint(current());
  void chrome.storage.sync.set({ musicRemoval: musicEl.checked });
});
for (const p of profEls)
  p.addEventListener('change', () => {
    if (!p.checked) return;
    hint(current());
    void chrome.storage.sync.set({ profanity: p.value });
  });

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
  clean: 'Играет обработанный звук',
  paused: 'Пауза (готово)',
  suspended: 'Нажмите на страницу',
  offline: 'Нет связи с обработчиком — обновите страницу',
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
    $('row-asr').hidden = true;
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
  } else if (!current().musicRemoval) {
    set('st-model', 'Не нужна (музыка не убирается)');
  } else if (w.model === 'ready') {
    set('st-model', w.backend === 'webgpu' ? 'Готова (GPU)' : 'Готова (CPU, медленно)');
  } else if (w.model === 'error') {
    set('st-model', `Ошибка: ${w.error ?? ''}`);
  } else {
    set('st-model', w.model === 'loading' ? 'Загрузка…' : 'Не загружена');
  }
  set('st-speed', w && w.rtf > 0 ? `${(1 / w.rtf).toFixed(1)}× быстрее реального времени` : '—');
  set('st-ahead', w ? `${Math.round(w.ahead)} с (аудио загружено на ${Math.round(w.inputAhead)} с)` : '—');
  const filterOn = current().profanity !== 'off';
  $('row-asr').hidden = !filterOn;
  if (filterOn) set('st-asr', asrText(w));
}

/** Where the profanity filter's words come from, and the recognizer's state. */
function asrText(w: PageStatus['worker']): string {
  if (w?.words === 'captions') return 'По субтитрам YouTube';
  if (w?.words === 'pending') return 'Получаю субтитры…';
  switch (w?.asr) {
    case 'ready':
      return w.asrMs ? `Готово, ${(w.asrMs / 1000).toFixed(1)} с на фрагмент` : 'Готово';
    case 'error':
      return `Ошибка: ${w.asrError ?? ''}`;
    case 'loading':
      return 'Загрузка…';
    default:
      return '—';
  }
}

void load();
void refresh();
setInterval(() => void refresh(), 1000);
