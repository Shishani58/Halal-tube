# Safari на iPhone

Цель: расширение для Safari на iPhone повторяет расширение для Chrome по возможностям.

Статус (2026-11-11): в симуляторе iPhone 17 Pro (iOS 26.5) расширение ставится, на m.youtube.com перехватывает аудио, процессор (модель на WASM) поднимается и отдаёт первый чистый тайл. Звук на выходе и реальный iPhone не проверены.

## Сборка и запуск в симуляторе

```bash
node scripts/build.mjs --safari                     # dist-safari/ (около 310 МБ: модели, ORT, whisper)
xcrun safari-web-extension-converter dist-safari --project-location <папка> \
  --app-name MusicRemover --bundle-identifier dev.ayub.MusicRemover --ios-only --no-open --no-prompt
xcodebuild -project <папка>/MusicRemover/MusicRemover.xcodeproj -scheme MusicRemover \
  -destination 'id=<UDID симулятора>' -derivedDataPath <dd> build
xcrun simctl install <UDID> <dd>/Build/Products/Debug-iphonesimulator/MusicRemover.app
```

Конвертер без `--copy-resources` ссылается на `dist-safari/`, так что после правок хватает пересобрать бандл и `xcodebuild`. Bundle id пишите с той же заглавной буквой, что у приложения (`dev.ayub.MusicRemover`), иначе Xcode ругается на префикс расширения.

В Safari: меню страницы → «Управлять расширениями» → включить; затем тот же пункт → «Без музыки» → разрешить доступ к m.youtube.com (не в приватной вкладке). Сборка с `--safari` рисует поверх страницы зелёную плашку с отладкой (`src/content/hook-badge.ts`): что видит хук, связь с процессором, состояние модели.

## Как устроено

- **Хук.** В iPhone Safari нет глобальных `MediaSource` и `SourceBuffer`, только `ManagedMediaSource` и `ManagedSourceBuffer`. `src/content/main.ts` патчит и их.
- **Процессор.** В Safari нет offscreen-документов. Мост (`bridge.ts`, `bridge-vision.ts`) вставляет в страницу скрытый iframe `processor/offscreen.html` (`web_accessible_resources`) и говорит с ним через `MessageChannel` (`src/shared/port.ts`). `offscreen.ts` один и тот же, в iframe он слушает `message` вместо `chrome.runtime.onConnect`. Процессор живёт и умирает вместе со страницей: модель не остаётся тёплой между вкладками, как в Chrome.
- **Фон.** Фоновый скрипт в Safari классический (iife), без `chrome.offscreen` и `chrome.commands`.
- `world: "MAIN"` для контент-скрипта работает, хотя конвертер пишет, что ключ не поддерживается.

## Что показал iPhone Safari (симулятор)

- YouTube играет через MSE (`audio/webm; codecs="opus"` и `video/mp4; codecs="avc1…"`), нативного HLS нет.
- Буфер `ManagedMediaSource` ограничен (около 5,5 МБ по логам WebKit): плеер сам не накопит запас для обработки.
- `navigator.gpu.requestAdapter()` вернул `null` (в симуляторе нет GPU), модель идёт на WASM, один поток (`SharedArrayBuffer` недоступен). Первый тайл на CPU симулятора пришёл примерно через минуту.

## Паритет с Chrome

| Возможность | Состояние |
|---|---|
| Удаление музыки (хук, процессор, модель) | работает: на тестовой странице `tests/e2e/site/player-ios.html` (синтетические речь и музыка) `state=clean`, `ctx=running`, дрейф 25 мс, тайлы планируются; на слух ещё не подтверждено |
| Размытие кадров и превью | работает на WASM (в ленте размыто выборочно); скорость на iPhone не проверена |
| Фильтр мата (Whisper) | входит в сборку, не проверен |
| Подписи, «Пауза до готовности», бейдж | код тот же (MAIN world), не проверены |
| Окно расширения (popup) | собирается, не проверено |
| Горячие клавиши | на iPhone нет клавиатуры, `commands` убраны |
| WebGPU | в симуляторе нет; на устройстве не проверен |

## Открытые вопросы

1. Слышен ли только голос без музыки (оригинал приглушён через `createMediaElementSource`): по плашке состояние `clean`, но на слух проверяет человек. Тестовая страница: `node scripts/build.mjs --safari --test`, затем `python3 -m http.server 8766 --bind 127.0.0.1` в папке с `player-ios.html` и `audio.webm` (его делает `tests/e2e/make-media.sh`), адрес `http://localhost:8766/player-ios.html`. Сборку `--test` для релиза не брать: в ней лишние `localhost`-доступы.
2. Реальный iPhone: WebGPU, скорость, память (модель голоса 32–64 МБ плюс детекторы), поведение при погашенном экране.
3. Фоновый скрипт Safari выгружается; настройки хранятся в `chrome.storage.sync`, через popup не проверялись.
4. Размер приложения: сборка около 310 МБ.
5. В симуляторе YouTube иногда пишет «Видео недоступно» посреди ролика, в том числе при выключенном расширении; причина не выяснена.
6. iframe процессора доступен странице: скрипт страницы может подключиться к нему как клиент. Вред ограничен расходом вычислений, но стоит закрыть токеном.
