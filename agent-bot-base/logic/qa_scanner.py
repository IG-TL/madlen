"""
26.08.2026 — QA-сканер (Игорь, после разбора dlg-904248388-4: "раз в шесть
часов проверяй, какие есть новые диалоги либо новые сообщения в старых
диалогах... находишь какие-то баги, несостыковки — создаёшь в админке и
шлёшь алерт в Телегу"). Тот же паттерн триггеров, что и logic/sheets_import.py:

    - внешний cron (cron-job.org — Render free tier своего cron не даёт)
      дёргает часто (раз в 15-30 минут, тот же таргет можно переиспользовать
      под несколько ручек) -> GET /cron/qa-scan -> maybe_run_qa_scan() ->
      сверяет, прошло ли SCAN_INTERVAL_HOURS с последнего успешного
      прогона (app_settings) — запускает реальный скан только когда пора.
    - ручная кнопка "Проверить сейчас" в admin-panel -> POST /admin/qa-scan
      -> run_scan("manual") напрямую, в обход интервала.

Курсор (app_settings.qa_scan_last_checked_at) хранит и "докуда уже
проверено", и одновременно служит гейтом "когда последний раз реально
сканировали" — то же значение для обеих целей, отдельного флага не нужно.

Что считается "движухой" в диалоге: ЛЮБОЕ новое сообщение в dialog_messages
после курсора — не важно, в совсем новом диалоге или в старом (Игорь
явно просил не различать эти два случая). get_dialog_ids_with_messages_since
одним запросом покрывает оба.

Ревью каждого диалога — ОТДЕЛЬНЫЙ вызов Claude (см.
claude_real.review_dialog_for_issues), не тот промпт, что отвечает
клиентам — здесь модель выступает QA-ревьюером уже состоявшегося
разговора, с явным списком "что не считать багом" (обычные эскалации),
подобранным по итогам ручного разбора реальных диалогов 26.08.2026.

Единичный сбой (сеть/API) на ОДНОМ диалоге не должен ронять весь скан —
try/except вокруг каждого диалога отдельно; остальные диалоги в этом же
прогоне всё равно проверяются, ошибка просто попадает в qa_scan_runs.error
для видимости.

26.08.2026 (тем же вечером) — первый реальный прогон на Render (7 диалогов)
занял 163 сек: диалоги проверялись ОДИН ЗА ДРУГИМ, каждый — отдельный
сетевой поход в Supabase + отдельный вызов Claude. cron-job.org по
умолчанию ждёт ответа секунд 30 и репортует это как таймаут, хотя скан на
бэкенде спокойно доделывает работу и корректно пишет курсор/qa_scan_runs
(см. app_settings.qa_scan_last_checked_at — обновляется независимо от
того, дождался ли клиент ответа). Решение Игоря (26.08.2026): чинить с
обеих сторон — увеличить таймаут в cron-job.org (конфиг, не код) И
ускорить сам скан здесь — диалоги теперь проверяются ПУЛОМ потоков
(ThreadPoolExecutor), не по одному: каждый вызов и в Supabase, и в Claude
— сетевой I/O, самое время параллелить, GIL этому не мешает (поток спит на
ожидании ответа, не жрёт CPU). Использование Supabase/Claude-клиентов из
нескольких потоков сразу безопасно: supabase_client.py делает отдельный
requests.* вызов на каждую функцию (не шарит один Session), а
anthropic-клиент внутри опирается на httpx.Client, который официально
thread-safe для конкурентных .create().
"""

from __future__ import annotations

import os
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime, timedelta, timezone
from pathlib import Path
from typing import Callable, Optional

sys.path.insert(0, str(Path(__file__).parent.parent))

from integrations import supabase_client  # noqa: E402
from integrations.db_mock import MockDb  # noqa: E402

CURSOR_SETTING_KEY = "qa_scan_last_checked_at"
SCAN_INTERVAL_HOURS = 6

# Сколько сообщений ДО курсора отдаём модели как контекст (см.
# claude_real.review_dialog_for_issues) — достаточно, чтобы понять, о чём
# вообще разговор, не раздувая промпт на весь диалог целиком на каждый
# прогон.
_CONTEXT_MESSAGES = 20

# 26.08.2026 — сколько диалогов проверяем ОДНОВРЕМЕННО (см. докстринг
# модуля про cron-job.org таймаут). 6 — с запасом ниже типичных лимитов
# частоты запросов Anthropic API для одного проекта, при этом на дневном
# объёме Игоря (5-30 диалогов) сокращает время скана в разы: 7 диалогов
# ~163 сек последовательно -> ~2 раунда по ~23 сек параллельно.
_MAX_CONCURRENT_REVIEWS = 6


def _row_to_message(row: dict) -> dict:
    return {"role": row.get("role") or "client", "text": row.get("text") or ""}


def _findings_noun(n: int) -> str:
    """Русское согласование: 1 находка / 2 находки / 5 находок — 21 находка,
    не 21 находок (тот же приём "n % 10 / n % 100", что и
    logic/renewal_reminders._days_noun — прежняя версия сверяла только
    findings_created == 1 буквально, что давало "21 находок")."""
    if n % 10 == 1 and n % 100 != 11:
        return "находка"
    if n % 10 in (2, 3, 4) and n % 100 not in (12, 13, 14):
        return "находки"
    return "находок"


def _notify_qa_findings(
    db: MockDb,
    notify_fn: Callable[[str, str], None],
    findings_created: int,
) -> None:
    """Игорь, п.6 разбора dlg-904248388-4 (тот же принцип, что и алерт о
    полном отказе API в orchestrator._notify_api_outage_alert): отдельный
    пуш, не сама находка целиком — сотрудник читает детали в /qa-findings,
    в Телеграм только сводка + ссылка, чтобы не дублировать содержимое
    диалога в чате. Решение Игоря (26.08.2026): тем же получателям, что и
    обычные эскалации (receives_escalations), не отдельным флагом."""
    recipients = db.get_escalation_recipients()
    if not recipients:
        return
    word = _findings_noun(findings_created)
    text = f"🔎 QA-сканер: {findings_created} {word} за последние сообщения в диалогах."
    base_url = os.environ.get("ADMIN_PANEL_BASE_URL")
    if base_url:
        text += f"\n\nПодробнее: {base_url.rstrip('/')}/qa-findings"
    for staff in recipients:
        try:
            notify_fn(staff["telegram_chat_id"], text)
        except Exception:
            # Сбой пуша одному получателю не должен ронять сам скан — тот
            # же принцип, что и в orchestrator._notify_escalation_recipients.
            pass


def _review_one_dialog(dialog_id: str, since_iso: str, claude_real) -> tuple[list[dict], Optional[str]]:
    """26.08.2026 — тело того, что раньше было одной итерацией цикла в
    run_scan, вынесено в функцию для ThreadPoolExecutor (см. докстринг
    модуля). Ничего не пишет в Supabase сама — возвращает готовые строки
    для qa_findings и, отдельно, текст ошибки (или None) — вставка и подсчёт
    findings_created остаются в вызывающем потоке (run_scan), чтобы не
    гонять список errors/счётчик между потоками руками."""
    try:
        all_messages = supabase_client.get_dialog_messages(dialog_id)
        new_messages = [_row_to_message(m) for m in all_messages if str(m.get("created_at") or "") > since_iso]
        if not new_messages:
            return [], None
        prior_messages = [
            _row_to_message(m) for m in all_messages if str(m.get("created_at") or "") <= since_iso
        ][-_CONTEXT_MESSAGES:]

        dialog_row = supabase_client.get_dialog_by_id(dialog_id) or {}
        client_id = dialog_row.get("client_id") or dialog_id
        client_display_name = dialog_row.get("client_display_name") or client_id

        findings = claude_real.review_dialog_for_issues(dialog_id, prior_messages, new_messages)
        rows = [
            {
                "dialog_id": dialog_id,
                "client_id": client_id,
                "client_display_name": client_display_name,
                "severity": f.get("severity") or "low",
                "category": f.get("category") or "other",
                "summary": f.get("summary") or "",
                "message_excerpt": f.get("message_excerpt"),
            }
            for f in findings
        ]
        return rows, None
    except Exception as exc:
        return [], f"{dialog_id}: {type(exc).__name__}: {exc}"


def run_scan(
    triggered_by: str,
    db: Optional[MockDb] = None,
    notify_fn: Optional[Callable[[str, str], None]] = None,
) -> dict:
    """triggered_by: 'auto' | 'manual'. db/notify_fn — принимаются параметром
    ради тестов (main.py передаёт свои реальные _db/send_fn). Возвращает
    статус-словарь, main.py отдаёт как есть в ответе API."""
    # Локальный импорт — тот же приём, что и у остальных logic/*.py:
    # claude_real тянет anthropic SDK, не нужен каждому импортёру этого
    # модуля транзитивно (напр. тестам, которые мокают claude_real целиком).
    from integrations import claude_real

    db = db or MockDb()
    started_at = datetime.now(timezone.utc)

    cursor_row = supabase_client.get_app_setting(CURSOR_SETTING_KEY)
    since_iso = (cursor_row.get("value") or {}).get("at") if cursor_row else None
    if not since_iso:
        # Первый прогон вообще (настройки ещё нет) — не заваливаем сканер
        # всей историей проекта с самого начала, начинаем так, будто
        # предыдущий прогон был штатно SCAN_INTERVAL_HOURS назад.
        since_iso = (started_at - timedelta(hours=SCAN_INTERVAL_HOURS)).isoformat()

    dialog_ids = supabase_client.get_dialog_ids_with_messages_since(since_iso)

    findings_created = 0
    errors: list[str] = []

    # 26.08.2026 — диалоги проверяются пулом потоков, не по одному (см.
    # докстринг модуля) — единичный сбой на одном диалоге по-прежнему не
    # роняет весь скан: _review_one_dialog сама ловит исключение и
    # возвращает его как текст, ничего не прокидывая дальше через поток.
    if dialog_ids:
        with ThreadPoolExecutor(max_workers=min(_MAX_CONCURRENT_REVIEWS, len(dialog_ids))) as pool:
            futures = [pool.submit(_review_one_dialog, dialog_id, since_iso, claude_real) for dialog_id in dialog_ids]
            for future in as_completed(futures):
                rows, error = future.result()
                for row in rows:
                    supabase_client.insert_qa_finding(row)
                    findings_created += 1
                if error:
                    errors.append(error)

    # Курсор двигаем на started_at (момент НАЧАЛА этого прогона), не
    # finished_at — так безопаснее: сообщение, пришедшее прямо во время
    # скана, попадёт в окно СЛЕДУЮЩЕГО прогона гарантированно, а не рискует
    # проскочить между двумя прогонами. Цена — иногда одно-два сообщения на
    # границе окна проверяются дважды подряд, это дёшево по сравнению с
    # риском пропустить реальную "движуху" в диалоге.
    supabase_client.upsert_app_setting(CURSOR_SETTING_KEY, {"at": started_at.isoformat()}, "system")

    finished_at = datetime.now(timezone.utc)
    supabase_client.insert_qa_scan_run(
        {
            "started_at": started_at.isoformat(),
            "finished_at": finished_at.isoformat(),
            "triggered_by": triggered_by,
            "dialogs_reviewed": len(dialog_ids),
            "findings_created": findings_created,
            "ok": not errors,
            "error": "; ".join(errors) if errors else None,
        }
    )

    if findings_created and notify_fn is not None:
        _notify_qa_findings(db, notify_fn, findings_created)

    return {
        "ok": True,
        "ran": True,
        "dialogs_reviewed": len(dialog_ids),
        "findings_created": findings_created,
        "errors": errors,
    }


def is_scan_due(now: Optional[datetime] = None) -> bool:
    """26.08.2026 — вынесено из maybe_run_qa_scan отдельной дешёвой функцией
    (один короткий GET в app_settings, без самого скана): выяснилось, что
    cron-job.org на бесплатном тарифе НЕ позволяет поднять таймаут запроса
    выше 30 сек (жёсткий лимит платформы, не настройка) — а сам скан, даже
    пулом потоков, на 5-30 диалогах может идти дольше. Поэтому main.py
    (см. /cron/qa-scan) теперь сначала быстро спрашивает "пора ли" через
    эту функцию и отвечает cron-job.org сразу, а сам run_scan (если пора)
    запускает в фоне через FastAPI BackgroundTasks, не дожидаясь его
    завершения. now — только для тестов (иначе datetime.now(timezone.utc))."""
    current = now or datetime.now(timezone.utc)
    cursor_row = supabase_client.get_app_setting(CURSOR_SETTING_KEY)
    last_at_str = (cursor_row.get("value") or {}).get("at") if cursor_row else None
    if not last_at_str:
        return True
    try:
        last_at = datetime.fromisoformat(last_at_str)
    except ValueError:
        return True  # битое значение в настройке — не блокируем скан из-за этого
    return current - last_at >= timedelta(hours=SCAN_INTERVAL_HOURS)


def maybe_run_qa_scan(
    now: Optional[datetime] = None,
    db: Optional[MockDb] = None,
    notify_fn: Optional[Callable[[str, str], None]] = None,
) -> dict:
    """Синхронный путь "проверить и, если пора, сразу отсканировать" —
    используется тестами и любым вызывающим кодом, которому не важна
    задержка ответа (в отличие от /cron/qa-scan в main.py, который из-за
    жёсткого 30-секундного лимита cron-job.org теперь сам вызывает
    is_scan_due()/run_scan() по отдельности через BackgroundTasks, эту
    функцию целиком не использует). Идемпотентно: если с последнего
    успешного скана прошло меньше SCAN_INTERVAL_HOURS — ничего не делает,
    независимо от того, как часто сюда стучатся (тот же приём, что и
    sheets_import.maybe_run_auto_import). now — только для тестов."""
    if not is_scan_due(now):
        return {"ok": True, "ran": False, "reason": "interval_not_reached"}
    return run_scan("auto", db=db, notify_fn=notify_fn)
