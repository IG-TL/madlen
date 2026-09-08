-- ============================================================================
-- БАЗОВАЯ СХЕМА ДЛЯ НОВОГО ПРОЕКТА (ИИ-консультант в Telegram)
-- ============================================================================
-- Вынесено из проекта HF Nha Trang (supabase_minimal_schema.sql) — только
-- таблицы общего движка (промпт/факты/эскалации/диалоги/сотрудники/вход),
-- без бизнес-таблиц HF (clients/subscriptions/sheet_import и т.п. — под
-- новый продукт это будет другая модель данных, если вообще нужна).
--
-- ВАЖНО: значения в CHECK-констрейнтах ниже, помеченные TODO — HF-специфичные
-- заглушки, которые нужно продумать под новый продукт ОТДЕЛЬНО, не решено
-- здесь (см. PLAN.md, "Открытые вопросы"). Остальное — рабочая структура,
-- переносится как есть.

create extension if not exists pgcrypto;

-- ----------------------------------------------------------------------------
-- 1. Красная зона — детерминированный стоп-лист ДО модели.
-- В HF это аллергии/жалобы. Здесь — TODO: кризисные маркеры (суицид,
-- самоповреждение, насилие, угроза жизни себе/другим). Список pattern'ов
-- заполняется отдельно, это не техническая, а содержательная работа —
-- см. агент-bot-base/logic/red_zone_terms.yaml как пример формата.
-- ----------------------------------------------------------------------------
create table if not exists red_zone_terms (
    term_id      uuid primary key default gen_random_uuid(),
    -- TODO: категории под новый продукт, напр.
    -- ('suicide_selfharm','violence_threat','medical_emergency','other_crisis')
    category     text not null,
    language     text not null check (language in ('ru','en')),
    pattern      text not null,   -- regex-фрагмент
    note         text,
    is_active    boolean not null default true,
    added_by     text not null,
    added_at     timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 2. Настройки приложения — системный промпт агента, свои прочие ключи.
-- ----------------------------------------------------------------------------
create table if not exists app_settings (
    setting_key   text primary key,   -- 'agent_system_prompt' | 'start_greeting_texts' | ...
    value         jsonb not null,
    description   text,
    updated_by    text,
    updated_at    timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 3. Зелёная зона — справочник ПОДТВЕРЖДЁННЫХ фактов/правил методики,
-- не пары "вопрос-ответ". Агент формулирует ответ сам, но не выдумывает
-- факты сверх этого списка (тот же принцип anti-fabrication, что в HF).
-- Под новый продукт это, вероятно, не "факты о бизнесе", а элементы
-- авторской методики: как задавать уточняющие вопросы, что можно/нельзя
-- обещать, шаблон структурированного вывода и т.п. — контент решает
-- заказчик, таблица/формат — общий.
-- ----------------------------------------------------------------------------
create table if not exists green_zone_facts (
    fact_id      uuid primary key default gen_random_uuid(),
    category     text not null,  -- сверяется с label в green_zone_categories
    fact_text    text not null,
    note         text,
    is_active    boolean not null default true,
    added_by     text not null,
    added_at     timestamptz not null default now()
);

create table if not exists green_zone_categories (
    category_id uuid primary key default gen_random_uuid(),
    label       text not null unique,
    sort_order  int not null default 0,
    is_active   boolean not null default true,
    created_by  text not null,
    created_at  timestamptz not null default now()
);

-- TODO: свои категории вместо HF-шных ("Цена и скидки" и т.п.), например:
-- insert into green_zone_categories (label, sort_order, created_by) values
--     ('Структура диалога', 0, 'system_migration'),
--     ('Что можно обещать', 1, 'system_migration'),
--     ('Передача специалисту', 2, 'system_migration'),
--     ('Другое', 3, 'system_migration')
-- on conflict (label) do nothing;

-- ----------------------------------------------------------------------------
-- 4. Сотрудники / получатели пушей об эскалации в Telegram.
-- role — TODO: под новый продукт вероятно нужны роли-специальности
-- ('founder','psychologist','lawyer','moderator'...), не только owner/ops/dev.
-- ----------------------------------------------------------------------------
create table if not exists staff_users (
    user_id                    uuid primary key default gen_random_uuid(),
    display_name               text not null unique,
    email                      text,
    role                       text not null,  -- TODO: свой список ролей
    is_active                  boolean not null default true,
    receives_escalations       boolean not null default false,
    -- Telegram не даёт боту написать первым тому, кто ему не писал — chat_id
    -- заполняется через одноразовую команду "/link <код>" в самом боте.
    telegram_chat_id           text,
    telegram_link_code         text unique,
    telegram_linked_at         timestamptz,
    -- Отдельная галочка "пуш на каждое новое сообщение НОВОГО диалога"
    -- (не то же самое, что receives_escalations) — см. HF, 12.08.2026.
    notify_new_dialogs         boolean not null default false,
    created_by                 text,
    created_at                 timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 5. Очередь эскалаций.
-- category — TODO под новый продукт. В HF это стоп-лист + agent_uncertain;
-- здесь минимум нужно различать:
--   'crisis_signal'       — сработала красная зона (кризисный маркер)
--   'agent_uncertain'     — модель сама не уверена / вне методики
--   'client_requested'    — клиент сам нажал кнопку "написать основателю"
--   'agent_stalled_promise' — модель пообещала действие, которого не может
--                             выполнить (см. HF, 17.08.2026 — "что на ужин")
-- ----------------------------------------------------------------------------
create table if not exists escalations (
    escalation_id       uuid primary key default gen_random_uuid(),
    dialog_id           text not null,
    client_id           text not null,
    client_display_name text not null,
    channel             text not null,
    message_text        text not null,
    category            text not null,  -- TODO: свой CHECK со списком выше
    reason              text not null,
    status              text not null default 'new' check (status in ('new','in_progress','completed')),
    created_at          timestamptz not null default now(),
    opened_at           timestamptz,
    opened_by           text,
    completed_at        timestamptz,
    completed_by        text,
    resolution_text     text,
    agent_intended_action text,
    client_chat_id      text
);

-- ----------------------------------------------------------------------------
-- 6. Аудит-лог правок в админке.
-- ----------------------------------------------------------------------------
create table if not exists audit_log (
    entry_id     uuid primary key default gen_random_uuid(),
    entity_type  text not null,  -- 'red_zone_term' | 'green_zone_fact' | 'app_setting' | 'staff_user' | ...
    entity_id    text not null,
    entity_label text not null,
    client_id    text,
    action       text not null check (action in ('created','deactivated','updated')),
    before       text,
    after        text,
    changed_by   text not null,
    changed_at   timestamptz not null default now()
);

-- ----------------------------------------------------------------------------
-- 7. Диалоги + сообщения + ручной перехват менеджером (HF: миграции 4, 23).
-- ----------------------------------------------------------------------------
create table if not exists dialogs (
    dialog_id           text primary key,
    client_id           text not null,
    client_display_name text not null,
    channel             text not null default 'telegram',
    escalated_to        text,
    escalation_reason   text,
    started_at          timestamptz not null default now(),
    ended_at            timestamptz,
    updated_at          timestamptz not null default now(),
    -- self-heal, пишется ботом на каждое сообщение — нужен, чтобы админка
    -- могла ответить клиенту напрямую в Telegram.
    client_chat_id       text,
    -- "менеджер/специалист взял диалог на себя" — явный тумблер, не
    -- автовозврат по таймауту (см. PLAN.md, зачем это здесь так важно).
    human_takeover       boolean not null default false,
    human_takeover_by    text,
    human_takeover_at    timestamptz
);

create table if not exists dialog_messages (
    message_id  uuid primary key default gen_random_uuid(),
    dialog_id   text not null,
    role        text not null check (role in ('client', 'agent', 'staff')),
    text        text not null,
    created_at  timestamptz not null default now()
);

create index if not exists dialog_messages_dialog_id_idx on dialog_messages (dialog_id, created_at);

-- Live-обновление чата в админке без перезагрузки (см. DialogThread.tsx).
alter publication supabase_realtime add table dialogs, dialog_messages;

-- ----------------------------------------------------------------------------
-- 8. Вход в админку по QR через Telegram-бота (HF: migration 8).
-- ----------------------------------------------------------------------------
create table if not exists login_tokens (
    token         uuid primary key default gen_random_uuid(),
    status        text not null default 'pending' check (status in ('pending','confirmed','expired')),
    staff_user_id uuid references staff_users(user_id),
    created_at    timestamptz not null default now(),
    confirmed_at  timestamptz
);

create table if not exists admin_sessions (
    session_id    uuid primary key default gen_random_uuid(),
    staff_user_id uuid not null references staff_users(user_id),
    created_at    timestamptz not null default now(),
    expires_at    timestamptz not null,
    revoked_at    timestamptz
);

-- ----------------------------------------------------------------------------
-- Права доступа.
--
-- ВАЖНО, честно: в HF это временное упрощение (см. supabase_minimal_schema.sql,
-- шапка) — RLS отключён на таблицах без PII, staff/auth таблицы закрыты
-- deny-all для anon, доступ только server-side с service role. Для этого
-- продукта содержимое dialog_messages — это чужие личные, часто тяжёлые
-- истории (не заказы еды) — здесь НЕЛЬЗЯ откладывать нормальный доступ
-- "на потом" так же спокойно, как в HF. Ниже — тот же временный вариант
-- ТОЛЬКО чтобы можно было быстро завести прототип, но перед реальным
-- запуском (не позже) нужно закрыть dialogs/dialog_messages/escalations
-- service-role-only, как staff_users, и решить, как эти данные вообще
-- хранятся (шифрование, срок хранения, право клиента на удаление).
-- ----------------------------------------------------------------------------
grant usage on schema public to anon, authenticated;
grant select, insert, update, delete on
    red_zone_terms, app_settings, green_zone_facts, escalations, audit_log,
    dialogs, dialog_messages
    to anon, authenticated;
grant select, insert, update on green_zone_categories to anon, authenticated;

alter table red_zone_terms        disable row level security;
alter table app_settings          disable row level security;
alter table green_zone_facts      disable row level security;
alter table green_zone_categories disable row level security;
alter table dialogs               disable row level security;
alter table dialog_messages       disable row level security;
alter table escalations           disable row level security;
alter table audit_log             disable row level security;

alter table staff_users     enable row level security;
alter table login_tokens    enable row level security;
alter table admin_sessions  enable row level security;

revoke all on staff_users    from anon, authenticated;
revoke all on login_tokens   from anon, authenticated;
revoke all on admin_sessions from anon, authenticated;
