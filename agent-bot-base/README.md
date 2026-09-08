# HF Nha Trang · agent-bot

Бэкенд агента, который стоит за Telegram-ботом. Telegram и Claude уже могут
быть реальными (см. ниже). Supabase — ЧАСТИЧНО реальный (21.07.2026,
минимальный срез, см. раздел "Supabase" ниже): staff_users/escalations
проксируются в настоящую БД, если заданы `SUPABASE_URL`/
`SUPABASE_SERVICE_ROLE_KEY`, иначе всё по-прежнему работает на
`db_mock.py` (в памяти процесса, без персистентности) — ничего не ломается
без этих переменных.

## Что реально работает

Полный флоу одного входящего сообщения:

```
POST /telegram/webhook
  -> лог в диалог (agent_dialogs, мок)
  -> red_zone_classifier.classify() — слой 1, ДО агента (уже боевой код,
     не мок — тот же файл, что используется в остальном проекте)
  -> escalate=True  -> хендофф-ответ клиенту + red_zone_events + диалог
                        помечен escalated_to='olga', в "агента" не идём
  -> escalate=False -> module_registry-гейт "agent_conversation" через
                        logic/pipeline_gate.run_step() (тот же паттерн,
                        что и остальные модули S6/S7/итд)
       enabled+auto            -> _agent_client.generate_reply() -> отправка
                                  (claude_real.py, если задан ANTHROPIC_API_KEY,
                                  иначе claude_mock.py — см. "Реальный Claude" ниже)
       manual_approval         -> гейт с черновиком, ждёт апрува
       disabled+wait_for_manual -> гейт-заглушка, ждёт апрува
       disabled+skip            -> тишина, ничего не уходит
```

Плюс отдельная ветка: сообщение `/link <код>` — служебная команда для
сотрудников (не клиентов), привязывает их Telegram `chat_id` в
`staff_users` (см. hf_schema_v1.sql, раздел 11). При эскалации красной
зоны бот, помимо ответа клиенту, дополнительно пушит всех сотрудников с
`receives_escalations=true` И привязанным `chat_id` — управляется из
админки (`/settings`), привязка — только через `/link` в самом боте
(Telegram не даёт написать первым тому, кто ещё не писал боту).

## Структура

- `main.py` — FastAPI, `POST /telegram/webhook` + `GET /health`
- `orchestrator.py` — вся логика флоу выше, единственная точка входа
- `logic/` — **не моки**, копии уже написанных и протестированных модулей
  (`red_zone_classifier.py`, `pipeline_gate.py`, `level1/2/5/6_*.py`).
  Копии, а не симлинки — сознательно, чтобы сервис можно было задеплоить
  отдельно от остального репозитория. Если оригиналы в корне проекта
  поменяются — синхронизировать вручную (TODO: перейти на общий пакет,
  когда появится единый репозиторий на весь проект).
- `integrations/` — единственное место, которое подключаем к реальным
  сервисам:
  - `telegram_mock.py` / `telegram_client.py` — мок и реальный Bot API,
    выбор по наличию `TELEGRAM_BOT_TOKEN` (см. `main.py`/`poll.py`)
  - `claude_mock.py` / `claude_real.py` — мок и реальный Anthropic API,
    выбор по наличию `ANTHROPIC_API_KEY` (см. `orchestrator.py`,
    `_agent_client`). `claude_real.py` — первая версия БЕЗ tool use
    (20.07.2026, согласовано с Игорем: "пока только эскалируем если что
    и всё") — системный промпт + справочник фактов зелёной зоны берутся из
    `logic/agent_prompt.py` (РУЧНОЙ снимок из `admin-panel/lib/mockData.ts`,
    не живая синхронизация — см. предупреждение в самом файле)
  - `db_mock.py` — in-memory вместо Supabase, TODO(supabase) на каждой
    операции, реализует интерфейс `pipeline_gate.Db`

## Известные упрощения (зафиксированы, не скрыты)

- Один процесс = один `MockDb` на всех клиентов, без персистентности.
- ~~Idempotency-ключ гейта строится из длины истории диалога, а не из
  Telegram `update_id`~~ — исправлено 21.07.2026: `main.py`/`poll.py`
  теперь передают `update_id` в `handle_incoming_message()`, и повторный
  вебхук отсекается САМЫМ первым делом (`db.check_and_mark_update()`), до
  какой-либо другой обработки. Набор увиденных `update_id` живёт в памяти
  процесса (как и всё остальное в `db_mock.py`) — переживёт нагрузку в
  рамках одного запуска, но не рестарт. См. `test_duplicate_update_id_is_ignored`.
- Поведение "модуль agent_conversation выключен -> тишина" (fallback=skip)
  — технический дефолт по аналогии с другими модулями, не подтверждён как
  продуктовое решение именно для основного диалога. Дефолт в `db_mock.py`
  сейчас `wait_for_manual` (безопаснее), но переключить можно одной
  строкой в `module_registry`.

## Реальный Claude (20.07.2026)

Первая версия — БЕЗ tool use, агент свободно разговаривает (не скриптованно),
опираясь на системный промпт + справочник фактов зелёной зоны
(`logic/agent_prompt.py`), но не вызывает никакие функции level1/level2/level5
(сбор данных, расчёт цены, изменения заказа) — это отдельный следующий шаг.

**Настоящая подписка Pro/Max на claude.ai для этого НЕ подходит** — это
разные продукты с раздельной оплатой. Нужен ключ API:

1. console.anthropic.com → завести аккаунт, привязать карту (биллинг
   по факту использования, без подписки — для теста хватит буквально
   $5, это тысячи вызовов Haiku или сотни Sonnet)
2. Settings → API keys → Create Key → скопировать сразу (второй раз не
   покажут)
3. Вставить в `agent-bot/.env`: `ANTHROPIC_API_KEY=sk-ant-...`
4. `pip install -r requirements.txt` (подтягивает `anthropic`)

Без ключа всё работает как раньше — заглушка `claude_mock.py`, ничего не
ломается, никаких дополнительных действий не нужно.

**Протокол эскалации без tool use:** промпт просит Claude ответить ровно
словом `ESCALATE`, если не уверен или тема не покрыта зелёной зоной —
`claude_real.py` это ловит и возвращает специальный флаг, `orchestrator.py`
заводит обычную эскалацию Ольге (тот же путь, что и красная зона) — сам
маркер клиенту никогда не уходит. Сетевые сбои Claude API (таймаут,
невалидный ключ, лимит) тоже трактуются как эскалация, не падение.

**Важно:** `logic/agent_prompt.py` — РУЧНОЙ снимок промпта и фактов из
`admin-panel/lib/mockData.ts` на 20.07.2026. Правки, которые Франсуа/Ольга
вносят в админке (`/agent-prompt`, `/green-zone`), сюда автоматически НЕ
попадают — нет общего инстанса БД между admin-panel и agent-bot. Обновлять
руками, пока не подключим общий Supabase (см. CLAUDE.md).

## Запуск (вариант A — реальный тестовый бот, polling)

Есть реальный токен от @BotFather (тестовый бот Игоря, 18.07.2026). Слой
Telegram настоящий (`integrations/telegram_client.py`). "Агент" — реальный
Claude, если задан `ANTHROPIC_API_KEY` (см. выше), иначе заглушка. БД —
по-прежнему мок (`db_mock.py`).

```bash
cd agent-bot
python3 -m pip install -r requirements.txt
python3 poll.py
```

Токен и (если есть) ключ Claude уже лежат в `agent-bot/.env` (в
`.gitignore`, наружу не уйдёт). Если `.env` потерялся — скопируй
`.env.example` в `.env` и вставь значения.

Открой бота в Telegram (юзернейм печатает `poll.py` при старте) и пиши
что угодно — без `ANTHROPIC_API_KEY` обычное сообщение получит MOCK-ответ,
с ключом — настоящий ответ Claude. Фраза про аллергию/здоровье в обоих
случаях уйдёт в эскалацию (реальная логика, не мок). Ctrl+C — остановить.

## Запуск (вариант B — webhook на моках, без реального бота)

```bash
pip install -r requirements.txt
uvicorn main:app --reload --port 8000
```

Проверка:

```bash
curl -X POST http://localhost:8000/telegram/webhook \
  -H "Content-Type: application/json" \
  -d '{"message": {"chat": {"id": "123"}, "from": {"id": "u1", "username": "igor"}, "text": "привет"}}'
```

## Тесты

```bash
python3 -m pytest -q
```

26/26, без сети и без реального ключа/проекта (тесты защищаются от
реального `.env` в этой же папке — см. `test_orchestrator.py`/
`test_admin_sync.py`/`test_supabase_client.py` — и всегда идут по
мок-пути) — обычное сообщение, эскалация по аллергии, эскалация по тону,
самоэскалация агента (escalate=True от `_agent_client`, см. "Реальный
Claude"), disabled+wait_for_manual, disabled+skip, manual_approval, дедуп
гейта по idempotency_key, дедуп по Telegram `update_id` (21.07.2026),
`/link`, пуши получателям, `POST /admin/sync` (21.07.2026), видимость
расхода токенов (`get_agent_usage_stats`, 21.07.2026), реальная запись в
`escalations` при обоих типах эскалации (21.07.2026, см. "Supabase" ниже)
+ отдельно санити-тесты на `logic/agent_prompt.py`.

## Supabase (минимальный срез, 21.07.2026)

До этого staff_users жили в двух независимых моках (здесь и в
admin-panel), а реальные эскалации от бота физически не могли попасть в
`/escalations` админки — не было общего хранилища. Теперь есть один общий
Supabase-проект (см. `supabase_minimal_schema.sql` в корне репозитория) на
6 таблиц: `red_zone_terms`, `app_settings`, `green_zone_facts`,
`staff_users`, `escalations`, `audit_log` — сознательно НЕ вся
`hf_schema_v1.sql` (клиенты/заказы/блюда/подписки ждут, пока уровни
1/2/4/5/6 ТЗ агента подключатся к живому коду).

Со стороны agent-bot это даёт:
- `list_staff_users()`/`get_escalation_recipients()`/`link_staff_user()`
  (см. `integrations/db_mock.py`) читают/пишут реальную таблицу
  `staff_users`, если Supabase настроен — те же галочки
  receives_escalations/can_approve_after_deadline, что видит Ольга/Франсуа
  в `/settings` админки, без ручного дублирования.
- Обе точки эскалации в `orchestrator.py` (красная зона и
  self-escalation агента) пишут реальную строку в `escalations`
  (`db.create_escalation_record()`) — теперь видно в `/escalations`
  админки, не только в логах бота.

Настройка (см. `.env.example`): `SUPABASE_URL` + `SUPABASE_SERVICE_ROLE_KEY`
(SERVICE_ROLE, не anon — берётся в Supabase → Settings → API). Не заданы —
всё работает как раньше на `db_mock.py`, ничего не падает
(`integrations/supabase_client.py` — best-effort, любая сетевая ошибка
тихо трактуется как "недоступно", см. докстринг файла).

Не сделано в этом заходе (сознательно, не в счёт минимального среза):
- `red_zone_terms`/`green_zone_facts`/`app_settings`/`audit_log` в
  agent-bot НЕ читаются напрямую из Supabase — промпт/факты по-прежнему
  идут через `/admin/sync` (push из admin-panel, см. выше), красная зона
  по-прежнему читает `red_zone_terms.yaml`. Объединение этих двух путей —
  отдельный будущий шаг, не обязательный сейчас (источник истины один и
  тот же — admin-panel).
- Реальный REST-запрос ни разу не проверялся с настоящим Supabase-проектом
  в этой песочнице (нет сети) — только graceful no-op при отсутствии
  переменных (см. `test_supabase_client.py`). Первая живая проверка —
  у Игоря локально/на Render после создания проекта.

## Деплой на Render (бесплатно, 19.07.2026)

Важно: у Render бесплатный тариф есть только у Web Service (принимает
HTTP), у background worker (то, чем по сути является `poll.py`) —
бесплатного тарифа нет (проверено в доке Render). Поэтому на Render едет
`main.py` в режиме webhook, а не `poll.py`. Локально для разработки
по-прежнему можно гонять `poll.py` — просто нельзя оба режима сразу
(Telegram отдаёт ошибку на getUpdates, пока активен вебхук).

**1. GitHub** — отдельный репозиторий под бота (не мешаем в admin-panel):

```bash
cd agent-bot
git init
git add .
git commit -m "agent-bot: MVP на моках + реальный Telegram-клиент"
git branch -M main
git remote add origin https://github.com/IG-TL/hf-agent-bot.git   # создать репозиторий на github.com заранее (New repository, Private)
git push -u origin main
```

`.env` с токеном в репозиторий не попадёт — он в `.gitignore`.

**2. Render** — render.com → New → Web Service → подключить репозиторий
`hf-agent-bot`. Если есть `render.yaml` (уже лежит в этой папке), Render
может предложить его подхватить автоматически (Blueprint) — тогда шаги
ниже он выставит сам, кроме токена. Если настраивать руками:

- Runtime: Python 3
- Build command: `pip install -r requirements.txt`
- Start command: `uvicorn main:app --host 0.0.0.0 --port $PORT`
- Instance type: **Free**
- Environment → Add Environment Variable: `TELEGRAM_BOT_TOKEN` = токен из
  @BotFather (не хардкодить в коде — только через переменную окружения)
- Environment → Add Environment Variable (опционально, для реального
  Claude вместо заглушки): `ANTHROPIC_API_KEY` = ключ с console.anthropic.com
  (см. раздел "Реальный Claude" выше)

Create Web Service → дождаться деплоя → скопировать публичный URL (вида
`https://hf-agent-bot.onrender.com`).

**3. Привязать вебхук** (один раз, с локальной машины):

```bash
python3 set_webhook.py https://hf-agent-bot.onrender.com
```

Проверить, что встал: `python3 set_webhook.py --info`. Снять и вернуться
к локальному `poll.py`: `python3 set_webhook.py --delete`.

**4. Проверка** — пиши боту в Telegram. Первое сообщение после простоя
может прийти с задержкой ~1 минуту (бесплатный инстанс "просыпается"),
дальше быстро, пока не полежит 15 минут без сообщений (обсуждено
18.07.2026 — норм для теста, не для показа клиенту без предупреждения).

Известное ограничение: при каждом засыпании/передеплое вся история
диалогов в памяти (`db_mock.py`) обнуляется — ждём Supabase.

## Импорт заказов из Google Sheets (22.07.2026)

Ручная кнопка "Импортировать сейчас" (см. `/settings` в admin-panel) и
автоматическая ежедневная выгрузка снимка вкладки "Заказы на день" в
`sheet_import_log` (Supabase) — полная замена по дате, без разбора
конкретных колонок в `orders_log`/`clients` (см.
`supabase_migration_5_sheets_import.sql` — раскладка клиентских строк ещё
не проверена вживую).

Настройка (`.env`, см. `.env.example`): `GOOGLE_SERVICE_ACCOUNT_JSON`,
`GOOGLE_SHEET_ID`, `GOOGLE_SHEET_GID` — те же переменные, что и
`sheets_read_check.py`. Также нужен `pip install gspread google-auth`
(см. `requirements.txt`).

## Проверка связи с таблицей-песочницей для записи (24.07.2026)

Раскладка колонок "2. Заказы на день" разобрана (см. `logic/orders_parse.py`,
CLAUDE.md 24.07.2026) — список А (колонки A-L) это реальные заказы,
список Б (колонки O+) не относится к заказам, справочная копия ростера
клиентов, игнорируется. Сама запись в Google Sheet ещё не реализована
(ждёт проектирования tool-use уровня 5) — но для будущего теста Игорь
завёл отдельную таблицу-песочницу с доступом Editor сервисному аккаунту:
https://docs.google.com/spreadsheets/d/1UtkSiYGjp6QnIvVC-GSmz5ZFUwWZIUS8O4EvKjMc8Hw

Проверить связь (и чтение, и запись) можно разовым скриптом:
```
python3 -m pip install gspread google-auth --break-system-packages
python3 sheets_write_check.py
```
Требует в `.env`: `GOOGLE_SHEET_WRITE_ID`, `GOOGLE_SHEET_WRITE_GID` (уже
проставлены в `.env.example` на песочницу) — ключ сервисного аккаунта тот
же, что и для чтения. Скрипт пишет тестовое значение в ячейку `Z1` (далеко
от реальных колонок A-U) и читает обратно — если совпало, Editor-доступ
реально работает.

**Автовыгрузка по расписанию требует внешнего cron** — Render на
бесплатном тарифе не даёт cron из коробки. Endpoint
`GET /cron/sheets-import-check` (защищён тем же `x-admin-token:
ADMIN_SYNC_TOKEN`, что и остальные `/admin/*`) идемпотентен: реально
запускает импорт максимум один раз в день, после времени, настроенного в
`/settings` → "Время автовыгрузки" (`app_settings.sheets_auto_import_time_ict`,
дефолт "22:00" — плейсхолдер, не подтверждено Франсуа). Настройте внешний
сервис (например, бесплатный [cron-job.org](https://cron-job.org)) бить
эту ручку раз в 15-30 минут:

```
GET https://hf-agent-bot.onrender.com/cron/sheets-import-check
Header: x-admin-token: <тот же ADMIN_SYNC_TOKEN, что в Render → Environment>
```

Ручная кнопка в админке дёргает `POST /admin/import-sheet` (тот же
`ADMIN_SYNC_TOKEN`) — работает независимо от расписания, в любой момент.

### Шаблоны дневных вкладок в Sheet-песочнице (25.07.2026)

Отдельная от импорта задача — поддерживать скользящее окно из 7 пустых
дневных вкладок-шаблонов ВПЕРЁД в таблице-песочнице (`GOOGLE_SHEET_WRITE_ID`,
не боевой источник), по одной вкладке на день, имя "ДД.ММ.ГГГГ", только
колонки заказов ("Список А") — см. `logic/sheet_templates.py`. Тоже нужен
внешний cron (тот же принцип, что и выше — можно добавить ВТОРОЙ таргет в
том же cron-job.org на тот же интервал):

```
GET https://hf-agent-bot.onrender.com/cron/ensure-sheet-templates
Header: x-admin-token: <тот же ADMIN_SYNC_TOKEN>
```

В отличие от `/cron/sheets-import-check` здесь нет гейта "раз в день" —
сама проверка "какая вкладка уже существует" идемпотентна, безопасно
дёргать часто. Ручная кнопка "Создать вкладки сейчас" в `/sheets-import`
дёргает `POST /admin/ensure-sheet-templates` (тот же `ADMIN_SYNC_TOKEN`).

Заполнение созданной вкладки реальными подписчиками на этот день —
отдельный следующий шаг, ещё не реализован.

### Клиенты: снимок + разбор в реальную схему (22.07.2026)

Вкладка "1. Клиенты" — та же механика снимка (`POST
/admin/import-clients-sheet`, append-only в `sheet_clients_snapshot_log`,
см. `GOOGLE_SHEET_CLIENTS_GID` в `.env.example`), плюс новый шаг разбора:
`POST /admin/parse-clients-sheet` берёт ПОСЛЕДНИЙ сохранённый снимок и
раскладывает его в `clients`/`client_pii`/`client_restrictions`/
`client_preferences` (см. `logic/clients_parse.py` + `clients_import.py`,
`supabase_migration_7_clients_core.sql`). Идемпотентно по
`client_pii.tg_username` — повторный запуск обновляет существующих
клиентов, не плодит дубли.

**Сознательное ограничение:** "Запрет"/"Предпочтения" — свободный текст,
который на реальных данных смешивает разные типы информации в одной
ячейке (диета + логистика + заметки о графике подписки одной строкой).
Автоматическая классификация была бы гаданием — вместо этого весь текст
целиком становится одной строкой `client_restrictions`/`client_preferences`
с `source='import_sheets_unclassified'` (видно в карточке клиента рядом с
каждым ограничением) — Ольга/Франсуа вручную переклассифицируют/разбивают
через уже существующий UI добавления/деактивации. `current_kcal_level` на
`clients` — снимок текущего уровня ккал из шитса, НЕ полноценная запись
`subscriptions` (нет дат/оплаты в источнике).

## Вход в admin-panel по QR через Telegram (22.07.2026)

`/start login_<токен>` (Telegram-сообщение от deep-link'а `t.me/<бот>?start=login_<токен>`,
см. QR на странице `/login` admin-panel) — обрабатывается в `orchestrator.py`
тем же способом, что и `/link` (синхронно, в обход батчинга, см. `main.py`).
Требует, чтобы chat_id УЖЕ был привязан к сотруднику через `/link <код>`
раньше — вход по QR только опознаёт уже существующего сотрудника, не
создаёт новую привязку. Подтверждение токена — `POST` (напрямую через
`integrations/supabase_client.confirm_login_token()`) в таблицу
`login_tokens` (см. `supabase_migration_8_auth_infra.sql`), с условием
`status='pending'` в фильтре — не даёт повторно подтвердить уже
использованный токен.

Требует настоящего Supabase (`SUPABASE_URL`/`SUPABASE_SERVICE_ROLE_KEY`,
уже заданы для остального проекта) — без него бот всё равно ответит
понятным сообщением об ошибке (не подтверждённый вход), не упадёт.

## Дальше (не сделано в этом MVP)

- Реальный бот Telegram сейчас тестовый (Игоря, через @BotFather,
  polling). Продовый бот Франсуа + переключение на webhook (main.py уже
  умеет `/telegram/webhook`, нужно только `setWebhook` + публичный URL,
  см. деплой ниже) — отдельный шаг
- Tool use поверх level1/level2/level5/level6 (агент сам вызывает функции —
  сбор данных, расчёт цены, изменения заказа), сейчас агент только
  разговаривает и эскалирует (согласовано с Игорем 20.07.2026)
- Реальный Supabase-клиент вместо `db_mock.py` — заодно решит, что
  `logic/agent_prompt.py` (промпт+факты) перестанет быть ручным снимком
  и будет жить в одной БД с admin-panel
- Финальный тон/стиль промпта, few-shot примеры — ждут ручной разметки
  Ольги/Франсуа по `level3_zone_map_draft.md` (уровень 3)
