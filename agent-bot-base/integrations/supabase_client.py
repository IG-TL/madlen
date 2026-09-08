"""
21.07.2026 — лёгкий REST-клиент к Supabase (минимальный срез, см.
supabase_minimal_schema.sql в корне проекта и CLAUDE.md, решение Игоря
"минимальный срез сейчас" вместо полной hf_schema_v1.sql).

Не тянем пакет `supabase` (доп. тяжёлая зависимость с своим асинхронным
клиентом) — Supabase поверх Postgres сам даёт REST API (PostgREST), а
`requests` уже в зависимостях (см. integrations/telegram_client.py, тот же
стиль простых HTTP-вызовов).

Используем SERVICE_ROLE ключ (полный доступ, обходит RLS) — agent-bot
доверенный бэкенд-сервис, не браузер. Этот ключ НЕ должен попадать в
admin-panel/браузер — там свой anon key (см. admin-panel/lib/
supabaseClient.ts).

Покрывает только то, что реально нужно agent-bot в этом минимальном срезе:
- чтение staff_users (получатели пушей об эскалации + "/link <код>") —
  теперь общий источник истины с admin-panel/settings, а не два
  независимых мока с разными данными;
- запись новой строки в escalations при каждой реальной эскалации — до
  этого agent-bot писал только в свой in-memory red_zone_events, реальные
  эскалации физически не долетали до /escalations в админке (см.
  CLAUDE.md, 21.07.2026, "архитектурный тупик без общей БД").

Если SUPABASE_URL/SUPABASE_SERVICE_ROLE_KEY не заданы — is_configured()
возвращает False, все функции ниже становятся no-op (пустой список / None),
db_mock.py в этом случае падает на старое поведение (локальный сид в
памяти) — тот же принцип graceful degradation, что и во всём остальном
проекте.
"""

from __future__ import annotations

import os
from datetime import date, datetime, timedelta, timezone
from typing import Optional

import requests

# 21.08.2026 (dlg-78606415-3) — та же Indochina Time, что и logic/
# order_timing.ICT, но НЕ импортируется оттуда: order_timing.py сам
# импортирует integrations.supabase_client (см. его докстринг), обратный
# импорт создал бы цикл. Значение одно и то же (+7 без переходов на летнее
# время), дублирование двух строк дешевле, чем разрывать цикл рефакторингом.
_ICT = timezone(timedelta(hours=7))

SUPABASE_URL = os.environ.get("SUPABASE_URL")
SUPABASE_SERVICE_ROLE_KEY = os.environ.get("SUPABASE_SERVICE_ROLE_KEY")

# Не даём медленному/недоступному Supabase подвесить обработку сообщения
# клиенту — сбой здесь не должен быть дороже одного упущенного пуша/записи.
_TIMEOUT = 10


def is_configured() -> bool:
    return bool(SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY)


def _headers(extra: Optional[dict] = None) -> dict:
    headers = {
        "apikey": SUPABASE_SERVICE_ROLE_KEY,
        "Authorization": f"Bearer {SUPABASE_SERVICE_ROLE_KEY}",
        "Content-Type": "application/json",
    }
    if extra:
        headers.update(extra)
    return headers


def list_staff_users() -> list[dict]:
    """Пустой список при недоступности/ошибке — вызывающий код сам решает,
    падать ли на локальный сид или просто никого не пушить (см. db_mock.py)."""
    if not is_configured():
        return []
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/staff_users",
            headers=_headers(),
            params={"select": "*"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return []


def find_staff_by_link_code(code: str) -> Optional[dict]:
    if not is_configured():
        return None
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/staff_users",
            headers=_headers(),
            params={"select": "*", "telegram_link_code": f"eq.{code}"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None
    except Exception:
        return None


def update_staff_user(user_id: str, patch: dict) -> Optional[dict]:
    if not is_configured():
        return None
    try:
        resp = requests.patch(
            f"{SUPABASE_URL}/rest/v1/staff_users",
            headers=_headers({"Prefer": "return=representation"}),
            params={"user_id": f"eq.{user_id}"},
            json=patch,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None
    except Exception:
        return None


def insert_escalation(row: dict) -> None:
    """Best-effort, намеренно без return — сбой записи в Supabase не должен
    ронять отправку ответа клиенту (тот же fail-safe принцип, что и в
    claude_real.py/telegram_client.py)."""
    if not is_configured():
        return
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/escalations",
            headers=_headers(),
            json=row,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
    except Exception:
        pass


def has_open_escalation(dialog_id: Optional[str]) -> bool:
    """06.09.2026 — Игорь (скриншот dlg-614269317-6): клиент писал
    сообщение за сообщением, каждое заново эскалировалось, и бот слал одну
    и ту же хендофф-фразу ("Секунду, уточню у менеджера...") три раза
    подряд — выглядит так, будто бот не понимает, что уже передал вопрос.
    Используется в orchestrator.py, чтобы решить, слать ли клиенту фразу
    ЕЩЁ РАЗ, или уже есть необработанная эскалация и фраза не нужна.

    Смотрим в Supabase (не в локальную копию self.escalations в db_mock —
    та пишется один раз при создании и никогда не узнаёт, что Ольга/Игорь
    закрыли эскалацию в админке напрямую через Supabase, agent-bot об этом
    не уведомляется; тот же принцип "не доверяем памяти процесса", что и
    везде в проекте, см. self-heal telegram_chat_id/dialog_id выше).

    True — есть хотя бы одна строка escalations с этим dialog_id и
    status in ('new', 'in_progress') (см. CHECK-constraint в схеме).
    Best-effort, fail-open: при недоступности Supabase или отсутствии
    dialog_id возвращаем False — то есть "будем считать, что открытой
    эскалации нет" — лучше лишний раз отправить фразу клиенту, чем
    ошибочно замолчать из-за временного сбоя одного запроса."""
    if not is_configured() or not dialog_id:
        return False
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/escalations",
            headers=_headers(),
            params={
                "select": "escalation_id",
                "dialog_id": f"eq.{dialog_id}",
                "status": "in.(new,in_progress)",
                "limit": "1",
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return bool(resp.json())
    except Exception:
        return False


def upsert_dialog(row: dict) -> None:
    """21.07.2026 — INSERT ... ON CONFLICT (dialog_id) DO UPDATE через
    PostgREST-заголовок Prefer: resolution=merge-duplicates. Используется и
    при создании нового диалога, и при обновлении escalated_to/updated_at на
    уже существующем — только колонки, переданные в row, реально
    затрагиваются (остальные не трогаются, см. db_mock.py). Best-effort,
    как и остальные функции здесь."""
    if not is_configured():
        return
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/dialogs",
            headers=_headers({"Prefer": "resolution=merge-duplicates"}),
            params={"on_conflict": "dialog_id"},
            json=row,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
    except Exception:
        pass


def get_dialog_by_client(client_id: str) -> Optional[dict]:
    """17.08.2026 — восстановление ТОГО ЖЕ dialog_id после рестарта процесса
    agent-bot (память пустая при каждом холодном старте на Render, см.
    db_mock.get_or_create_dialog). Раньше рестарт молча заводил НОВЫЙ
    dialog_id на следующее сообщение/действие этого клиента — переписка и
    правки (в т.ч. human_takeover) уходили в новую строку Supabase, а не в
    ту, что уже открыта по старой ссылке /dialogs/<id> в админке (баг,
    пойманный Игорем 17.08.2026: кнопка "взять на себя" не менялась).
    Берём самый свежий диалог этого клиента по client_id. None при
    недоступности/ошибке/отсутствии записи — тот же best-effort принцип, что
    и у остальных функций здесь: вызывающий код в этом случае просто заводит
    новый диалог, как и раньше."""
    if not is_configured():
        return None
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/dialogs",
            headers=_headers(),
            params={
                "select": "dialog_id,client_display_name,channel,escalated_to,escalation_reason,"
                "started_at,ended_at,human_takeover,human_takeover_by",
                "client_id": f"eq.{client_id}",
                "order": "updated_at.desc",
                "limit": 1,
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None
    except Exception:
        return None


def get_dialog_by_id(dialog_id: str) -> Optional[dict]:
    """26.08.2026 — в отличие от get_dialog_by_client (ищет по client_id,
    самый свежий диалог) — здесь известен сам dialog_id (пришёл из admin-
    panel: кнопка "Создать заявку на подписку" в DialogThread.tsx, см.
    main.py, /admin/extract-subscription-draft и /admin/create-subscription-
    from-dialog). client_id/client_chat_id нужны, чтобы дальше собрать
    client-словарь через db.get_or_create_client(...), не полагаясь на
    живую память процесса (диалог мог начаться на другом инстансе/до
    рестарта)."""
    if not is_configured():
        return None
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/dialogs",
            headers=_headers(),
            params={
                "select": "dialog_id,client_id,client_display_name,channel,client_chat_id",
                "dialog_id": f"eq.{dialog_id}",
                "limit": 1,
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None
    except Exception:
        return None


def get_dialog_messages(dialog_id: str) -> list[dict]:
    """26.08.2026 — полная история диалога из Supabase (не из живого буфера
    процесса, см. db_mock._MAX_DIALOG_MESSAGES) — нужна и QA-сканеру
    (logic/qa_scanner.py, читает то, что появилось после курсора, плюс
    немного контекста до него), и извлечению черновика заявки на подписку
    (claude_real.extract_subscription_draft, main.py). Пустой список при
    недоступности/ошибке/отсутствии — тот же best-effort принцип, что и
    везде здесь."""
    if not is_configured():
        return []
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/dialog_messages",
            headers=_headers(),
            params={
                "select": "role,text,created_at",
                "dialog_id": f"eq.{dialog_id}",
                "order": "created_at.asc",
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json() or []
    except Exception:
        return []


def get_dialog_ids_with_messages_since(since_iso: str) -> list[str]:
    """26.08.2026 — QA-сканер (logic/qa_scanner.py): "какие диалоги вообще
    трогать в этом прогоне" — и новые диалоги, и новые сообщения в старых
    (Игорь: "какая-то движуха в диалогах"), одним и тем же запросом —
    dialog_messages.created_at не различает эти два случая, что и нужно.
    distinct по dialog_id на стороне Python (PostgREST distinct на одну
    колонку неудобно выразить без доп. вьюхи). Пустой список при
    недоступности/ошибке — сканер в этом случае просто не находит работы в
    этом прогоне, не падает."""
    if not is_configured():
        return []
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/dialog_messages",
            headers=_headers(),
            params={
                "select": "dialog_id",
                "created_at": f"gt.{since_iso}",
                "order": "created_at.asc",
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json() or []
        seen: list[str] = []
        for row in rows:
            did = row.get("dialog_id")
            if did and did not in seen:
                seen.append(did)
        return seen
    except Exception:
        return []


def insert_qa_finding(row: dict) -> None:
    """26.08.2026 — одна находка QA-сканера (см. supabase_migration_26,
    logic/qa_scanner.py). Best-effort, тот же паттерн, что insert_escalation
    и остальные insert_* здесь — сбой записи одной находки не должен ронять
    весь скан (другие диалоги в этом же прогоне продолжают проверяться)."""
    if not is_configured():
        return
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/qa_findings",
            headers=_headers(),
            json=row,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
    except Exception:
        pass


def insert_qa_scan_run(row: dict) -> None:
    """26.08.2026 — один прогон QA-сканера (started_at/dialogs_reviewed/
    findings_created/ok/error) — не для функциональности, а чтобы сканер был
    виден живым в самой БД (тот же принцип диагностики, что и claude_api_call
    в claude_real.py): если он вдруг перестанет находить работу или начнёт
    сплошь падать, это будет видно в таблице, а не молчаливой пустотой в
    qa_findings. Best-effort, как и все функции здесь."""
    if not is_configured():
        return
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/qa_scan_runs",
            headers=_headers(),
            json=row,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
    except Exception:
        pass


def list_red_zone_terms() -> list[dict]:
    """21.07.2026 — термины красной зоны, добавленные/подтверждённые через
    /red-zone в admin-panel (см. red_zone_classifier.py — они подмешиваются
    ДОПОЛНИТЕЛЬНО к базовому YAML-стоп-листу, не заменяют его). Только
    активные (is_active=true) — деактивированный термин не должен матчиться.
    Пустой список при недоступности/ошибке — вызывающий код просто остаётся
    на текущем (YAML + ранее закешированные) наборе, никогда не роняет
    классификатор из-за сетевого сбоя."""
    if not is_configured():
        return []
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/red_zone_terms",
            headers=_headers(),
            params={"select": "category,language,pattern", "is_active": "eq.true"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json()
    except Exception:
        return []


def list_green_zone_facts() -> list[str]:
    """24.07.2026 — активные факты зелёной зоны (см. /green-zone в
    admin-panel) для прямого чтения в logic/agent_prompt.py (тот же приём,
    что и list_red_zone_terms — не полагаемся только на push через
    /admin/sync, который живёт в памяти процесса и теряется при
    засыпании/редеплое Render). Пустой список при недоступности/ошибке —
    вызывающий код остаётся на предыдущем закешированном значении/override/
    дефолте, никогда не роняет промпт из-за сетевого сбоя."""
    if not is_configured():
        return []
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/green_zone_facts",
            headers=_headers(),
            params={"select": "fact_text", "is_active": "eq.true"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return [row["fact_text"] for row in resp.json() if row.get("fact_text")]
    except Exception:
        return []


def get_weekly_menu(week_start: str) -> Optional[dict]:
    """20.08.2026 (миграция 29) — меню на неделю, которое Ольга раз в неделю
    вводит одним текстом в админке (/weekly-menu), keyed по дате понедельника
    этой недели (ICT). Читает logic/menu_guard.py, чтобы прислать клиенту
    ДОСЛОВНО этот текст на вопрос про меню, вместо готовой заглушки-ссылки
    на канал. Возвращает всю строку (week_start/menu_text/updated_by/
    updated_at) или None, если на эту неделю ещё ничего не сохранено/
    недоступно — вызывающий код в этом случае остаётся на прежнем
    поведении (тот же graceful degradation, что и у остальных функций
    здесь)."""
    if not is_configured():
        return None
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/weekly_menus",
            headers=_headers(),
            params={"select": "*", "week_start": f"eq.{week_start}"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None
    except Exception:
        return None


def get_app_setting(setting_key: str) -> Optional[dict]:
    """22.07.2026 — чтение произвольной настройки из app_settings (тот же
    паттерн, что order_deadline_ict/agent_system_prompt в admin-panel, но
    теперь agent-bot тоже сам читает конкретный ключ — время автовыгрузки
    Google Sheets, см. logic/sheets_import.py). Возвращает всю строку
    (включая value/updated_at) или None, если её ещё нет/недоступно."""
    if not is_configured():
        return None
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/app_settings",
            headers=_headers(),
            params={"select": "*", "setting_key": f"eq.{setting_key}"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None
    except Exception:
        return None


def upsert_app_setting(setting_key: str, value: dict, updated_by: str) -> None:
    """22.07.2026 — upsert (не update!) намеренно: в отличие от
    order_deadline_ict/agent_system_prompt (которые полагаются на то, что
    строка уже как-то создана вручную), это новый ключ, для которого нет
    сид-инсерта в SQL — если использовать update(), при отсутствующей
    строке он молча ничего не сделает (0 строк затронуто, но без ошибки).
    Best-effort, как и остальные функции здесь."""
    if not is_configured():
        return
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/app_settings",
            headers=_headers({"Prefer": "resolution=merge-duplicates"}),
            params={"on_conflict": "setting_key"},
            json={"setting_key": setting_key, "value": value, "updated_by": updated_by},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
    except Exception:
        pass


def upsert_sheet_import_log(row: dict) -> None:
    """22.07.2026 — снимок вкладки "Заказы на день" на конкретную дату
    (row["sheet_date"]). Полная замена по дате через
    Prefer: resolution=merge-duplicates + on_conflict=sheet_date — вкладка
    в шитсе физически перезаписывается Ольгой на каждую дату заново, наш
    снимок делает то же самое, а не аппендит поверх старого."""
    if not is_configured():
        return
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/sheet_import_log",
            headers=_headers({"Prefer": "resolution=merge-duplicates"}),
            params={"on_conflict": "sheet_date"},
            json=row,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
    except Exception:
        pass


def insert_sheet_clients_snapshot(row: dict) -> None:
    """22.07.2026 — сырой снимок вкладки "1. Клиенты" (см.
    logic/sheets_import.py, run_clients_import). Append-only, НЕ upsert —
    в отличие от sheet_import_log (там у снимка есть естественный ключ,
    дата доставки), у ростера клиентов такого ключа нет — каждый импорт
    просто добавляет новую строку, читающий код (getLastClientsSnapshot в
    admin-panel) берёт последнюю по imported_at. Best-effort, как и
    остальные функции здесь."""
    if not is_configured():
        return
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/sheet_clients_snapshot_log",
            headers=_headers(),
            json=row,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
    except Exception:
        pass


def confirm_login_token(token: str, staff_user_id: str) -> bool:
    """22.07.2026 — вход в admin-panel по QR через Telegram (см. CLAUDE.md).
    PATCH login_tokens SET status='confirmed' WHERE token=X AND
    status='pending' — условие на status='pending' в фильтре не даёт
    повторно подтвердить уже использованный/просроченный токен (защита от
    replay, если кто-то отправит боту тот же /start login_<token> дважды).
    True, только если реально обновилась ровно одна строка."""
    if not is_configured():
        return False
    try:
        from datetime import datetime, timezone

        resp = requests.patch(
            f"{SUPABASE_URL}/rest/v1/login_tokens",
            headers=_headers({"Prefer": "return=representation"}),
            params={"token": f"eq.{token}", "status": "eq.pending"},
            json={
                "status": "confirmed",
                "staff_user_id": staff_user_id,
                "confirmed_at": datetime.now(timezone.utc).isoformat(),
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return bool(rows)
    except Exception:
        return False


def get_latest_clients_snapshot() -> Optional[dict]:
    """22.07.2026 — читает последний (по imported_at) сырой снимок вкладки
    "1. Клиенты" (см. sheet_clients_snapshot_log) — источник для парсера
    logic/clients_parse.py + clients_import.py. None при недоступности/
    ошибке/пустой таблице."""
    if not is_configured():
        return None
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/sheet_clients_snapshot_log",
            headers=_headers(),
            params={"select": "raw_rows,imported_at", "order": "imported_at.desc", "limit": "1"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None
    except Exception:
        return None


def find_client_by_tg_username(tg_username: str) -> Optional[dict]:
    """Возвращает {"client_id": ...} из client_pii по tg_username, или None
    (не найден/недоступно) — используется парсером клиентов для решения
    "обновить существующего клиента" vs "завести нового"."""
    if not is_configured():
        return None
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/client_pii",
            headers=_headers(),
            params={"select": "client_id", "tg_username": f"eq.{tg_username}"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None
    except Exception:
        return None


def insert_client(row: dict) -> Optional[str]:
    """Создаёт новую строку clients, возвращает client_id или None при
    сбое (вызывающий код должен пропустить этого клиента в этом прогоне,
    не пытаться писать client_pii/restrictions с несуществующим client_id)."""
    if not is_configured():
        return None
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/clients",
            headers=_headers({"Prefer": "return=representation"}),
            json=row,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0]["client_id"] if rows else None
    except Exception:
        return None


def update_client(client_id: str, patch: dict) -> None:
    if not is_configured():
        return
    try:
        resp = requests.patch(
            f"{SUPABASE_URL}/rest/v1/clients",
            headers=_headers(),
            params={"client_id": f"eq.{client_id}"},
            json=patch,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
    except Exception:
        pass


def get_client_pii(client_id: str) -> Optional[dict]:
    """25.07.2026 — читает client_pii по uuid (Supabase clients.client_id),
    сейчас нужна только для проверки birthday_date перед тем, как
    поздравительное сообщение после апрува подписки ненавязчиво спросит про
    день рождения (см. main.py, admin_apply_subscription_request) — не
    спрашиваем повторно, если дата уже есть в карточке.

    31.08.2026 — добавлено birthday_declined (миграция 27): та же проверка
    "не спрашивать повторно" теперь смотрит и на явный отказ клиента, не
    только на то, что дата уже известна (см. main.py,
    _maybe_send_subscription_congrats)."""
    if not is_configured():
        return None
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/client_pii",
            headers=_headers(),
            params={"select": "birthday_date,birthday_declined", "client_id": f"eq.{client_id}"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None
    except Exception:
        return None


def count_subscription_requests(client_uuid: str) -> int:
    """31.08.2026 — Игорь: "пусть спрашивает про день рождения только в
    конце 3го заказа" (было — фактически на первом, см. CLAUDE.md
    31.08.2026). Считает строки subscription_requests клиента — момент,
    когда клиент подтвердил заказ в переписке (заявка создаётся сразу при
    подтверждении, до апрува менеджером, см. insert_subscription_request) —
    независимо от статуса (pending_approval/approved/applied/rejected):
    для порога "это уже 3-й заказ клиента" важен сам факт того, что клиент
    прошёл оформление, а не решение менеджера по конкретной заявке.
    Используется и в get_client_card_for_prompt (перед этим сообщением —
    не считает заказ, который клиент, возможно, подтвердит только сейчас),
    и в main.py::_maybe_send_subscription_congrats (уже ПОСЛЕ апрува —
    строка заявки, которую только что применили, уже посчитана, поэтому
    там порог ">= 3" без поправки на "+1"). 0 при сбое/не настроенном
    Supabase — best-effort, как и все остальные чтения в этом файле."""
    if not is_configured() or not client_uuid:
        return 0
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/subscription_requests",
            headers=_headers(),
            params={"select": "request_id", "supabase_client_id": f"eq.{client_uuid}"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return len(resp.json() or [])
    except Exception:
        return 0


def insert_client_restriction(row: dict) -> None:
    """06.08.2026 — ограничение в карточку клиента после апрува подписки
    (см. logic/subscription_apply._apply_card_details). Отдельная тонкая
    обёртка, без логики: решение о том, ЧТО и когда писать, принимается
    вызывающим кодом, чтобы оно было видно в одном месте."""
    if not is_configured():
        return
    try:
        requests.post(
            f"{SUPABASE_URL}/rest/v1/client_restrictions",
            headers=_headers(),
            json=row,
            timeout=_TIMEOUT,
        ).raise_for_status()
    except Exception:
        pass


def upsert_client_pii(client_id: str, patch: dict) -> None:
    """Upsert по client_id (primary key = FK на clients) — первый импорт
    создаёт строку, повторный обновляет её же (Prefer: resolution=
    merge-duplicates, тот же паттерн, что upsert_app_setting)."""
    if not is_configured():
        return
    try:
        row = {"client_id": client_id, **patch}
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/client_pii",
            headers=_headers({"Prefer": "resolution=merge-duplicates"}),
            params={"on_conflict": "client_id"},
            json=row,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
    except Exception:
        pass


def get_active_restriction_by_source(client_id: str, source: str) -> Optional[dict]:
    if not is_configured():
        return None
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/client_restrictions",
            headers=_headers(),
            params={
                "select": "restriction_id,value_text",
                "client_id": f"eq.{client_id}",
                "source": f"eq.{source}",
                "is_active": "eq.true",
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None
    except Exception:
        return None


def list_active_restrictions_by_source(client_id: str, source: str) -> list:
    """25.08.2026 — в отличие от get_active_restriction_by_source() выше
    (которая берёт ОДНУ строку — используется там, где источник целиком
    заменяет собой прежнее значение, напр. clients_import.py), здесь источник
    накопительный: у клиента может быть НЕСКОЛЬКО активных ограничений
    одного source одновременно (см. subscription_apply._apply_card_details —
    "не ем молочное" и отдельно "не ем яблоки" оба должны остаться в списке,
    а не одно заменять другое). Возвращает [] при недоступности Supabase/
    ошибке — вызывающий код тогда просто ничего не пропустит как дубль
    (лучше редкий дубль, чем потерянное ограничение)."""
    if not is_configured():
        return []
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/client_restrictions",
            headers=_headers(),
            params={
                "select": "restriction_id,value_text",
                "client_id": f"eq.{client_id}",
                "source": f"eq.{source}",
                "is_active": "eq.true",
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json() or []
    except Exception:
        return []


def insert_restriction(row: dict) -> None:
    if not is_configured():
        return
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/client_restrictions",
            headers=_headers(),
            json=row,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
    except Exception:
        pass


def deactivate_restriction(restriction_id: str) -> None:
    if not is_configured():
        return
    try:
        resp = requests.patch(
            f"{SUPABASE_URL}/rest/v1/client_restrictions",
            headers=_headers(),
            params={"restriction_id": f"eq.{restriction_id}"},
            json={"is_active": False, "valid_to": "now()"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
    except Exception:
        pass


def get_preference_by_source(client_id: str, source: str) -> Optional[dict]:
    if not is_configured():
        return None
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/client_preferences",
            headers=_headers(),
            params={
                "select": "preference_id,value_text",
                "client_id": f"eq.{client_id}",
                "source": f"eq.{source}",
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None
    except Exception:
        return None


def insert_preference(row: dict) -> None:
    if not is_configured():
        return
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/client_preferences",
            headers=_headers(),
            json=row,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
    except Exception:
        pass


def delete_preference(preference_id: str) -> None:
    if not is_configured():
        return
    try:
        resp = requests.delete(
            f"{SUPABASE_URL}/rest/v1/client_preferences",
            headers=_headers(),
            params={"preference_id": f"eq.{preference_id}"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
    except Exception:
        pass


def insert_dialog_message(row: dict) -> None:
    """21.07.2026 — best-effort запись отдельного сообщения диалога (см.
    db_mock.append_dialog_message). Раньше диалоги существовали только в
    памяти процесса agent-bot — /dialogs и "смотреть переписку" из карточки
    эскалации в admin-panel читали только моковые данные."""
    if not is_configured():
        return
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/dialog_messages",
            headers=_headers(),
            json=row,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
    except Exception:
        pass


def insert_dialog_message_by_client(client_uuid: str, role: str, text: str) -> None:
    """06.08.2026 — записать реплику агента в диалог клиента по его uuid.

    Нужно для напоминаний о продлении: бот пишет клиенту САМ, вне ответа на
    входящее сообщение, и без этой записи в админке было бы видно только
    «связались», но не сам текст — а Ольге, когда клиент ответит, нужен
    контекст, что именно ему написали."""
    if not is_configured() or not client_uuid:
        return
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/dialogs",
            headers=_headers(),
            params={"select": "dialog_id", "client_id": f"eq.{client_uuid}", "limit": "1"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json() or []
        if not rows:
            return
        insert_dialog_message({"dialog_id": rows[0]["dialog_id"], "role": role, "text": text})
    except Exception:
        pass


def get_latest_orders_snapshot() -> Optional[dict]:
    """25.07.2026 — читает последний (по sheet_date) сырой снимок вкладки
    "2. Заказы на день" (см. sheet_import_log) — источник для
    logic/order_lookup.py (сверка клиента с его строкой заказа перед tool
    use). None при недоступности/ошибке/пустой таблице."""
    if not is_configured():
        return None
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/sheet_import_log",
            headers=_headers(),
            params={
                "select": "raw_rows,sheet_date",
                "source_tab": "eq.2. Заказы на день",
                "order": "sheet_date.desc",
                "limit": "1",
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None
    except Exception:
        return None


def insert_order_change_request(row: dict) -> Optional[str]:
    """25.07.2026 — первая инфраструктура tool use агента (перенос даты
    доставки, level5). Пишет строку в order_change_requests (см.
    supabase_migration_11_order_change_requests.sql) со статусом
    pending_approval — НИКОГДА не применяется автоматически, ждёт ручного
    апрува в админке (Игорь: "давай сделаем всегда апрув от админа").
    Возвращает request_id или None при сбое/не настроенном Supabase —
    вызывающий код (orchestrator.py) в этом случае просто не сможет дать
    клиенту ссылку на запрос, но диалог не должен из-за этого падать."""
    if not is_configured():
        return None
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/order_change_requests",
            headers=_headers({"Prefer": "return=representation"}),
            json=row,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0]["request_id"] if rows else None
    except Exception:
        return None


def get_order_change_request(request_id: str) -> Optional[dict]:
    """25.07.2026 — читает одну строку order_change_requests по id (вызывает
    logic/order_apply.py после того, как admin-panel сообщила agent-bot,
    что запрос одобрен, см. POST /admin/apply-order-change в main.py).
    None при недоступности/не найдено."""
    if not is_configured():
        return None
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/order_change_requests",
            headers=_headers(),
            params={"select": "*", "request_id": f"eq.{request_id}"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None
    except Exception:
        return None


def update_order_change_request_status(request_id: str, patch: dict) -> bool:
    """25.07.2026 — точечное обновление статуса/полей заявки (approved →
    applied, decided_by/decided_at/applied_at). Возвращает True/False —
    вызывающий код (logic/order_apply.py) best-effort реагирует на неудачу,
    не роняет обработку."""
    if not is_configured():
        return False
    try:
        resp = requests.patch(
            f"{SUPABASE_URL}/rest/v1/order_change_requests",
            headers=_headers(),
            params={"request_id": f"eq.{request_id}"},
            json=patch,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return True
    except Exception:
        return False


def find_matching_order_change_request(
    dialog_id: Optional[str], new_date: Optional[str], scope: str, range_end_date: Optional[str]
) -> Optional[dict]:
    """24.08.2026 — та же защита от дубля, что и find_matching_subscription_
    request ниже, но для переноса даты доставки (propose_delivery_reschedule,
    см. orchestrator.py) — модель может так же повторно вызвать инструмент в
    уже отработанном диалоге на сообщение, которое не является новым
    подтверждением переноса. Проверяем детерминированно: есть ли в ЭТОМ
    диалоге уже заявка с теми же новой датой/областью действия/концом
    диапазона, ещё не отклонённая.

    graceful degradation в None (НЕ считаем дублем), тот же принцип, что и в
    find_matching_subscription_request — лучше пропустить редкий дубль, чем
    один раз ошибочно отказать в реальном переносе."""
    if not is_configured() or not dialog_id:
        return None
    try:
        params = {
            "select": "request_id,status,created_at",
            "dialog_id": f"eq.{dialog_id}",
            "new_date": f"eq.{new_date}",
            "scope": f"eq.{scope}",
            "status": "in.(pending_approval,approved,applied)",
            "limit": "1",
        }
        if range_end_date:
            params["range_end_date"] = f"eq.{range_end_date}"
        else:
            params["range_end_date"] = "is.null"
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/order_change_requests",
            headers=_headers(),
            params=params,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json() or []
        return rows[0] if rows else None
    except Exception:
        return None


def insert_subscription_request(row: dict) -> Optional[str]:
    """25.07.2026 — второй tool use агента (оформление подписки, Игорь:
    "Делай"). Пишет строку в subscription_requests (см.
    supabase_migration_12_subscription_requests.sql) со статусом
    pending_approval — тот же паттерн, что insert_order_change_request
    выше. Возвращает request_id или None при сбое/не настроенном Supabase."""
    if not is_configured():
        return None
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/subscription_requests",
            headers=_headers({"Prefer": "return=representation"}),
            json=row,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0]["request_id"] if rows else None
    except Exception:
        return None


def find_matching_subscription_request(
    dialog_id: Optional[str], kcal_target: int, paid_days: int, start_date: str
) -> Optional[dict]:
    """24.08.2026 — защита от дубля заявки (см. orchestrator.py): модель
    иногда повторно вызывает propose_subscription в уже отработанном
    диалоге на сообщение, которое не является новым подтверждением заказа
    (ответ на вопрос про день рождения, жалоба и т.п.) — реальные случаи
    dlg-692369447-12 и dlg-1013270966-1. Не доверяем модели, проверяем
    детерминированно: есть ли в ЭТОМ диалоге уже заявка с теми же
    калорийностью/сроком/датой, ещё не отклонённая (pending_approval —
    ждёт апрува, approved — одобрена, но ещё не применена, applied — уже
    стала подпиской).

    graceful degradation в None (НЕ считаем дублем): если Supabase
    недоступен или dialog_id пуст — не блокируем оформление, лучше
    пропустить редкий дубль, чем один раз ошибочно отказать в реальном
    заказе."""
    if not is_configured() or not dialog_id:
        return None
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/subscription_requests",
            headers=_headers(),
            params={
                "select": "request_id,status,created_at",
                "dialog_id": f"eq.{dialog_id}",
                "kcal_target": f"eq.{kcal_target}",
                "paid_days": f"eq.{paid_days}",
                "start_date": f"eq.{start_date}",
                "status": "in.(pending_approval,approved,applied)",
                "limit": "1",
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json() or []
        return rows[0] if rows else None
    except Exception:
        return None


def get_subscription_request(request_id: str) -> Optional[dict]:
    """25.07.2026 — читает одну строку subscription_requests по id (вызывает
    logic/subscription_apply.py после того, как admin-panel сообщила
    agent-bot, что запрос одобрен, см. POST /admin/apply-subscription-request
    в main.py). None при недоступности/не найдено."""
    if not is_configured():
        return None
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/subscription_requests",
            headers=_headers(),
            params={"select": "*", "request_id": f"eq.{request_id}"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None
    except Exception:
        return None


def update_subscription_request_status(request_id: str, patch: dict) -> bool:
    """25.07.2026 — точечное обновление статуса/полей заявки на подписку
    (approved → applied, decided_by/decided_at/applied_at). Best-effort,
    тот же паттерн, что update_order_change_request_status выше."""
    if not is_configured():
        return False
    try:
        resp = requests.patch(
            f"{SUPABASE_URL}/rest/v1/subscription_requests",
            headers=_headers(),
            params={"request_id": f"eq.{request_id}"},
            json=patch,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return True
    except Exception:
        return False


def list_active_subscriptions_for_renewal() -> list:
    """06.08.2026 — активные подписки с тем, что нужно для напоминания о
    продлении: кому писать, какой тариф и калорийность назвать в тексте.

    12.08.2026 — chat_id раньше тянули из dialogs.client_chat_id: колонки,
    которой там никогда не было (миграция 4 её не создавала), плюс
    dialogs.client_id — это Telegram-идентичность агента, а не тот
    client_id (Supabase uuid), что лежит в subscriptions — join был неверным
    даже с колонкой (см. logic/client_bootstrap.py, миграция 22). Теперь
    chat_id читаем через embed из client_pii.telegram_chat_id — она лежит
    прямо по client_id = Supabase uuid, заполняется в
    client_bootstrap.ensure_client_record при обращении клиента к боту."""
    if not is_configured():
        return []
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/subscriptions",
            headers=_headers(),
            params={
                "select": "subscription_id,client_id,kcal_target,start_date,paid_days,recipient_note,"
                "clients(display_name,client_pii(telegram_chat_id)),subscription_plans(name)",
                "status": "eq.active",
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json() or []
    except Exception:
        return []

    result = []
    for r in rows:
        client = r.get("clients") or {}
        if isinstance(client, list):
            client = client[0] if client else {}
        plan = r.get("subscription_plans") or {}
        if isinstance(plan, list):
            plan = plan[0] if plan else {}
        pii = client.get("client_pii") or {}
        if isinstance(pii, list):
            pii = pii[0] if pii else {}
        result.append(
            {
                "subscription_id": r.get("subscription_id"),
                "client_id": r.get("client_id"),
                "client_display_name": client.get("display_name"),
                "plan_name": plan.get("name"),
                "kcal_target": r.get("kcal_target"),
                "start_date": r.get("start_date"),
                "paid_days": r.get("paid_days"),
                "recipient_note": r.get("recipient_note"),
                "client_chat_id": pii.get("telegram_chat_id"),
            }
        )
    return result


def list_subscription_weekdays() -> list:
    """Недельные графики (миграция 17) — нужны, чтобы правильно посчитать дату
    окончания: при графике не каждый день подписка растягивается."""
    if not is_configured():
        return []
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/subscription_weekdays",
            headers=_headers(),
            params={"select": "subscription_id,weekday,is_delivery_day"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json() or []
    except Exception:
        return []


def list_renewal_nudges() -> list:
    """Кому уже писали про продление (миграция 21) — и ботом, и руками из
    админки. Защита от повторной отправки."""
    if not is_configured():
        return []
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/subscription_renewal_nudges",
            headers=_headers(),
            params={"select": "subscription_id,planned_end,status,source"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json() or []
    except Exception:
        return []


def insert_renewal_nudge(row: dict) -> bool:
    if not is_configured():
        return False
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/subscription_renewal_nudges",
            headers=_headers({"Prefer": "resolution=merge-duplicates"}),
            json=row,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return True
    except Exception:
        return False


def list_active_plans() -> list:
    """06.08.2026 — действующие тарифы для промпта (см.
    agent_prompt.build_plans_note): агент должен называть тариф именем и
    брать цены оттуда же, откуда админка. Пустой список при любой проблеме —
    промпт тогда просто не получит блок тарифов, разговор не ломается."""
    if not is_configured():
        return []
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/subscription_plans",
            headers=_headers(),
            params={
                # 18.08.2026 (миграция 26) — plan_id и фикс-адрес/окно
                # доставки добавлены в select: нужны, чтобы агент мог
                # передать конкретный plan_id в propose_subscription для
                # тарифов с фиксированной ценой (обед/ужин, см.
                # logic/promo_codes.calc_flat_rate_price) и знать, что для
                # такого тарифа адрес спрашивать не нужно.
                "select": (
                    "plan_id,name,kcal_target,price_per_day,default_days,discount_pct,"
                    "fixed_location_name,fixed_delivery_address,delivery_window_text"
                ),
                "is_active": "eq.true",
                "order": "sort_order.asc",
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        return resp.json() or []
    except Exception:
        return []


def get_plan_by_id(plan_id: str) -> Optional[dict]:
    """18.08.2026 — конкретный тариф по plan_id, для тарифов с
    фиксированной ценой (обед/ужин), когда модель передала plan_id в
    propose_subscription вместо обычного расчёта по калорийности (см.
    logic/promo_codes.calc_flat_rate_price)."""
    if not is_configured() or not plan_id:
        return None
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/subscription_plans",
            headers=_headers(),
            params={"select": "*", "plan_id": f"eq.{plan_id}", "is_active": "eq.true"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None
    except Exception:
        return None


def get_promo_code_by_code(code: str) -> Optional[dict]:
    """18.08.2026 (миграция 26) — промокод по коду, регистронезависимо
    (клиент может написать "space" или "Space"). None — код не найден,
    неактивный код всё равно возвращается (проверка is_active — дело
    logic/promo_codes.check_promo_code, не этой функции), чтобы можно было
    различить 'такого кода вообще нет' и 'код есть, но выключен'."""
    if not is_configured() or not code:
        return None
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/promo_codes",
            headers=_headers(),
            params={"select": "*", "code": f"ilike.{code.strip()}"},
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0] if rows else None
    except Exception:
        return None


def count_promo_code_uses(promo_id: str) -> int:
    """18.08.2026 — сколько раз промокод уже реально использован
    (заявки в статусе approved/applied — не pending, не rejected), для
    проверки usage_limit. 0 при любой проблеме — тот же принцип
    graceful degradation, что и везде; в худшем случае лимит проверится
    неточно один раз, а не сломает оформление всем подряд."""
    if not is_configured() or not promo_id:
        return 0
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/subscription_requests",
            headers=_headers({"Prefer": "count=exact"}),
            params={
                "select": "request_id",
                "promo_code_id": f"eq.{promo_id}",
                "status": "in.(approved,applied)",
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        content_range = resp.headers.get("content-range", "")
        if "/" in content_range:
            total = content_range.split("/")[-1]
            if total.isdigit():
                return int(total)
        return len(resp.json() or [])
    except Exception:
        return 0


def client_has_any_prior_order(supabase_client_id: Optional[str]) -> bool:
    """18.08.2026 — "первый заказ клиента вообще" (Игорь: не в рамках
    промокода/адреса — глобально), для промокодов с ограничением "на первый
    заказ". Смотрит и в subscriptions (уже применённые), и в
    subscription_requests в статусах не 'rejected' (ждущие/одобренные —
    чтобы нельзя было запросить промокод второй раз, пока первая заявка
    ещё не решена).

    ВАЖНО, намеренное отступление от обычного "graceful degradation в
    пустое значение": если Supabase недоступен или supabase_client_id
    неизвестен (у клиента нет публичного tg username, см.
    client_bootstrap.py) — возвращаем True (значит "не первый заказ",
    промокод НЕ применяем). Скидка — это деньги; когда мы не можем
    надёжно проверить условие, безопаснее отказать в скидке, чем выдать
    её ошибочно. logic/promo_codes.check_promo_code в этом случае просто
    вернёт not_first_order, а не тихо посчитает клиента новым."""
    if not is_configured() or not supabase_client_id:
        return True
    try:
        sub_resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/subscriptions",
            headers=_headers(),
            params={"select": "subscription_id", "client_id": f"eq.{supabase_client_id}", "limit": "1"},
            timeout=_TIMEOUT,
        )
        sub_resp.raise_for_status()
        if sub_resp.json():
            return True

        req_resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/subscription_requests",
            headers=_headers(),
            params={
                "select": "request_id",
                "supabase_client_id": f"eq.{supabase_client_id}",
                "status": "neq.rejected",
                "limit": "1",
            },
            timeout=_TIMEOUT,
        )
        req_resp.raise_for_status()
        return bool(req_resp.json())
    except Exception:
        return True


def _filter_current_subscriptions(rows: list[dict]) -> list[dict]:
    """21.08.2026 (dlg-78606415-3) — оставляет только те подписки, чей
    последний оплаченный день ещё не прошёл по вьетнамскому времени, и
    добавляет каждой посчитанный end_date (см. build_client_card_note —
    поле давно ожидалось, но никогда не заполнялось). status='active' в БД
    сам по себе НЕ означает "ещё актуально": разовые заказы (paid_days=1)
    никто не переводит в завершённые вручную (см. докстринг вызывающего
    кода) — без этого фильтра они копятся в карточке клиента навсегда и
    путают модель. Строка без валидных start_date/paid_days пропускается
    молча (лучше не показать её агенту вовсе, чем упасть на кривых данных)."""
    today = datetime.now(_ICT).date()
    result = []
    for row in rows:
        start_raw = row.get("start_date")
        paid_days = row.get("paid_days")
        if not start_raw or not isinstance(paid_days, int) or paid_days < 1:
            continue
        try:
            start = date.fromisoformat(start_raw)
        except ValueError:
            continue
        end = start + timedelta(days=paid_days - 1)
        if end < today:
            continue
        # 03.09.2026 (dlg-1788299798-1) — добавлен "started": модель видела
        # только "до {end_date}" и не могла отличить уже идущую подписку от
        # ещё не начавшейся (старт в будущем, например из-за паузы,
        # объявленной компанией) — см. build_client_card_note.
        result.append({**row, "end_date": end.isoformat(), "started": start <= today})
    return result


def get_client_card_for_prompt(client_uuid: str) -> Optional[dict]:
    """06.08.2026 — адрес/телефон/активные ограничения клиента для итоговой
    сверки перед оформлением подписки. Отдельная узкая функция, а не «весь
    клиент»: в промпт уходит ровно то, что агент проговаривает вслух, ничего
    лишнего из PII туда не попадает.

    31.08.2026 — добавлены birthday_declined и confirmed_orders_count: и
    явный отказ клиента называть дату рождения, и порог "не раньше 3-го
    заказа" теперь считаются здесь, на бэкенде, а не отдаются модели на
    самостоятельный подсчёт (см. build_client_card_note)."""
    if not is_configured() or not client_uuid:
        return None
    try:
        pii_resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/client_pii",
            headers=_headers(),
            # 20.08.2026 (dlg-692369447-12) — добавлено birthday_date: модель
            # должна знать, что дата рождения уже известна, даже если это
            # выяснилось в ДРУГОМ, более раннем диалоге (см.
            # agent_prompt.build_client_card_note/_BIRTHDAY_INSTRUCTION).
            # 31.08.2026 — добавлено birthday_declined (миграция 27): тот же
            # принцип для явного отказа клиента отвечать.
            params={"select": "phone,address_text,birthday_date,birthday_declined", "client_id": f"eq.{client_uuid}"},
            timeout=_TIMEOUT,
        )
        pii_resp.raise_for_status()
        pii_rows = pii_resp.json() or []

        restr_resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/client_restrictions",
            headers=_headers(),
            params={
                "select": "value_text",
                "client_id": f"eq.{client_uuid}",
                "is_active": "eq.true",
            },
            timeout=_TIMEOUT,
        )
        restr_resp.raise_for_status()
        restrictions = [r.get("value_text") for r in (restr_resp.json() or [])]

        # 06.08.2026 — активные подписки: агент должен спросить «ещё один
        # рацион или продление», а не оформить вторую подписку молча.
        #
        # 21.08.2026 — РЕАЛЬНЫЙ БАГ, dlg-78606415-3: разовые заказы
        # (paid_days=1) заводят строку в subscriptions со status='active' и
        # НИКОГДА автоматически не переводятся в завершённые — этим
        # занимается только ручная кнопка "Завершить" в admin-panel
        # (/api/subscriptions/[id]/finish), которую по мелким разовым
        # заказам никто не нажимает. В реальном диалоге у клиента накопилось
        # 4 таких "активных" разовых заказа подряд (18/19/20/21 августа,
        # разной калорийности) — все они прошли фильтр status=eq.active,
        # хотя 3 из 4 к 21.08 уже физически доставлены и закончились. Плюс
        # отдельный дефект: agent_prompt.build_client_card_note давно
        # ожидает поле end_date у каждой подписки (см. "до {end_date}"), но
        # оно никогда не выбиралось и не считалось здесь — всегда было None,
        # модель не могла отличить свежую подписку от завершившейся неделю
        # назад. Итог: на новый заказ "1500 ккал на завтра" модель увидела
        # 4 разных "активных" рациона без единой даты и не смогла уверенно
        # отнести это к обычному новому заказу (случай 3) — эскалировала.
        #
        # Фикс — тот же принцип "не доверяем ручному учёту", что и с
        # ценой/датой в других местах: считаем end_date сами (последний
        # день, который покрывает paid_days от start_date) и оставляем в
        # active_subscriptions только те строки, чей end_date ещё не прошёл
        # по вьетнамскому времени, независимо от значения status в БД.
        subs_resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/subscriptions",
            headers=_headers(),
            params={
                "select": "kcal_target,start_date,paid_days,recipient_note",
                "client_id": f"eq.{client_uuid}",
                "status": "eq.active",
            },
            timeout=_TIMEOUT,
        )
        subs_resp.raise_for_status()
        active_subscriptions = _filter_current_subscriptions(subs_resp.json() or [])

        # 31.08.2026 — сколько заказов клиент УЖЕ подтвердил до этого
        # сообщения (см. count_subscription_requests) — нужно модели, чтобы
        # понять, можно ли уже спрашивать дату рождения (порог — 3-й заказ,
        # см. build_client_card_note/_BIRTHDAY_INSTRUCTION).
        confirmed_orders_count = count_subscription_requests(client_uuid)

        pii = pii_rows[0] if pii_rows else {}
        return {
            "phone": pii.get("phone"),
            "address_text": pii.get("address_text"),
            "birthday_date": pii.get("birthday_date"),
            "birthday_declined": pii.get("birthday_declined"),
            "restrictions": restrictions,
            "active_subscriptions": active_subscriptions,
            "confirmed_orders_count": confirmed_orders_count,
        }
    except Exception:
        return None


def find_plan_id_by_kcal(kcal_target) -> Optional[str]:
    """06.08.2026 — справочник тарифов (supabase_migration_15). При апруве
    заявки от бота подписка должна попасть на конкретный тариф, иначе она
    висит строкой "Без тарифа" и в карточке клиента, и в /plans, и в
    статистике — Игорь: "апрув подписки должен везде учитываться".

    Матчим по калорийности среди активных тарифов, берём первый по
    sort_order. Осознанное ограничение: если на одну калорийность заведено
    несколько тарифов (например разные сроки), выбрать правильный по одной
    ккал невозможно — берём самый приоритетный, админ поправит выпадающим
    списком в карточке. Это лучше, чем не проставить тариф вообще."""
    if not is_configured() or kcal_target is None:
        return None
    try:
        resp = requests.get(
            f"{SUPABASE_URL}/rest/v1/subscription_plans",
            headers=_headers(),
            params={
                "select": "plan_id",
                "kcal_target": f"eq.{int(kcal_target)}",
                "is_active": "eq.true",
                "order": "sort_order.asc",
                "limit": "1",
            },
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0]["plan_id"] if rows else None
    except Exception:
        return None


def insert_subscription(row: dict) -> Optional[str]:
    """25.07.2026 — создаёт настоящую строку subscriptions (см.
    supabase_migration_10_subscriptions.sql) при апруве subscription_request
    (см. logic/subscription_apply.py). Требует row["client_id"] — это uuid
    Supabase clients.client_id (см. subscription_requests.supabase_client_id),
    НЕ Telegram-идентичность agent-bot. Возвращает subscription_id или None
    при сбое/не настроенном Supabase — вызывающий код тогда не помечает
    заявку как успешно применённую в этой части (см. subscription_apply.py)."""
    if not is_configured():
        return None
    try:
        resp = requests.post(
            f"{SUPABASE_URL}/rest/v1/subscriptions",
            headers=_headers({"Prefer": "return=representation"}),
            json=row,
            timeout=_TIMEOUT,
        )
        resp.raise_for_status()
        rows = resp.json()
        return rows[0]["subscription_id"] if rows else None
    except Exception:
        return None
