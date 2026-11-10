import { DEFAULT_SETTINGS, type PageStatus, type Settings } from '../shared/messages';
import { clearVideos, countVideos } from '../processor/vision-store';

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const radios = (name: string) => Array.from(document.querySelectorAll<HTMLInputElement>(`input[name=${name}]`));

const enabledEl = $<HTMLInputElement>('enabled');
const badgeEl = $<HTMLInputElement>('showBadge');
const musicEl = $<HTMLInputElement>('musicRemoval');
const blurEl = $<HTMLInputElement>('blur');
const blurWomenEl = $<HTMLInputElement>('blurWomen');
const blurThumbsEl = $<HTMLInputElement>('blurThumbs');
const blurHoverEl = $<HTMLInputElement>('blurHover');
const blurCacheEl = $<HTMLInputElement>('blurCache');
const strengthEl = $<HTMLInputElement>('musicStrength');
const levelEls = radios('blurLevel');
const styleEls = radios('blurStyle');
const modeEls = radios('mode');
const profEls = radios('profanity');
const strictEls = radios('blurStrict');

let s: Settings = { ...DEFAULT_SETTINGS };

function save(patch: Partial<Settings>): void {
  s = { ...s, ...patch };
  render();
  void chrome.storage.sync.set(patch);
}

async function load(): Promise<void> {
  s = (await chrome.storage.sync.get(DEFAULT_SETTINGS)) as Settings;
  enabledEl.checked = s.enabled;
  badgeEl.checked = s.showBadge;
  musicEl.checked = s.musicRemoval;
  blurEl.checked = s.blur;
  blurWomenEl.checked = s.blurWomen;
  blurThumbsEl.checked = s.blurThumbs;
  blurHoverEl.checked = s.blurHover;
  blurCacheEl.checked = s.blurCache;
  strengthEl.value = String(s.musicStrength);
  for (const l of levelEls) l.checked = l.value === s.blurLevel;
  for (const x of styleEls) x.checked = x.value === s.blurStyle;
  for (const m of modeEls) m.checked = m.value === s.mode;
  for (const p of profEls) p.checked = p.value === s.profanity;
  for (const x of strictEls) x.checked = (x.value === '1') === s.blurStrict;
  render();
}

/** Everything that follows from the settings alone (hints, dimmed parts). */
function render(): void {
  document.body.classList.toggle('off', !s.enabled);
  $('off-banner').hidden = s.enabled;
  $('card-blur').classList.toggle('disabled', !s.blur);

  // strength: only without the profanity filter (the original would let muted words through)
  const strengthOff = !s.musicRemoval || s.profanity !== 'off';
  $('field-strength').classList.toggle('disabled', strengthOff);
  strengthEl.disabled = strengthOff;
  $('strength-val').textContent = `${strengthOff ? 100 : s.musicStrength}%`;
  $('strength-hint').textContent = !s.musicRemoval
    ? 'Музыка не убирается.'
    : s.profanity !== 'off'
      ? 'С фильтром мата музыка убирается полностью (иначе мат прозвучит из оригинала).'
      : s.musicStrength >= 100
        ? '100% — только голос. Меньше — часть оригинала остаётся.'
        : s.musicStrength <= 0
          ? '0% — звук как в оригинале.'
          : `Музыка тише, но слышна: оригинал подмешан на ${100 - s.musicStrength}%.`;
  $('row-hover').hidden = !s.blurThumbs;
  $('level-hint').textContent = LEVEL_HINT[s.blurLevel];

  const hint = $('profanity-hint');
  const idle = !s.musicRemoval && s.profanity === 'off';
  hint.textContent = idle ? 'Музыка и мат не фильтруются — звук не меняется.' : 'Русский и английский. Речь распознаётся на вашем компьютере.';
  hint.classList.toggle('warn', idle);
  $('mode-hint').textContent =
    s.mode === 'strict' ? 'Первые секунды тихо, зато музыка и мат не проскочат.' : 'Сразу играет оригинал, обработанный звук подхватывается позже.';
}

const LEVEL_HINT: Record<Settings['blurLevel'], string> = {
  soft: 'Реже ложные размытия: нужно больше подтверждений. Часть женщин на дальних планах может не размыться.',
  normal: 'Баланс: женщина определяется по нескольким кадрам, нагота размывается сразу.',
  strict: 'Размывать при малейшем сомнении: больше лишних размытий, меньше пропусков.',
};

enabledEl.addEventListener('change', () => save({ enabled: enabledEl.checked }));
badgeEl.addEventListener('change', () => save({ showBadge: badgeEl.checked }));
musicEl.addEventListener('change', () => save({ musicRemoval: musicEl.checked }));
blurEl.addEventListener('change', () => save({ blur: blurEl.checked }));
blurWomenEl.addEventListener('change', () => save({ blurWomen: blurWomenEl.checked }));
blurThumbsEl.addEventListener('change', () => save({ blurThumbs: blurThumbsEl.checked }));
blurHoverEl.addEventListener('change', () => save({ blurHover: blurHoverEl.checked }));
blurCacheEl.addEventListener('change', () => save({ blurCache: blurCacheEl.checked }));

/** Videos the classifier remembers (extension storage, shared with the worker). */
async function showCache(): Promise<void> {
  try {
    const n = await countVideos();
    $('cache-count').textContent = String(n);
    ($('cache-clear') as HTMLButtonElement).disabled = n === 0;
  } catch {
    $('cache-count').textContent = '—';
  }
}
$('cache-clear').addEventListener('click', () => {
  void clearVideos().then(showCache, showCache);
});
// storage.sync allows ~120 writes a minute: while dragging only the page-side value follows, the write comes on release
let strengthTimer = 0;
strengthEl.addEventListener('input', () => {
  s = { ...s, musicStrength: Number(strengthEl.value) };
  render();
  clearTimeout(strengthTimer);
  strengthTimer = window.setTimeout(() => void chrome.storage.sync.set({ musicStrength: s.musicStrength }), 250);
});
for (const x of styleEls) x.addEventListener('change', () => x.checked && save({ blurStyle: x.value as Settings['blurStyle'] }));
for (const l of levelEls) l.addEventListener('change', () => l.checked && save({ blurLevel: l.value as Settings['blurLevel'] }));
for (const m of modeEls) m.addEventListener('change', () => m.checked && save({ mode: m.value as Settings['mode'] }));
for (const p of profEls) p.addEventListener('change', () => p.checked && save({ profanity: p.value as Settings['profanity'] }));
for (const x of strictEls) x.addEventListener('change', () => x.checked && save({ blurStrict: x.value === '1' }));

type Dot = '' | 'ok' | 'wait' | 'bad' | 'hidden';
function dot(id: string, kind: Dot): void {
  $(id).className = `dot ${kind}`;
}
const set = (id: string, text: string) => ($(id).textContent = text);

const SOUND: Record<PageStatus['state'], [string, Dot]> = {
  disabled: ['Выключено', ''],
  'no-video': ['Видео не найдено', ''],
  waiting: ['Обрабатывается…', 'wait'],
  clean: ['Играет обработанный звук', 'ok'],
  paused: ['Пауза — звук готов', 'ok'],
  suspended: ['Нажмите на страницу, чтобы включить звук', 'wait'],
  offline: ['Нет связи — обновите страницу', 'bad'],
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
  const onYoutube = !!tab?.url && /youtube(-nocookie)?\.com/.test(tab.url);
  set('hdr-sub', !s.enabled ? 'Выключено' : st ? 'Работает на этой вкладке' : onYoutube ? 'Обновите страницу YouTube' : 'Откройте видео на YouTube');

  if (!st) {
    set('st-state', onYoutube ? 'Обновите страницу' : 'Откройте YouTube');
    dot('sound-dot', '');
    for (const id of ['st-model', 'st-speed', 'st-ahead', 'vs-ahead']) set(id, '—');
    set('vs-state', s.blur ? '—' : 'Выключено');
    dot('blur-dot', '');
    $('row-asr').hidden = true;
    return;
  }

  // ── sound ──
  const soundOff = !s.enabled || (!s.musicRemoval && s.profanity === 'off');
  const [text, kind] = soundOff ? ['Звук не меняется', '' as Dot] : SOUND[st.state] ?? [st.state, ''];
  set('st-state', text);
  dot('sound-dot', kind);
  const w = st.worker;
  if (!w) set('st-model', '—');
  else if (!s.musicRemoval) set('st-model', 'Не нужна (музыка не убирается)');
  else if (w.model === 'ready') set('st-model', w.backend === 'webgpu' ? 'Готова (GPU)' : w.selfTest?.startsWith('fell back') ? 'Готова (CPU, медленно: GPU считал неверно)' : 'Готова (CPU, медленно)');
  else if (w.model === 'error') set('st-model', `Ошибка: ${w.error ?? ''}`);
  else set('st-model', w.model === 'loading' ? 'Загрузка…' : 'Не загружена');
  set('st-speed', w && w.rtf > 0 ? `${(1 / w.rtf).toFixed(1)}× быстрее реального времени` : '—');
  set('st-ahead', w ? `${Math.round(w.ahead)} с (аудио загружено на ${Math.round(w.inputAhead)} с)` : '—');
  const filterOn = s.profanity !== 'off';
  $('row-asr').hidden = !filterOn;
  if (filterOn) set('st-asr', asrText(w));

  // ── blur ──
  const vis = st.vision;
  const vw = vis?.status;
  let vText = '—';
  let vDot: Dot = '';
  if (!s.enabled || !s.blur || !vis || vis.state === 'off') vText = 'Выключено';
  else if (vw?.model === 'error') [vText, vDot] = [`Ошибка: ${vw.error ?? ''}`, 'bad'];
  else if (vw?.model === 'loading') [vText, vDot] = ['Загрузка модели…', 'wait'];
  else if (vis.state === 'no-video') vText = s.blurThumbs ? 'Проверяются превью' : 'Видео не найдено';
  else if (vis.state === 'checking') [vText, vDot] = [s.blurStrict ? 'Кадр проверяется — пока размыт' : 'Кадр проверяется…', 'wait'];
  else if (vis.state === 'hidden') [vText, vDot] = [vis.regions ? `Скрыто областей: ${vis.regions}` : 'Кадр размыт целиком', 'hidden'];
  else [vText, vDot] = ['Кадр чистый', 'ok'];
  set('vs-state', vText);
  dot('blur-dot', vDot);
  set('vs-ahead', vw && vis && vis.state !== 'off' && vis.state !== 'no-video' ? `${Math.round(vw.ahead)} с${vw.speed > 0 ? ` · ${vw.speed.toFixed(0)}× быстрее` : ''}` : '—');
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

void load().then(refresh);
void showCache();
setInterval(() => void refresh(), 1000);
