# Перенос ядра Duet на Rust

Статус на 30 октября 2026: перенос прикладного ядра завершён. Нативная сборка запускает
Rust core внутри Tauri; постоянный Node sidecar и JS-адаптер Claude отсутствуют.
Реестр `desktop/ipc-ownership.json`: **120 Rust-команд, 0 legacy-команд**.
React/Zustand остаются интерфейсом в системном WebView Windows/Linux.

## Выполненный план

- [x] Прямой IPC UI → Rust, без скрытого возврата в Node при ошибках.
- [x] Реестр команд и проверка владельцев; `desk:native-core` сообщает состояние ядра,
      работников, подтверждений и фактическую заполненность очереди доставки UI.
- [x] Файлы, вложения, наблюдение за открытыми файлами, индекс проекта для @-упоминаний.
- [x] Потоковое чтение JSONL; отдельные преобразователи Claude, Codex, Antigravity, Gemini.
- [x] История и поиск в SQLite на диске, compaction/активные ветки, fork и rewind.
- [x] Страницы истории по целым ходам, отдельная подгрузка выбранного субагента.
      Контекст переключения провайдера читается с диска отдельно от видимого хвоста.
- [x] Реестр чатов/процессов, очереди follow-up, steering, broker разрешений и вопросов.
- [x] Защита от поздних callback предыдущего run; отмена ожидающих разрешений при закрытии.
- [x] Делегирование между провайдерами с ограничением глубины и полномочий,
      сохранение связей родительской и дочерней сессий.
- [x] Освобождение простаивающих клиентов с сохранением session ID; работающие задачи,
      фоновые агенты, разрешения и делегированные работы препятствуют освобождению.
- [x] Claude: прямой протокол нативного CLI, control requests, MCP bridge, streaming,
      инструменты, настройки, rewind и дочерние агенты. SDK JavaScript не загружается.
- [x] Codex: нативный app-server, JSON-RPC, dynamic tools, approvals, models/account/limits,
      resume/fork/rollback, subagents и обработка завершения сервера.
- [x] Antigravity и Gemini: обнаружение CLI, подписочный режим, события и журнал сессий,
      продолжение диалога, остановка и конфигурация.
- [x] Подписочная авторизация: релевантные API-key/ADC переменные не передаются CLI;
      Claude проверяет подписочный аккаунт, Codex — ChatGPT, Gemini — oauth-personal.
- [x] Supervisor процессов: ограниченные stdout/stderr/RPC, таймауты, Windows Job Objects
      и Unix process groups. Завершаются только процессы, созданные данным экземпляром.
- [x] ConPTY на Windows / PTY на Linux, resize/input/output/exit и очистка.
- [x] Атомарные настройки, Git/worktrees, PR/CI через git/gh, запуск IDE и терминалов.
- [x] Окна, отстыковка, браузерные инструменты, захват страницы, файловые диалоги,
      инструкции, команды, skills, MCP settings, статистика и слежение за сессиями.
- [x] Планировщик и Telegram используют тот же Rust registry. В preview/test их фоновые
      циклы отключены. Разрешения микрофона нативные; Whisper worker остаётся в UI.
- [x] Главное окно и сервисы создаёт Rust; Node/Electron/старое ядро исключены из пакета.
- [x] Сборки и интеграционные проверки Windows/WebView2 и Linux/WebKitGTK.

## Архитектура

```text
React / Zustand
      │ duet_invoke + DeskEvent
      ▼
Rust core в Tauri
 ├─ agents.rs: чаты, runs, approvals, delegation, provider protocols
 ├─ process.rs / rpc.rs: supervisor и ограниченные каналы CLI
 ├─ history.rs / events.rs / live.rs: история, пагинация и трансляция событий
 ├─ search.rs / jsonl.rs: дисковый индекс и потоковый разбор
 ├─ storage.rs / files.rs / config.rs: настройки, файлы и редакторы
 ├─ git.rs / pr.rs / project_index.rs / terminal.rs
 └─ desktop.rs / scheduler.rs / telegram.rs
      │
      ├─ нативный Claude executable, stdio
      ├─ нативный Codex app-server, JSON-RPC
      └─ установленные Antigravity / Gemini CLI
```

`main.rs` обслуживает до 8 одновременных IPC-работников. Ответы на разрешения доступны
отдельно, чтобы заполненная очередь команд не блокировала пользователя. `pump.rs`
объединяет события и ждёт подтверждения выполнения JS в WebView, обеспечивая
обратное давление при медленном UI. Закрытие приложения разблокирует доставку.
Удалённые страницы браузера не могут вызывать команды ядра.

`desktop/sidecar.mjs`, `desktop/runtime.mjs` и `electron/` оставлены как предыдущая
реализация для регрессионных сравнений. Нативный запуск их не импортирует, упаковка
их не включает. В runtime лежат только manifest/license и нативный Claude CLI.
Node может запускаться самим отдельно установленным Gemini CLI; это внешний
провайдер, а не ядро Duet. Node также нужен для сборки frontend и тестов.

## Ограничения ресурсов

| Ресурс | Предел |
|---|---:|
| JSONL / RPC запись | 32 МиБ, незавершённый хвост не фиксируется |
| SQLite cache | 8 МиБ на соединение, mmap отключён |
| Поиск | 500 результатов, текст результата до 2000 символов |
| История | 40 ходов по умолчанию, до 100; бюджет страницы 8 МиБ |
| Один большой ход | до 64 МиБ; превышение возвращает явную ошибку |
| Контекст с диска | ограниченный начальный и последний текст, до 120 тыс. символов |
| Очередь доставки UI | канал 1024 сообщений, бюджет полезной нагрузки 64 МиБ |
| Пакет доставки | до 128 событий / 256 КиБ за 8 мс; крупная запись идёт отдельно |
| Agent operations / pending approvals | 128 / 128 |
| Терминалы / browser pages / file watches | 32 / 64 / 256 |
| Файлы редактора / вложения | чтение 4 МиБ, запись 8 МиБ / 20 МиБ |

Ограничения позволяют обрабатывать большие журналы без загрузки всей истории
и всех субагентов в RAM. SQLite-индекс нормализованной истории при изменении
существующего JSONL сейчас перестраивается для этого файла; инкрементальный append
остаётся возможной оптимизацией CPU, а не оставшейся зависимостью от Node.

## Проверки

- 18 Rust unit/integration tests: настройки, файлы/watch, Unicode/append/partial tail/
  rewrite/delete в поиске, история/ветки/страницы, процессные таймауты, Git/worktrees,
  idle lifecycle, stale callbacks, отмена разрешений, расписания и авторизация Telegram.
- `test-native-core.mjs`: Rust driver + отдельные CLI subprocess fixtures всех четырёх
  провайдеров. Два хода, фильтрация credentials, broker разрешений и чужого chat ID,
  preview patch approval, отмена, замена run, последовательное close/resume Codex,
  Claude MCP → Codex delegation,
  hot switch в одном чате, журналы/статистика/команды и завершение своих процессов.
- `test-native-history.mjs`: golden parity с прежними парсерами Claude/Codex,
  thinking/tools/results/marks/receipts/subagents, целые страницы и старый контекст с диска, fork с историей агента,
  совместимость старых Antigravity/Gemini journals и rollback.
- `test:chat`: fork/aliases/hot switch/rewind/reopen/поздние callbacks, native paging,
  выборочная история агента и сохранение сообщения при ошибке чтения handoff.
- Windows WebView2: четыре установленных CLI обнаруживаются; оконные кнопки/F11,
  компактные квоты, файлы/watch/search, Rust PTY, browser PNG, запрет remote IPC,
  отложенные панели. Синтетические 200 агентов / 10 000 событий: 81 store commit,
  до 40 смонтированных ходов, без падения интерфейса. Это не 200 реальных CLI-процессов.
- Linux Debian 12, WebKitGTK/Xvfb: четыре fixture-провайдера, файлы, PTY, PNG страницы,
  состояние окна, detached window, отзывчивый React и штатное закрытие процесса.
  Исправлено удержание главного GTK-окна дочерним WebView при закрытии.
- Реальные Claude Max и Codex ChatGPT: два хода с запоминанием случайного токена,
  context usage, rename и архивирование только созданных тестовых сессий.
- `typecheck`, UI load/runtime stress и прежние provider/lifecycle regression tests проходят.

Реальные сетевые отправки Telegram и публикация PR в этой проверке не выполнялись.
Antigravity/Gemini проверены установленными CLI на discovery и фикстурами на диалогах;
реальный двухходовый диалог проверен у Claude и Codex. Linux UI проверен под Xvfb,
а не на каждом desktop environment/Wayland compositor.

## Замер памяти

`node scripts/benchmark-rust-core.mjs`, Windows, одинаковые свежие временные профили,
после готовности UI и пяти секунд простоя, без агентных ходов. Учитывается private memory
всего дерева, включая WebView2 и Codex app-server, запущенный для discovery.

| Реализация | Всё дерево | Ядро Duet | Внешний Codex |
|---|---:|---:|---:|
| Tauri + прежний Node core | 440 МиБ | Rust host ~7 МиБ + Node ~72 МиБ | ~59 МиБ |
| Tauri + Rust core | 363 МиБ | ~11 МиБ | ~60 МиБ |

Разница одного замера: **77 МиБ / 18%**. WebView остаётся основным потребителем
свежего экземпляра. Это не замер под реальными параллельными агентами и не сравнение
со старым работающим Node-процессом, который ранее занимал около 1053 МиБ на другом состоянии.
Исходный JSON сохраняется в `.tools/rust-core-memory.json`.

## Сборка и повторение

```text
npm run typecheck
npm run test:native-ownership
cargo test --locked --lib --manifest-path src-tauri/Cargo.toml
cargo build --locked --manifest-path src-tauri/Cargo.toml --examples
npm run test:rust-core
npm run test:chat
npm run test:ui
npm run native:build
npm run test:native
# Linux:
xvfb-run -a dbus-run-session -- npm run test:native-linux
npm run native:package
# Opt-in: использует подписочную квоту, создаёт только свои тестовые сессии:
node scripts/smoke-rust-providers.mjs
```

Для безопасного выпуска рядом с работающей предыдущей версией использованы отдельный
`CARGO_TARGET_DIR=.tools/rust-core-target` и `DUET_NATIVE_PORTABLE_DIR=release/native-rust-core`.
Установщик Windows создаётся в `.tools/rust-core-target/release/bundle/nsis/`.
Linux deb/AppImage собираются в отдельном контейнере. `npm start` выбирает свежую
сборку; preview имеет отдельный профиль и не забирает single-instance lock рабочего приложения.
Текущий рабочий экземпляр и его задачи при миграции не останавливались.

Готовые артефакты этой сборки:

- `release/native-rust-core/duet-native.exe` — Windows portable, рядом должен оставаться `runtime/`.
- `release/Duet_0.2.0_x64-rust-core-setup.exe` — Windows NSIS (~88,5 МиБ).
- `release/linux-rust-core/Duet_0.2.0_amd64.deb` — Linux x64 (~118,8 МиБ).
- `release/linux-rust-core/Duet_0.2.0_amd64.AppImage` — Linux x64 (~200,9 МиБ).
- `release/rust-core-build.json` — размеры, SHA-256 и выполненные проверки.

Portable оставлен отдельно от предыдущей версии; старые файлы и работающий процесс
не заменены. Для запуска новой версии использовать этот executable или `npm start`.
